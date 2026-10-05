import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createTransport, createLedger, getRetryDelay, wait } from '../src/transport.js';

async function fixture(t, handler, maxBytes = 10000000) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  const ledger = createLedger(maxBytes);
  const transport = createTransport({ signal: controller.signal, ledger, testOrigin: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => { controller.abort(); transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { transport, ledger, controller, server };
}

test('source-golden Retry-After fallback, Number formats, dates and overflow delay', () => {
  const now = Date.UTC(2026, 0, 1);
  for (const header of [undefined, null, '', 'invalid', 'Infinity', 'NaN']) {
    assert.equal(getRetryDelay(header, now), 5000, String(header));
  }
  for (const [header, delay] of [['0', 0], ['0.01', 10], ['.01', 10], ['1e-2', 10], ['+2', 2000], [' 2 ', 2000], [' ', 0], ['0x10', 16000]]) {
    assert.equal(getRetryDelay(header, now), delay, header);
  }
  assert.equal(getRetryDelay(new Date(now + 10000).toUTCString(), now), 10000);
  assert.equal(getRetryDelay(new Date(now - 10000).toUTCString(), now), 0);
  assert.equal(getRetryDelay('1e308', now), Infinity);
});

test('local streaming download includes delayed headers/body, metadata and reused socket, identity headers', async t => {
  let connection;
  let calls = 0;
  const { transport, ledger } = await fixture(t, (req, res) => {
    assert.equal(req.headers['accept-encoding'], 'identity');
    assert.equal(req.headers['cache-control'], 'no-cache');
    assert.match(req.headers['user-agent'], /cfspeedtest/);
    if (calls++) assert.equal(req.socket, connection);
    connection = req.socket;
    setTimeout(() => {
      res.writeHead(200, { 'content-length': '10', 'cf-ray': 'abcd-XYZ', 'server-timing': 'cfReqDur;dur=2' });
      res.write('00000');
      setTimeout(() => res.end('00000'), 20);
    }, 20);
  });
  const first = await transport.request({ direction: 'download', bytes: 10 });
  assert.ok(first.responseStart - first.requestStart >= 15);
  assert.ok(first.responseEnd - first.responseStart >= 15);
  assert.ok(first.tcpDuration >= 0);
  assert.deepEqual(first.server, { colo: 'XYZ', country: null });
  const second = await transport.request({ direction: 'download', bytes: 10 });
  assert.equal(second.tcpDuration, undefined);
  assert.equal(ledger.bytes.download, 20);
});

test('bounded ASCII uploads honor exact content length and drain with a slow receiver', async t => {
  let received = 0;
  const { transport, ledger } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/__up?bytes=2000000');
    assert.equal(req.headers['content-length'], '2000000');
    assert.equal(req.headers['content-type'], 'text/plain;charset=UTF-8');
    req.on('data', chunk => {
      received += chunk.length;
      assert.ok(chunk.every(byte => byte === 0x30));
      req.pause(); setTimeout(() => req.resume(), 1);
    });
    req.on('end', () => res.end('ok'));
  });
  const result = await transport.request({ direction: 'upload', bytes: 2000000 });
  assert.equal(received, 2000000);
  assert.equal(ledger.bytes.upload, 2000000);
  assert.equal(ledger.bytes.download, 2);
  assert.ok(result.responseStart > result.requestStart);
});

test('side requests overlap on distinct connection while main pool is serial', async t => {
  const sockets = new Map();
  let active = 0, peak = 0;
  const { transport } = await fixture(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    sockets.set(url.searchParams.has('during') ? 'side' : 'main', req.socket);
    peak = Math.max(peak, ++active);
    setTimeout(() => { --active; res.end('0'.repeat(Number(url.searchParams.get('bytes')))); }, 30);
  });
  await Promise.all([
    transport.request({ direction: 'download', bytes: 10 }),
    transport.request({ direction: 'download', bytes: 10 }),
    transport.request({ direction: 'download', bytes: 0, during: 'download' }),
  ]);
  assert.notEqual(sockets.get('main'), sockets.get('side'));
  assert.equal(peak, 2);
});

test('truncated, encoded, short, oversized responses and redirects fail without invented samples', async t => {
  for (const mode of ['truncated', 'short', 'oversized', 'encoded', 'redirect']) {
    await t.test(mode, async t => {
      const { transport, ledger } = await fixture(t, (req, res) => {
        if (mode === 'truncated') { res.writeHead(200, { 'content-length': 10 }); res.write('000'); setTimeout(() => res.destroy(), 5); }
        if (mode === 'short') res.end('000');
        if (mode === 'oversized') res.end('0'.repeat(11));
        if (mode === 'encoded') { res.setHeader('content-encoding', 'gzip'); res.end('0'.repeat(10)); }
        if (mode === 'redirect') { res.writeHead(302, { location: '/__down?bytes=10' }); res.end(); }
      });
      await assert.rejects(transport.request({ direction: 'download', bytes: 10 }), { code: mode === 'oversized' ? 'BYTE_LIMIT' : ['encoded', 'redirect'].includes(mode) ? 'HTTP_ERROR' : 'NETWORK_ERROR' });
      if (mode === 'oversized') assert.equal(ledger.bytes.download, 11);
    });
  }
});

test('early upload response is rejected, and no network upload retry', async t => {
  let calls = 0;
  const { transport } = await fixture(t, (req, res) => { calls++; res.end(); req.pause(); }, 30000000);
  await assert.rejects(transport.request({ direction: 'upload', bytes: 20000000 }), { code: 'NETWORK_ERROR' });
  assert.equal(calls, 1);
});

test('429 bounded retries honor seconds and record retry bodies', async t => {
  let calls = 0;
  const { transport, ledger } = await fixture(t, (req, res) => {
    if (++calls <= 3) { res.writeHead(429, { 'retry-after': '0.01' }); res.end('busy'); }
    else res.end('0'.repeat(10));
  });
  const start = performance.now();
  await transport.request({ direction: 'download', bytes: 10 });
  assert.equal(calls, 4);
  assert.ok(performance.now() - start >= 25);
  assert.equal(ledger.bytes.download, 22);
});

test('429 stops after three retries; date retry waits are abortable', async t => {
  await t.test('bound', async t => {
    let calls = 0;
    const { transport } = await fixture(t, (req, res) => { calls++; res.writeHead(429, { 'retry-after': '0' }); res.end('busy'); });
    await assert.rejects(transport.request({ direction: 'download', bytes: 10 }), error => {
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.status, 429);
      assert.equal(error.retries, 3);
      assert.equal(error.retryExhausted, true);
      assert.match(error.endpoint, /\/__down\?bytes=10$/);
      return true;
    });
    assert.equal(calls, 4);
  });
  await t.test('date abort', async t => {
    const { transport, controller } = await fixture(t, (req, res) => {
      res.writeHead(429, { 'retry-after': new Date(Date.now() + 10000).toUTCString() }); res.end();
      setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 10);
    });
    await assert.rejects(transport.request({ direction: 'download', bytes: 10 }), { code: 'TIMEOUT' });
  });
});

test('missing, invalid and gigantic Retry-After waits abort without shortening or another request', async t => {
  for (const header of [undefined, 'invalid', '1e308']) {
    await t.test(String(header), async t => {
      let calls = 0;
      const { transport, controller, ledger } = await fixture(t, (req, res) => {
        calls++;
        res.writeHead(429, header === undefined ? {} : { 'retry-after': header });
        res.end('busy');
        setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 20);
      });
      await assert.rejects(transport.request({ direction: 'download', bytes: 10 }), { code: 'TIMEOUT' });
      assert.equal(calls, 1);
      assert.equal(ledger.bytes.download, 4);
    });
  }
});

test('early 429 upload can retry, retaining failed upload bytes and replacing its connection', async t => {
  let calls = 0, firstSocket;
  const { transport, ledger } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/__up?bytes=20000000');
    if (++calls === 1) {
      firstSocket = req.socket;
      req.pause();
      res.writeHead(429, { 'retry-after': '0' }); res.end('busy');
    } else {
      assert.notEqual(req.socket, firstSocket);
      req.resume(); req.on('end', () => res.end('ok'));
    }
  }, 50000000);
  await transport.request({ direction: 'upload', bytes: 20000000 });
  assert.equal(calls, 2);
  assert.ok(ledger.bytes.upload > 20000000 && ledger.bytes.upload < 40000000);
  assert.equal(ledger.bytes.download, 6);
});

test('ledger reserves concurrent full requests, retains failed bytes and rejects oversized reply', async t => {
  const ledger = createLedger(100);
  const a = ledger.reserve(80);
  assert.throws(() => ledger.reserve(21), { code: 'BYTE_LIMIT' });
  a.add('upload', 30); a.close();
  const b = ledger.reserve(70); b.add('download', 70); b.close();
  assert.deepEqual(ledger.bytes, { download: 70, upload: 30 });
  assert.throws(() => ledger.reserve(1), { code: 'BYTE_LIMIT' });
  const { transport } = await fixture(t, (req, res) => res.end(), 65545);
  await assert.rejects(transport.request({ direction: 'download', bytes: 10 }), { code: 'BYTE_LIMIT' });
});

test('aborting active main and side cleans agents and scoped socket listeners', async t => {
  const { transport, controller, server } = await fixture(t, () => {});
  const requests = [transport.request({ direction: 'download', bytes: 10 }), transport.request({ direction: 'download', bytes: 0, during: 'upload' })];
  const settled = Promise.allSettled(requests);
  await wait(10);
  controller.abort(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
  assert.ok((await settled).every(r => r.status === 'rejected' && r.reason.code === 'ABORTED'));
  transport.close();
  await wait(10);
  assert.equal(await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count))), 0);
});

test('test-only transport cannot contact arbitrary remote HTTP origins', () => {
  assert.throws(() => createTransport({ ledger: createLedger(1000), testOrigin: 'http://example.com' }), /loopback/);
});

test('HTTP errors retain status, requested identity, bounded sanitized body and server headers without retries', async t => {
  let calls = 0;
  const body = '\x1b[31mForbidden\x1b[0m\n\x00' + 'x'.repeat(5000);
  const { transport, ledger } = await fixture(t, (req, res) => {
    calls++;
    res.writeHead(403, { 'cf-ray': 'abcdef-ICN', 'server-timing': 'cfSpeedEdge;dur=2' });
    res.end(body);
  });
  await assert.rejects(transport.request({ direction: 'download', bytes: 1000000 }), error => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 403);
    assert.match(error.endpoint, /\/__down\?bytes=1000000$/);
    assert.equal(error.direction, 'download');
    assert.equal(error.requestedBytes, 1000000);
    assert.equal(error.retries, 0);
    assert.equal(error.retryExhausted, false);
    assert.equal(error.server.colo, 'ICN');
    assert.equal(error.responseHeaders.cfRay, 'abcdef-ICN');
    assert.equal(error.responseHeaders.serverTiming, 'cfSpeedEdge;dur=2');
    assert.ok(error.serverMessage.length <= 200);
    assert.ok(error.responseBody.length <= 4096);
    assert.ok(error.bodyTruncated);
    assert.doesNotMatch(error.responseBody, /[\x00-\x1f\x7f]/);
    assert.match(error.message, /HTTP 403 during download \(1000000 bytes\): Forbidden/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(ledger.bytes.download, Buffer.byteLength(body));
});

test('download live BODY averages arrive before completion, are throttled and never leak to side/latency', async t => {
  let mainEnded = false;
  const { transport } = await fixture(t, (req, res) => {
    if (req.url.includes('bytes=0')) { res.end(); return; }
    res.writeHead(200, { 'cf-ray': 'test-TST' }); res.write('00000');
    setTimeout(() => res.write('00000'), 250);
    setTimeout(() => { mainEnded = true; res.end('00000'); }, 500);
  });
  const events = [];
  const onTransfer = event => events.push({ ...event, mainEnded });
  await Promise.all([
    transport.request({ direction: 'download', bytes: 15, onTransfer }),
    transport.request({ direction: 'download', bytes: 0, during: 'download', onTransfer }),
  ]);
  await transport.request({ direction: 'download', bytes: 0, onTransfer });
  assert.ok(events.some(event => !event.mainEnded));
  assert.ok(events.every(event => event.direction === 'download' && event.mbps > 0 && event.durationMs >= 100));
  assert.equal(events.at(-1).bytes, 15);
  assert.equal(events[0].server.colo, 'TST');
  for (let i = 1; i < events.length - 1; i++) assert.ok(events[i].durationMs - events[i - 1].durationMs >= 190);
  const count = events.length;
  await wait(250);
  assert.equal(events.length, count);
});

test('a rejected upload retains its HTTP diagnostics and never retries or emits known-error body speed', async t => {
  let calls = 0, callbacks = 0;
  const { transport, ledger } = await fixture(t, (req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      res.writeHead(400); res.write('bad');
      setTimeout(() => res.end(' request'), 250);
    });
  });
  await assert.rejects(transport.request({ direction: 'upload', bytes: 10, onTransfer() { callbacks++; } }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.direction, 'upload');
    assert.equal(error.requestedBytes, 10);
    assert.match(error.endpoint, /\/__up\?bytes=10$/);
    assert.equal(error.serverMessage, 'bad request');
    assert.equal(error.retryExhausted, false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(callbacks, 0);
  assert.deepEqual(ledger.bytes, { download: 11, upload: 10 });
});

test('upload live BODY averages wait for stable elapsed time and respect a paused receiver', async t => {
  let ended = false;
  const { transport, ledger } = await fixture(t, (req, res) => {
    req.pause(); setTimeout(() => req.resume(), 400);
    req.on('data', () => {});
    req.on('end', () => { ended = true; res.end('ok'); });
  }, 30000000);
  const events = [];
  await transport.request({ direction: 'upload', bytes: 20000000, onTransfer: event => events.push({ ...event, ended }) });
  assert.ok(events.some(event => !event.ended));
  assert.ok(events.every(event => event.durationMs >= 100 && Number.isFinite(event.mbps) && event.mbps > 0));
  assert.equal(events.at(-1).bytes, 20000000);
  assert.equal(ledger.bytes.upload, 20000000);
});

test('live callback exceptions and caller abort stop callbacks and clean active requests', async t => {
  for (const mode of ['throw', 'abort']) await t.test(mode, async t => {
    const { transport, controller } = await fixture(t, (req, res) => { res.writeHead(200); res.write('00000'); });
    let callbacks = 0;
    const error = Object.assign(new Error(mode), { code: mode === 'abort' ? 'ABORTED' : 'CALLBACK_ERROR' });
    await assert.rejects(transport.request({ direction: 'download', bytes: 10, onTransfer() {
      callbacks++;
      if (mode === 'abort') controller.abort(error); else throw error;
    } }), error);
    assert.equal(callbacks, 1);
    await wait(250);
    assert.equal(callbacks, 1);
  });
});

test('successful measurement results and live callbacks contain only whitelisted client headers and correct edge', async t => {
  const { transport } = await fixture(t, (req, res) => {
    if (req.url.startsWith('/__up')) { res.setHeader('cf-meta-colo', 'ICN'); req.resume(); req.on('end', () => res.end()); return; }
    res.writeHead(200, { asn: '4766', city: 'Daegu', country: 'KR', colo: 'ICN', 'cf-ray': 'abc-ICN', 'cf-ipcountry': 'KR',
      'cf-meta-ip': '203.0.113.9', latitude: '35.8', longitude: '128.6', postalcode: '12345', timezone: 'Asia/Seoul' });
    res.write('00000'); setTimeout(() => res.write('00000'), 250); setTimeout(() => res.end('00000'), 500);
  });
  const live = [];
  const result = await transport.request({ direction: 'download', bytes: 15, onTransfer: event => live.push(event) });
  assert.equal(result.network.asn, '4766');
  assert.equal(result.network.city, 'Daegu');
  assert.equal(result.network.countryCode, 'KR');
  assert.equal(result.network.provider, null);
  assert.equal(result.network.providerSource, null);
  assert.equal(result.network.source, 'https://speed.cloudflare.com/__down (response headers)');
  assert.deepEqual(result.server, { colo: 'ICN', country: null });
  assert.ok(live.length > 0);
  assert.ok(live.every(event => event.network.asn === '4766' && event.server.country === null));
  assert.doesNotMatch(JSON.stringify({ result, live }), /cf-meta-ip|203\.0\.113|latitude|longitude|postalcode|timezone/);
  const upload = await transport.request({ direction: 'upload', bytes: 0 });
  assert.deepEqual(upload.server, { colo: 'ICN', country: null });
  assert.equal(upload.network, undefined);
});
