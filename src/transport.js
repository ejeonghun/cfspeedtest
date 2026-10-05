import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fetchMetadata, normalizeMeasurementHeaders } from './metadata.js';
import { lookupProvider } from './provider.js';

const REPLY_LIMIT = 65536;
const UPLOAD_CHUNK = Buffer.alloc(65536, 0x30);
const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const USER_AGENT = `${packageInfo.name}/${packageInfo.version} (Node.js ${process.version}; HTTP/1.1)`;
function sanitizeBody(body, limit) {
  return body.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function httpError(result, { retries = 0, retryExhausted = false, message } = {}) {
  const serverMessage = sanitizeBody(result.responseBody ?? '', 200);
  return Object.assign(failure('HTTP_ERROR', `${message ?? `HTTP ${result.status}`} during ${result.direction} (${result.requestedBytes} bytes)${serverMessage ? `: ${serverMessage}` : ''}`), {
    status: result.status, endpoint: result.endpoint, direction: result.direction, requestedBytes: result.requestedBytes,
    serverMessage, responseBody: sanitizeBody(result.responseBody ?? '', 4096), bodyTruncated: result.bodyTruncated ?? false,
    retries, retryExhausted, server: result.server, responseHeaders: result.responseHeaders,
  });
}
export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// getRetryDelay semantics from @cloudflare/speedtest 1.14.1 BandwidthEngine
// (upstream commit 323da2ea5697ab4953f2c90c931125ac35d019d8).
export function getRetryDelay(header, now = Date.now()) {
  if (!header) return 5000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 5000;
}

export async function wait(ms, signal) {
  // Node clamps overflowing timer delays to 1ms; never shorten Retry-After.
  while (ms > 2147483647) {
    await wait(2147483647, signal);
    ms -= 2147483647;
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? failure('ABORTED', 'Aborted'));
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? failure('ABORTED', 'Aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createLedger(maxBytes) {
  let reserved = 0;
  const bytes = { download: 0, upload: 0 };
  return {
    bytes,
    reserve(amount) {
      if (bytes.download + bytes.upload + reserved + amount > maxBytes) throw failure('BYTE_LIMIT', 'HTTP body budget would be exceeded');
      reserved += amount;
      let remaining = amount;
      return {
        add(direction, count) {
          const covered = Math.min(count, remaining);
          remaining -= covered;
          reserved -= covered;
          bytes[direction] += count;
          if (covered !== count) throw failure('BYTE_LIMIT', 'Response exceeds reserved HTTP body budget');
        },
        close() { reserved -= remaining; remaining = 0; },
      };
    },
  };
}

export function createTransport({ signal, ledger, testOrigin, userAgent = USER_AGENT, _metadataTimeoutMs = 5000,
  _providerTimeoutMs = 5000, _providerRequestFactory } = {}) {
  const origin = new URL(testOrigin ?? 'https://speed.cloudflare.com');
  if (testOrigin && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) {
    throw new TypeError('Test origin must be loopback HTTP');
  }
  const client = origin.protocol === 'http:' ? http : https;
  const agents = [0, 1].map(() => new client.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }));
  const providerAgent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const destroy = () => { agents.forEach(agent => agent.destroy()); providerAgent.destroy(); };
  signal?.addEventListener('abort', destroy, { once: true });

  async function attempt({ direction, bytes: requestedBytes, during, onTransfer, signal: requestSignal = signal }) {
    if (requestSignal?.aborted) throw requestSignal.reason ?? failure('ABORTED', 'Aborted');
    const reservation = ledger.reserve(requestedBytes + REPLY_LIMIT);
    try {
      return await new Promise((resolve, reject) => {
        const url = new URL(direction === 'upload' ? '/__up' : '/__down', origin);
        url.searchParams.set('bytes', String(requestedBytes));
        if (during) url.searchParams.set('during', during);
        let socket, requestStart, responseStart, responseEnd, tcpDuration;
        let uploaded = 0, downloaded = 0, settled = false, response;
        let transferTimer, lastTransferAt = 0, lastTransferBytes = 0;
        let responseServer, responseNetwork;
        const req = client.request(url, {
          method: direction === 'upload' ? 'POST' : 'GET', agent: agents[during ? 1 : 0],
          headers: { 'user-agent': userAgent, 'accept-encoding': 'identity', 'cache-control': 'no-cache',
            ...(direction === 'upload' ? { 'content-length': requestedBytes, 'content-type': 'text/plain;charset=UTF-8' } : {}) },
        });
        const onData = () => { const now = performance.now(); responseStart ??= now; responseEnd = now; };
        const cleanup = () => {
          clearInterval(transferTimer);
          requestSignal?.removeEventListener('abort', abort);
          socket?.removeListener('data', onData);
          socket?.removeListener('lookup', lookup);
          socket?.removeListener('connect', connected);
          socket?.removeListener('secureConnect', begin);
          req.removeListener('drain', writeUpload);
        };
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) { response?.destroy(); req.destroy(); reject(error); } else resolve(value);
        };
        const abort = () => finish(requestSignal.reason ?? failure('ABORTED', 'Aborted'));
        const notifyTransfer = (final = false) => {
          if (settled || requestSignal?.aborted || !onTransfer || during || !requestedBytes || requestStart === undefined) return;
          if (response && (response.statusCode < 200 || response.statusCode >= 300)) return;
          const elapsed = performance.now() - requestStart;
          const transferred = direction === 'upload' ? uploaded : downloaded;
          // Provisional BODY average, not the authoritative upstream aggregate.
          // Do not turn the initially queued upload buffer into an infinite rate.
          if (elapsed < 100 || !transferred || (!final && (elapsed - lastTransferAt < 200 || transferred === lastTransferBytes))) return;
          lastTransferAt = elapsed;
          lastTransferBytes = transferred;
          onTransfer({ direction, bytes: transferred, durationMs: elapsed, mbps: transferred * 8 / elapsed / 1000,
            ...(responseServer ? { server: responseServer } : {}), ...(responseNetwork ? { network: responseNetwork } : {}) });
        };
        let connectionStart;
        const lookup = () => { connectionStart = performance.now(); };
        const connected = () => {
          if (connectionStart !== undefined) tcpDuration = performance.now() - connectionStart;
          if (client === http) begin();
        };
        function writeUpload() {
          try {
            while (uploaded < requestedBytes && !settled) {
              const chunk = UPLOAD_CHUNK.subarray(0, Math.min(UPLOAD_CHUNK.length, requestedBytes - uploaded));
              reservation.add('upload', chunk.length);
              uploaded += chunk.length;
              if (!req.write(chunk)) { req.once('drain', writeUpload); return; }
            }
            if (!settled) req.end();
          } catch (error) { finish(error); }
        }
        function begin() {
          if (settled || requestStart !== undefined) return;
          socket.prependListener('data', onData);
          requestStart = performance.now();
          if (onTransfer && !during && requestedBytes > 0) transferTimer = setInterval(() => {
            try { notifyTransfer(); } catch (error) { finish(error); }
          }, 200);
          req.flushHeaders();
          if (direction === 'upload') writeUpload(); else req.end();
        }
        req.on('socket', assigned => {
          socket = assigned;
          if (!socket.connecting && (client === http || socket.encrypted && socket._secureEstablished)) begin();
          else {
            // Literal IPs have no DNS lookup; their connection interval is known.
            if (/^[\d.]+$/.test(origin.hostname) || origin.hostname.startsWith('[')) connectionStart = performance.now();
            socket.once('lookup', lookup);
            socket.once('connect', connected);
            if (client === https) socket.once('secureConnect', begin);
          }
        });
        req.on('error', error => finish(failure('NETWORK_ERROR', error.message)));
        req.on('finish', () => {
          if (direction === 'upload') {
            try { notifyTransfer(true); } catch (error) { finish(error); }
          }
        });
        req.on('response', incoming => {
          response = incoming;
          const successful = incoming.statusCode >= 200 && incoming.statusCode < 300;
          const uploadCompleteAtResponse = uploaded === requestedBytes && req.writableFinished;
          const metadata = normalizeMeasurementHeaders(incoming.headers, direction);
          responseServer = metadata.server;
          if (successful && metadata.network.source) responseNetwork = metadata.network;
          const errorChunks = [];
          let errorBodyBytes = 0, bodyTruncated = false;
          const result = () => ({ direction, requestedBytes, endpoint: url.href, requestStart, responseStart, responseEnd, tcpDuration,
            status: incoming.statusCode, retryAfter: incoming.headers['retry-after'], serverTiming: incoming.headers['server-timing'],
            server: responseServer, ...(responseNetwork ? { network: responseNetwork } : {}), responseBody: Buffer.concat(errorChunks).toString('utf8'), bodyTruncated,
            responseHeaders: { cfRay: incoming.headers['cf-ray'] ?? null, serverTiming: incoming.headers['server-timing'] ?? null, retryAfter: incoming.headers['retry-after'] ?? null } });
          incoming.on('data', chunk => {
            try {
              reservation.add('download', chunk.length);
              downloaded += chunk.length;
              const limit = direction === 'upload' || !successful ? REPLY_LIMIT : requestedBytes;
              if (!successful) {
                const remaining = 4096 - errorBodyBytes;
                if (remaining > 0) { errorChunks.push(Buffer.from(chunk.subarray(0, remaining))); errorBodyBytes += Math.min(chunk.length, remaining); }
                if (chunk.length > remaining) bodyTruncated = true;
              }
              if (downloaded > limit) throw failure('BYTE_LIMIT', 'Oversized HTTP response');
            } catch (error) { finish(error); }
          });
          incoming.on('aborted', () => finish(failure('NETWORK_ERROR', 'Truncated HTTP response')));
          incoming.on('error', error => finish(failure('NETWORK_ERROR', error.message)));
          incoming.on('end', () => {
            if (!incoming.complete) return finish(failure('NETWORK_ERROR', 'Incomplete HTTP response'));
            if (successful && incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') return finish(httpError(result(), { message: `HTTP ${incoming.statusCode}: encoded HTTP response` }));
            if (successful && direction !== 'upload' && downloaded !== requestedBytes) return finish(failure('NETWORK_ERROR', 'Download byte count mismatch'));
            if (successful && direction === 'upload' && !uploadCompleteAtResponse) return finish(failure('NETWORK_ERROR', 'Upload response arrived before complete upload'));
            // A rejected upload may arrive early (notably 429). Never reuse its
            // connection with an unfinished declared request body.
            if (!successful && direction === 'upload' && !req.writableFinished) req.destroy();
            try {
              if (successful) notifyTransfer(true);
              finish(null, result());
            } catch (error) { finish(error); }
          });
        });
        requestSignal?.addEventListener('abort', abort, { once: true });
        if (requestSignal?.aborted) abort();
      });
    } finally { reservation.close(); }
  }

  return {
    getProvider(asn) {
      return lookupProvider(asn, { client: https, agent: providerAgent, ledger, signal, headers: { 'user-agent': userAgent },
        timeoutMs: _providerTimeoutMs, requestFactory: _providerRequestFactory });
    },
    getMetadata() {
      return fetchMetadata({ client, agent: agents[0], origin, ledger, signal, timeoutMs: _metadataTimeoutMs,
        headers: { 'user-agent': userAgent, 'accept-encoding': 'identity', 'cache-control': 'no-cache' } });
    },
    async request(options) {
      for (let retry = 0; ; retry++) {
        const result = await attempt(options);
        if (result.status >= 200 && result.status < 300) return result;
        if (result.status !== 429 || retry >= 3) throw httpError(result, { retries: retry, retryExhausted: result.status === 429 && retry >= 3 });
        await wait(getRetryDelay(result.retryAfter), options.signal ?? signal);
      }
    },
    close() { signal?.removeEventListener('abort', destroy); destroy(); },
  };
}
