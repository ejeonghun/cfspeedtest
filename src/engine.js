import { performance } from 'node:perf_hooks';
import { profiles } from './profiles.js';
import { calculateSample, percentile, jitter, speed, loadedMetrics } from './calculations.js';
import { createTransport, createLedger, failure, wait } from './transport.js';
import { emptyNetwork } from './metadata.js';
import { validAsn } from './provider.js';

// Node-only HTTP port, not a browser-engine or live-site equivalence claim.
export async function runSpeedTest({ profile = 'default', timeoutMs = 300000, maxBytes = 1300000000,
  signal, onProgress, providerLookup = true, transportFactory = createTransport, _schedule, _sideDelayMs = 20, _sideIntervalMs = 400 } = {}) {
  if (!Object.hasOwn(profiles, profile)) throw new TypeError('Unknown profile');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a nonnegative safe integer');
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(failure('ABORTED', 'Speed test aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(failure('TIMEOUT', 'Speed test timed out')), timeoutMs);
  const ledger = createLedger(maxBytes);
  const schedule = _schedule ?? profiles[profile];
  const total = schedule.reduce((sum, step) => sum + step.count, 0);
  const samples = { download: [], upload: [] };
  const buckets = { download: new Map(), upload: new Map() };
  const idle = [];
  const finished = new Set();
  let delta = 0, completed = 0, transport;
  let server = { colo: null, country: null };
  let network = emptyNetwork();
  let providerAttempted = false;
  let networkVersion = 0;
  const extraWarnings = profile === 'default' ? ['Default profile uses a conservative 25 MB software request cap, not a Cloudflare limit; it may underestimate very high-speed links.'] : [];
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  const rememberServer = result => {
    if (result.server?.colo != null) {
      if (server.colo !== result.server.colo && result.server.country == null) server.country = null;
      server.colo = result.server.colo;
    }
    if (result.server?.country != null) server.country = result.server.country;
  };
  const rememberNetwork = result => {
    const incoming = result.network;
    if (!incoming || typeof incoming !== 'object') return;
    if (incoming.asn != null && (network.asn == null || Number(incoming.asn) !== Number(network.asn))) {
      networkVersion++;
      network.provider = null;
      network.providerSource = null;
    }
    if (incoming.countryCode != null && incoming.countryCode !== network.countryCode) network.country = null;
    for (const key of Object.keys(emptyNetwork())) if (incoming[key] != null) network[key] = incoming[key];
  };
  const currentStats = () => ({ downloadMbps: speed(samples.download), uploadMbps: speed(samples.upload),
    latencyMs: percentile(idle, 0.5), jitterMs: jitter(idle) });
  const progress = (phase, transfer) => {
    if (!transfer && phase !== 'metadata') completed++;
    check();
    if (transfer) { rememberServer(transfer); rememberNetwork(transfer); }
    onProgress?.({ phase, completed, total, bytes: { ...ledger.bytes }, ...currentStats(), server: { ...server },
      network: { ...network }, durationMs: performance.now() - start,
      ...(transfer ? { liveDirection: phase, liveMbps: Number.isFinite(transfer.mbps) && transfer.mbps > 0 ? transfer.mbps : null } : {}) });
  };
  const makeResult = (partial = false) => {
    const down = loadedMetrics(buckets.download);
    const up = loadedMetrics(buckets.upload);
    return {
      schemaVersion: 1, profile, startedAt, durationMs: performance.now() - start, server: { ...server }, network: { ...network },
      ...currentStats(),
      downloadLoadedLatencyMs: down.latency, downloadLoadedJitterMs: down.jitter,
      uploadLoadedLatencyMs: up.latency, uploadLoadedJitterMs: up.jitter,
      packetLoss: null, packetLossReason: 'Packet loss requires the omitted browser WebRTC/TURN measurement; HTTP cannot measure it.',
      bytes: { ...ledger.bytes },
      measurement: { reference: '@cloudflare/speedtest@1.14.1', transport: 'https-http/1.1' },
      warnings: [
        'Node HTTP library port; not verified equivalent to the live-site profile or browser engine.',
        'Latency is HTTP request latency, not ICMP ping.',
        'Byte limit accounts for HTTP bodies, not total wire traffic.',
        ...extraWarnings,
      ],
      ...(partial ? { partial: true } : {}),
    };
  };
  const maybeProvider = async () => {
    check();
    if (!providerLookup || providerAttempted || typeof transport.getProvider !== 'function' || network.provider || !validAsn(network.asn)) return;
    providerAttempted = true;
    const asn = Number(network.asn);
    const version = networkVersion;
    progress('metadata');
    let result, failed = false;
    try { result = await transport.getProvider(asn); }
    catch (error) { check(); failed = true; extraWarnings.push(`Optional ASN registry name unavailable: ${error.message}`); }
    check();
    if (networkVersion === version && Number(network.asn) === asn && !network.provider && result?.provider && result?.providerSource) {
      network.provider = result.provider;
      network.providerSource = result.providerSource;
    } else if (!failed && !network.provider && !result?.provider) extraWarnings.push('Optional ASN registry name unavailable: no valid registered name.');
    progress('metadata');
  };
  try {
    check();
    transport = transportFactory({ signal: controller.signal, ledger });
    if (typeof transport.getMetadata === 'function') {
      network = emptyNetwork(true);
      progress('metadata');
      let metadata, metadataFailed = false;
      try { metadata = await transport.getMetadata(); }
      catch (error) {
        check();
        metadataFailed = true;
        extraWarnings.push(`Optional /meta route unavailable: ${error.message}`);
      }
      check();
      if (metadata?.network && metadata?.server && typeof metadata.available === 'boolean') {
        rememberNetwork(metadata);
        rememberServer(metadata);
        if (!metadata.available) extraWarnings.push('Optional /meta route unavailable: no recognized fields.');
      } else if (!metadataFailed) extraWarnings.push('Optional /meta route unavailable: no recognized fields.');
      progress('metadata');
    }
    await maybeProvider();
    for (const step of schedule) {
      check();
      if (finished.has(step.phase)) continue;
      if (step.phase === 'latency') {
        for (let i = 0; i < step.count; i++) {
          check();
          const result = await transport.request({ direction: 'download', bytes: 0, signal: controller.signal });
          check();
          rememberServer(result);
          rememberNetwork(result);
          const sample = calculateSample(result, delta);
          delta = sample.nextDelta;
          idle.push(sample.ping);
          progress('latency');
        }
        await maybeProvider();
        continue;
      }
      let bucket = buckets[step.phase].get(step.bytes);
      if (!bucket) { bucket = { durations: [], pings: [] }; buckets[step.phase].set(step.bytes, bucket); }
      const round = new AbortController();
      const abortRound = () => round.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abortRound, { once: true });
      let sideDelta = delta;
      const sideTask = (async () => {
        try {
          await wait(_sideDelayMs, round.signal);
          while (!round.signal.aborted) {
            const result = await transport.request({ direction: 'download', bytes: 0, during: step.phase, signal: round.signal });
            if (round.signal.aborted) break;
            rememberServer(result);
            rememberNetwork(result);
            const sample = calculateSample(result, sideDelta);
            sideDelta = sample.nextDelta;
            bucket.pings.push(sample.ping);
            await wait(_sideIntervalMs, round.signal);
          }
        } catch (error) {
          if (!round.signal.aborted) controller.abort(error);
        }
      })();
      const durations = [];
      try {
        for (let i = 0; i < step.count; i++) {
          check();
          const result = await transport.request({ direction: step.phase, bytes: step.bytes, signal: controller.signal,
            ...(onProgress ? { onTransfer: transfer => progress(step.phase, transfer) } : {}) });
          check();
          rememberServer(result);
          rememberNetwork(result);
          const sample = calculateSample(result, delta);
          delta = sample.nextDelta;
          samples[step.phase].push(sample);
          bucket.durations.push(sample.duration);
          durations.push(sample.duration);
          progress(step.phase);
        }
      } finally {
        round.abort(failure('ABORTED', 'Bandwidth round ended'));
        controller.signal.removeEventListener('abort', abortRound);
        await sideTask;
      }
      check();
      if (!step.bypassMinDuration && Math.min(...durations) > 1000) finished.add(step.phase);
      await maybeProvider();
    }
    check();
    return makeResult();
  } catch (error) {
    controller.abort(error);
    if (!error.code) error.code = 'NETWORK_ERROR';
    rememberServer(error);
    error.bytes = { ...ledger.bytes };
    error.partialResult = makeResult(true);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    transport?.close();
  }
}
