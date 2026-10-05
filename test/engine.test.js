import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runSpeedTest } from '../src/engine.js';
import { createTransport, wait } from '../src/transport.js';
import { profiles } from '../src/profiles.js';
import { emptyNetwork, normalizeMetadata, normalizeMeasurementHeaders, METADATA_SOURCE, MEASUREMENT_HEADERS_SOURCE } from '../src/metadata.js';

function fake({ duration = () => 100, delay = 0, sidePings = [10, 20], fail } = {}) {
  const calls = [];
  let closed = false, sideIndex = 0;
  const factory = ({ ledger }) => ({
    async request(options) {
      calls.push(options);
      if (fail) throw fail;
      const reservation = ledger.reserve(options.bytes);
      try {
        await wait(options.during ? 1 : delay, options.signal);
        reservation.add(options.direction, options.bytes);
        const ping = options.during ? sidePings[sideIndex++ % sidePings.length] : options.bytes ? 5 : 15;
        const time = duration(options, calls.filter(c => !c.during).length);
        return { direction: options.direction, requestedBytes: options.bytes, requestStart: 0,
          responseStart: options.direction === 'upload' ? time : ping,
          responseEnd: options.direction === 'upload' ? time : time, server: { colo: 'TST', country: null } };
      } finally { reservation.close(); }
    },
    close() { closed = true; },
  });
  return { factory, calls, get closed() { return closed; } };
}
const step = (phase, bytes, count = 1, bypassMinDuration = false) => ({ phase, bytes, count, bypassMinDuration });

test('quick engine follows exact main schedule, metrics and progress without side overlap on fast rounds', async () => {
  const transport = fake();
  const events = [];
  const result = await runSpeedTest({ profile: 'quick', transportFactory: transport.factory, onProgress: event => events.push(event) });
  assert.deepEqual(transport.calls.filter(c => !c.during).map(c => [c.direction, c.bytes]),
    profiles.quick.flatMap(s => Array.from({ length: s.count }, () => [s.phase === 'latency' ? 'download' : s.phase, s.bytes])));
  assert.deepEqual(result.bytes, { download: 12100000, upload: 6000000 });
  assert.equal(result.latencyMs, 15);
  assert.equal(result.jitterMs, 0);
  assert.equal(result.downloadLoadedLatencyMs, null);
  assert.equal(result.packetLoss, null);
  assert.equal(events.length, 21);
  assert.equal(events.at(-1).completed, events.at(-1).total);
  assert.equal(events.at(-1).downloadMbps, result.downloadMbps);
  assert.equal(events.at(-1).uploadMbps, result.uploadMbps);
  assert.equal(events.at(-1).latencyMs, result.latencyMs);
  assert.equal(events.at(-1).jitterMs, result.jitterMs);
  assert.deepEqual(events.at(-1).server, result.server);
  assert.deepEqual(events.at(-1).network, emptyNetwork());
  assert.ok(events.at(-1).durationMs > 0);
  assert.ok(transport.closed);
});

test('full engine schedules all nominal main bodies when no round finishes a direction', async () => {
  const transport = fake();
  const result = await runSpeedTest({ profile: 'full', transportFactory: transport.factory });
  assert.deepEqual(transport.calls.filter(c => !c.during).map(c => [c.direction, c.bytes]),
    profiles.full.flatMap(s => Array.from({ length: s.count }, () => [s.phase === 'latency' ? 'download' : s.phase, s.bytes])));
  assert.deepEqual(result.bytes, { download: 969000000, upload: 296800000 });
});

test('entire round completes; only same direction stops strictly above1000; warmup bypasses stop', async () => {
  const schedule = [step('download', 10, 2, true), step('download', 20, 2), step('download', 30, 2),
    step('download', 40), step('latency', 0), step('upload', 50), step('latency', 0)];
  const transport = fake({ duration: options => options.bytes === 20 ? 1000 : 1000.001 });
  await runSpeedTest({ transportFactory: transport.factory, _schedule: schedule });
  assert.deepEqual(transport.calls.filter(c => !c.during).map(c => c.bytes), [10,10,20,20,30,30,0,50,0]);
});

test('warmup remains excluded from speed under10ms', async () => {
  const transport = fake({ duration: () => 9.999 });
  const result = await runSpeedTest({ transportFactory: transport.factory, _schedule: [step('download', 100, 1, true)] });
  assert.equal(result.downloadMbps, null);
});

test('side latency starts after delay, serial cadence, size buckets include warmup disqualification', async () => {
  const transport = fake({ delay: 22, sidePings: [10], duration: options => options.bytes === 100 ? 249.999 : 250 });
  const result = await runSpeedTest({ transportFactory: transport.factory, _sideDelayMs: 1, _sideIntervalMs: 3,
    _schedule: [step('download', 100, 1, true), step('download', 100, 1), step('download', 1000, 2), step('upload', 1000, 2)] });
  assert.ok(transport.calls.some(c => c.during === 'download'));
  assert.ok(transport.calls.some(c => c.during === 'upload'));
  assert.equal(result.downloadLoadedLatencyMs, 10);
  assert.equal(result.downloadLoadedJitterMs, 0);
  assert.equal(result.uploadLoadedLatencyMs, 10);
  assert.ok(transport.closed);
});

test('a short warmup disqualifies the same-size bucket even when the later round is eligible', async () => {
  let seen = 0;
  const transport = fake({ delay: 20, sidePings: [10], duration: options => options.bytes && seen++ === 0 ? 249.999 : 250 });
  const result = await runSpeedTest({ transportFactory: transport.factory, _sideDelayMs: 0, _sideIntervalMs: 1,
    _schedule: [step('download', 100, 1, true), step('download', 100)] });
  assert.ok(transport.calls.filter(c => c.during).length >= 2);
  assert.equal(result.downloadLoadedLatencyMs, null);
  assert.equal(result.downloadLoadedJitterMs, null);
});

test('timeout and caller abort close transport and expose actual bodies', async () => {
  for (const kind of ['TIMEOUT', 'ABORTED']) {
    const transport = fake({ delay: 200 });
    const controller = new AbortController();
    const timer = kind === 'ABORTED' ? setTimeout(() => controller.abort(), 5) : null;
    await assert.rejects(runSpeedTest({ transportFactory: transport.factory, timeoutMs: 10, signal: controller.signal,
      _schedule: [step('download', 1000)] }), error => error.code === kind && error.bytes.download === 0);
    clearTimeout(timer);
    assert.ok(transport.closed);
  }
});

test('round abort discards unfinished side sample; completed side probes are serial', async () => {
  let releaseMain;
  const twoProbes = new Promise(resolve => { releaseMain = resolve; });
  let sideCount = 0, active = 0, peak = 0, discarded = false;
  const factory = () => ({
    async request(options) {
      if (!options.during) {
        await twoProbes;
        await wait(10, options.signal);
        return { direction: 'download', requestedBytes: 100, requestStart: 0, responseStart: 5, responseEnd: 250 };
      }
      const index = ++sideCount;
      peak = Math.max(peak, ++active);
      try {
        await wait(index <= 2 ? 1 : 10000, options.signal);
        if (index === 2) releaseMain();
        return { direction: 'download', requestedBytes: 0, requestStart: 0, responseStart: index === 1 ? 10 : 30, responseEnd: 30 };
      } catch (error) { discarded = true; throw error; }
      finally { active--; }
    },
    close() {},
  });
  const result = await runSpeedTest({ transportFactory: factory, _schedule: [step('download', 100)], _sideDelayMs: 0, _sideIntervalMs: 0 });
  assert.equal(sideCount, 3);
  assert.equal(peak, 1);
  assert.ok(discarded);
  assert.equal(result.downloadLoadedLatencyMs, 20);
  assert.equal(result.downloadLoadedJitterMs, 20);
});

test('side calibration cannot modify main calibration carried to the next idle phase', async () => {
  let idleCount = 0;
  const factory = () => ({
    async request(options) {
      if (options.bytes) await wait(30, options.signal);
      if (!options.bytes && !options.during && ++idleCount === 2) {
        return { direction: 'download', requestedBytes: 0, requestStart: 0, responseStart: 50, responseEnd: 50, serverTiming: 'cfReqDur;dur=20' };
      }
      return { direction: 'download', requestedBytes: options.bytes, requestStart: 0, responseStart: 35, responseEnd: 45,
        serverTiming: 'cfReqDur;dur=20', tcpDuration: 5 };
    },
    close() {},
  });
  const result = await runSpeedTest({ transportFactory: factory,
    _schedule: [step('latency', 0), step('download', 100), step('latency', 0)], _sideDelayMs: 0, _sideIntervalMs: 1 });
  assert.equal(result.latencyMs, (7.5 + 20.625) / 2);
  assert.equal(result.downloadMbps, 100 * 1.005 * 8 / 15.625 / 1000);
});

test('budget prevents scheduling, abort before factory, network failure cleanup', async () => {
  const transport = fake();
  await assert.rejects(runSpeedTest({ maxBytes: 99, transportFactory: transport.factory, _schedule: [step('download', 100)] }), { code: 'BYTE_LIMIT' });
  assert.ok(transport.closed);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runSpeedTest({ signal: controller.signal, transportFactory: () => { throw new Error('must not construct'); } }), { code: 'ABORTED' });
  const broken = fake({ fail: new Error('broken') });
  await assert.rejects(runSpeedTest({ transportFactory: broken.factory }), { code: 'NETWORK_ERROR' });
  assert.ok(broken.closed);
});

test('failure exposes explicitly partial completed metrics and actual failed-response body bytes', async () => {
  let closed = false;
  const rejected = Object.assign(new Error('HTTP 403 during download (200 bytes): 0'), {
    code: 'HTTP_ERROR', status: 403, endpoint: 'https://speed.cloudflare.com/__down?bytes=200',
    direction: 'download', requestedBytes: 200, serverMessage: '0', server: { colo: 'ICN', country: null },
  });
  const factory = ({ ledger }) => ({
    async request(options) {
      const reservation = ledger.reserve(options.bytes);
      try {
        if (options.bytes === 200) { reservation.add('download', 1); throw rejected; }
        reservation.add('download', options.bytes);
        return { direction: 'download', requestedBytes: options.bytes, requestStart: 0, responseStart: 15, responseEnd: 100,
          server: { colo: 'TST', country: null } };
      } finally { reservation.close(); }
    },
    close() { closed = true; },
  });
  await assert.rejects(runSpeedTest({ transportFactory: factory, _schedule: [step('latency', 0, 2), step('download', 100), step('download', 200)] }), error => {
    assert.equal(error, rejected);
    assert.deepEqual(error.bytes, { download: 101, upload: 0 });
    assert.equal(error.partialResult.partial, true);
    assert.equal(error.partialResult.downloadMbps, 100 * 1.005 * 8 / 100 / 1000);
    assert.equal(error.partialResult.uploadMbps, null);
    assert.equal(error.partialResult.latencyMs, 15);
    assert.equal(error.partialResult.jitterMs, 0);
    assert.equal(error.partialResult.server.colo, 'ICN');
    assert.deepEqual(error.partialResult.bytes, error.bytes);
    assert.equal(error.partialResult.packetLoss, null);
    assert.deepEqual(error.partialResult.network, emptyNetwork());
    assert.ok(error.partialResult.durationMs >= 0);
    return true;
  });
  assert.ok(closed);
});

test('real in-flight live progress retains completed counts and aggregate metrics until completion', async t => {
  let bodyEnded = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/meta') { res.end(JSON.stringify({ asn: 1234, asOrganization: 'Test Network', country: 'KR', colo: { iata: 'ICN', cca2: 'KR' } })); return; }
    if (req.url.includes('bytes=0')) { res.writeHead(200, { 'cf-ray': 'test-TST' }); res.end(); return; }
    res.writeHead(200, { 'cf-ray': 'test-ICN' }); res.write('00000');
    setTimeout(() => res.write('00000'), 250);
    setTimeout(() => { bodyEnded = true; res.end('00000'); }, 500);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const events = [];
  const result = await runSpeedTest({ transportFactory: options => createTransport({ ...options, testOrigin: `http://127.0.0.1:${server.address().port}` }),
    _schedule: [step('latency', 0), step('download', 15)], onProgress: event => events.push({ ...event, bodyEnded }) });
  const live = events.filter(event => Object.hasOwn(event, 'liveMbps'));
  assert.ok(live.length >= 1);
  assert.ok(live.some(event => !event.bodyEnded));
  assert.ok(live.every(event => event.phase === 'download' && event.liveDirection === 'download' && event.liveMbps > 0 && event.completed === 1 && event.total === 2));
  assert.ok(live.every(event => event.downloadMbps === null && event.uploadMbps === null && event.latencyMs !== null));
  assert.ok(live.some(event => event.server.colo === 'ICN'));
  assert.deepEqual(events.filter(event => !Object.hasOwn(event, 'liveMbps')).map(event => event.completed), [0, 0, 1, 2]);
  assert.ok(events.slice(0, 2).every(event => event.phase === 'metadata'));
  assert.equal(events[1].network.provider, 'Test Network');
  assert.equal(events.at(-1).downloadMbps, result.downloadMbps);
  const count = events.length;
  await wait(250);
  assert.equal(events.length, count);
});

test('onProgress exceptions cause cleanup, preserve partial metrics and propagate without late callbacks', async () => {
  const transport = fake();
  let events = 0;
  await assert.rejects(runSpeedTest({ transportFactory: transport.factory, _schedule: [step('download', 100)],
    onProgress() { events++; throw new Error('progress callback failed'); } }), error => {
    assert.equal(error.message, 'progress callback failed');
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.partialResult.partial, true);
    assert.ok(error.partialResult.downloadMbps > 0);
    return true;
  });
  assert.ok(transport.closed);
  await wait(25);
  assert.equal(events, 1);
});

test('default never schedules denied sizes; full preserves100MB403 without retries or substitution', async () => {
  function denyingTransport() {
    const base = fake();
    const factory = options => {
      const transport = base.factory(options);
      return { ...transport, async request(request) {
        if (request.bytes > 25000000) {
          base.calls.push(request);
          const reservation = options.ledger.reserve(65536); reservation.add('download', 1); reservation.close();
          throw Object.assign(new Error(`HTTP 403 during ${request.direction} (${request.bytes} bytes): 0`), {
            code: 'HTTP_ERROR', status: 403, direction: request.direction, requestedBytes: request.bytes,
            endpoint: `https://speed.cloudflare.com/__down?bytes=${request.bytes}`, serverMessage: '0',
          });
        }
        return transport.request(request);
      } };
    };
    return { base, factory };
  }
  const standard = denyingTransport();
  const result = await runSpeedTest({ transportFactory: standard.factory });
  assert.deepEqual(result.bytes, { download: 169000000, upload: 146800000 });
  assert.ok(standard.base.calls.every(request => request.bytes <= 25000000));
  assert.ok(result.warnings.some(warning => /software request cap.*not a Cloudflare limit.*underestimate/.test(warning)));
  const full = denyingTransport();
  await assert.rejects(runSpeedTest({ profile: 'full', transportFactory: full.factory }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.requestedBytes, 100000000);
    assert.equal(error.partialResult.partial, true);
    assert.equal(error.partialResult.profile, 'full');
    assert.deepEqual(error.bytes, { download: 169000001, upload: 146800000 });
    assert.ok(error.partialResult.downloadMbps > 0 && error.partialResult.uploadMbps > 0);
    return true;
  });
  assert.deepEqual(full.base.calls.filter(request => request.bytes > 25000000).map(request => request.bytes), [100000000]);
  assert.ok(full.base.closed);
});

test('optional metadata precedes timing, counts body but not completed samples, and preserves whitelist on partial failure', async () => {
  const base = fake();
  const body = JSON.stringify({ asn: 1234, asOrganization: 'Example Network', country: 'CA', city: 'Toronto',
    colo: { iata: 'ICN', cca2: 'KR' }, clientIp: '203.0.113.9', latitude: 1 });
  const events = [];
  let metadataCalls = 0;
  const factory = options => ({ ...base.factory(options), async getMetadata() {
    metadataCalls++;
    const reservation = options.ledger.reserve(32768);
    reservation.add('download', Buffer.byteLength(body)); reservation.close();
    return normalizeMetadata(JSON.parse(body));
  } });
  const result = await runSpeedTest({ transportFactory: factory, _schedule: [step('latency', 0, 2), step('download', 100)], onProgress: event => events.push(event) });
  assert.equal(metadataCalls, 1);
  assert.deepEqual(events.map(event => event.completed), [0, 0, 1, 2, 3]);
  assert.deepEqual(events.slice(0, 2).map(event => event.phase), ['metadata', 'metadata']);
  assert.ok(events.slice(0, 2).every(event => event.downloadMbps === null && event.latencyMs === null && !Object.hasOwn(event, 'liveMbps')));
  assert.equal(events[1].network.provider, 'Example Network');
  assert.equal(events[1].network.countryCode, 'CA');
  assert.deepEqual(events[1].server, { colo: 'ICN', country: 'KR' });
  assert.deepEqual(result.server, { colo: 'TST', country: null });
  assert.equal(result.network.countryCode, 'CA');
  assert.equal(result.network.source, METADATA_SOURCE);
  assert.equal(result.downloadMbps, 100 * 1.005 * 8 / 100 / 1000);
  assert.equal(result.latencyMs, 15);
  assert.equal(result.bytes.download, 100 + Buffer.byteLength(body));
  assert.doesNotMatch(JSON.stringify(result.network), /203\.0\.113|clientIp|latitude/);
  const brokenFactory = options => ({ ...factory(options), async request() { throw Object.assign(new Error('HTTP 403'), { code: 'HTTP_ERROR', status: 403 }); } });
  await assert.rejects(runSpeedTest({ transportFactory: brokenFactory, _schedule: [step('download', 100)] }), error => {
    assert.equal(error.partialResult.network.provider, 'Example Network');
    assert.equal(error.partialResult.network.countryCode, 'CA');
    assert.equal(error.partialResult.partial, true);
    return true;
  });
});

test('optional metadata errors and empty shapes are nonfatal with explicit unavailable fields and warning', async () => {
  for (const code of ['HTTP_ERROR', 'METADATA_ERROR', 'METADATA_TIMEOUT', 'BYTE_LIMIT', 'empty']) {
    const base = fake();
    const factory = options => ({ ...base.factory(options), async getMetadata() {
      if (code === 'empty') return normalizeMetadata({ unknown: 'x' });
      throw Object.assign(new Error(code === 'HTTP_ERROR' ? 'Metadata HTTP 404' : code), { code });
    } });
    const result = await runSpeedTest({ transportFactory: factory, _schedule: [step('download', 100)] });
    assert.deepEqual(result.network, emptyNetwork(true));
    assert.ok(result.warnings.some(warning => /\/meta route unavailable/.test(warning)));
    assert.ok(result.downloadMbps > 0);
    assert.ok(base.closed);
  }
});

test('global timeout and caller abort remain terminal during metadata and close transport before timing', async () => {
  for (const code of ['TIMEOUT', 'ABORTED']) {
    const base = fake();
    const controller = new AbortController();
    const factory = options => ({ ...base.factory(options), async getMetadata() { await wait(1000, options.signal); return normalizeMetadata({}); } });
    const timer = code === 'ABORTED' ? setTimeout(() => controller.abort(), 10) : null;
    await assert.rejects(runSpeedTest({ timeoutMs: 20, signal: controller.signal, transportFactory: factory }), error => {
      assert.equal(error.code, code);
      assert.equal(error.partialResult.partial, true);
      assert.deepEqual(error.partialResult.network, emptyNetwork(true));
      return true;
    });
    clearTimeout(timer);
    assert.equal(base.calls.length, 0);
    assert.ok(base.closed);
  }
});

test('/meta403 stays visible while ordinary successful headers populate network, live progress and partial results', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/meta') { res.writeHead(403); res.end('0'); return; }
    if (req.url.includes('bytes=20')) { res.writeHead(403, { asn: '9999' }); res.end('0'); return; }
    res.writeHead(200, { asn: '4766', city: 'Daegu', country: 'KR', colo: 'ICN', 'cf-meta-ip': '203.0.113.9', latitude: '35.8', longitude: '128.6' });
    if (req.url.includes('bytes=0')) { res.end(); return; }
    res.write('00000'); setTimeout(() => res.write('00000'), 250); setTimeout(() => res.end('00000'), 500);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const factory = options => createTransport({ ...options, testOrigin: `http://127.0.0.1:${server.address().port}` });
  const events = [];
  const result = await runSpeedTest({ providerLookup: false, transportFactory: factory, _schedule: [step('latency', 0), step('download', 15)], onProgress: event => events.push(event) });
  assert.equal(result.network.asn, '4766');
  assert.equal(result.network.city, 'Daegu');
  assert.equal(result.network.provider, null);
  assert.equal(result.network.providerSource, null);
  assert.equal(result.network.source, MEASUREMENT_HEADERS_SOURCE);
  assert.deepEqual(result.server, { colo: 'ICN', country: null });
  assert.ok(result.warnings.some(warning => /\/meta route unavailable: Metadata HTTP 403/.test(warning)));
  assert.ok(events.some(event => event.phase === 'latency' && event.network.asn === '4766'));
  const live = events.filter(event => Object.hasOwn(event, 'liveMbps'));
  assert.ok(live.length > 0);
  assert.ok(live.every(event => event.completed === 1 && event.network.asn === '4766' && event.network.provider === null));
  assert.equal(result.bytes.download, 16);
  assert.doesNotMatch(JSON.stringify({ result, events }), /cf-meta-ip|203\.0\.113|latitude|longitude/);
  await assert.rejects(runSpeedTest({ providerLookup: false, transportFactory: factory, _schedule: [step('latency', 0), step('download', 20)] }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.partialResult.partial, true);
    assert.equal(error.partialResult.network.asn, '4766');
    assert.equal(error.partialResult.network.city, 'Daegu');
    assert.equal(error.partialResult.network.source, MEASUREMENT_HEADERS_SOURCE);
    return true;
  });
});

test('header merging preserves richer metadata for the same ASN and clears provider attribution on ASN change', async () => {
  let count = 0;
  const events = [];
  const factory = () => ({
    async getMetadata() { return normalizeMetadata({ asn: 4766, asOrganization: 'Observed Meta Organization', region: 'Observed Region', country: 'KR', colo: { iata: 'ICN', cca2: 'KR' } }); },
    async request() {
      const metadata = normalizeMeasurementHeaders({ asn: ++count === 1 ? '4766' : '4767', city: 'Daegu', country: 'KR', colo: 'ICN' });
      return { direction: 'download', requestedBytes: 0, requestStart: 0, responseStart: 10, responseEnd: 10, ...metadata };
    },
    close() {},
  });
  const result = await runSpeedTest({ transportFactory: factory, _schedule: [step('latency', 0, 2)], onProgress: event => events.push(event) });
  const measurements = events.filter(event => event.phase === 'latency');
  assert.equal(measurements[0].network.asn, '4766');
  assert.equal(measurements[0].network.provider, 'Observed Meta Organization');
  assert.equal(measurements[0].network.providerSource, METADATA_SOURCE);
  assert.equal(measurements[0].network.region, 'Observed Region');
  assert.equal(measurements[0].network.source, MEASUREMENT_HEADERS_SOURCE);
  assert.equal(result.network.asn, '4767');
  assert.equal(result.network.provider, null);
  assert.equal(result.network.providerSource, null);
  assert.equal(result.network.region, 'Observed Region');
  assert.equal(measurements[0].network.provider, 'Observed Meta Organization');
});

test('ASN fallback runs once after the first idle round and exposes truthful provenance without incrementing completed', async () => {
  const base = fake();
  const events = [];
  const calls = [];
  const factory = options => {
    const transport = base.factory(options);
    return { ...transport, async request(request) {
      if (request.bytes && request.onTransfer) request.onTransfer({ mbps: 1,
        network: normalizeMeasurementHeaders({ asn: '4766' }).network });
      const result = await transport.request(request);
      return { ...result, ...normalizeMeasurementHeaders({ asn: '4766', city: 'Daegu', country: 'KR', colo: 'ICN' }) };
    }, async getProvider(asn) {
      calls.push(asn);
      assert.equal(base.calls.length, 2);
      const reservation = options.ledger.reserve(131072); reservation.add('download', 100); reservation.close();
      return { provider: 'REGISTERED-AS-NAME', providerSource: 'https://rdap.apnic.net/autnum/4766' };
    } };
  };
  const result = await runSpeedTest({ transportFactory: factory, _schedule: [step('latency', 0, 2), step('download', 100)], onProgress: event => events.push(event) });
  assert.deepEqual(calls, [4766]);
  assert.deepEqual(events.map(event => event.completed), [1, 2, 2, 2, 2, 3]);
  assert.ok(events.slice(2, 4).every(event => event.phase === 'metadata'));
  assert.equal(events[3].network.provider, 'REGISTERED-AS-NAME');
  assert.equal(events.at(-1).network.providerSource, 'https://rdap.apnic.net/autnum/4766');
  assert.equal(events.find(event => event.liveMbps === 1).network.providerSource, 'https://rdap.apnic.net/autnum/4766');
  assert.equal(result.network.source, MEASUREMENT_HEADERS_SOURCE);
  assert.equal(result.network.providerSource, 'https://rdap.apnic.net/autnum/4766');
  assert.equal(result.bytes.download, 200);
  assert.equal(result.downloadMbps, 100 * 1.005 * 8 / 100 / 1000);
});

test('provider opt-out, absent ASN and existing Cloudflare organization make no registry calls', async () => {
  for (const mode of ['disabled', 'missing', 'known']) {
    const base = fake(); let calls = 0;
    const factory = options => ({ ...base.factory(options),
      async getMetadata() { return normalizeMetadata({ asn: mode === 'missing' ? null : 4766, asOrganization: mode === 'known' ? 'Actual Cloudflare Organization' : null }); },
      async getProvider() { calls++; throw new Error('must not query'); },
    });
    const result = await runSpeedTest({ transportFactory: factory, providerLookup: mode !== 'disabled', _schedule: [step('download', 100)] });
    assert.equal(calls, 0);
    assert.ok(result.downloadMbps > 0);
    assert.equal(result.network.provider, mode === 'known' ? 'Actual Cloudflare Organization' : null);
    if (mode === 'known') assert.equal(result.network.providerSource, METADATA_SOURCE);
  }
});

test('fallback never overlaps main or loaded probes and does not repeat after ASN changes', async () => {
  const base = fake({ delay: 5 });
  let mainActive = 0, sideActive = 0, calls = 0, measurements = 0;
  const factory = options => {
    const transport = base.factory(options);
    return { ...transport, async request(request) {
      if (request.during) sideActive++; else mainActive++;
      try {
        const result = await transport.request(request);
        if (!request.during && request.bytes) {
          measurements++;
          return { ...result, ...normalizeMeasurementHeaders({ asn: measurements <= 2 ? '4766' : '4767' }) };
        }
        return result;
      } finally { if (request.during) sideActive--; else mainActive--; }
    }, async getProvider(asn) {
      calls++;
      assert.equal(asn, 4766);
      assert.equal(mainActive, 0); assert.equal(sideActive, 0);
      return { provider: 'REGISTERED-AS-NAME', providerSource: 'https://rdap.apnic.net/autnum/4766' };
    } };
  };
  const result = await runSpeedTest({ transportFactory: factory, _schedule: [step('download', 100, 2), step('upload', 100)], _sideDelayMs: 0, _sideIntervalMs: 1 });
  assert.ok(base.calls.some(request => request.during));
  assert.equal(calls, 1);
  assert.equal(result.network.asn, '4767');
  assert.equal(result.network.provider, null);
  assert.equal(result.network.providerSource, null);
});

test('provider lookup failure is nonfatal; global timeout or abort during lookup is terminal', async () => {
  for (const mode of ['failure', 'TIMEOUT', 'ABORTED']) {
    const base = fake(); const controller = new AbortController(); let calls = 0;
    const factory = options => ({ ...base.factory(options), async getMetadata() { return normalizeMetadata({ asn: 4766 }); },
      async getProvider() {
        calls++;
        if (mode === 'failure') throw Object.assign(new Error('Registry HTTP 404'), { code: 'PROVIDER_ERROR' });
        await wait(1000, options.signal);
      },
    });
    const timer = mode === 'ABORTED' ? setTimeout(() => controller.abort(), 5) : null;
    const pending = runSpeedTest({ transportFactory: factory, signal: controller.signal, timeoutMs: mode === 'failure' ? 1000 : 15, _schedule: [step('download', 100)] });
    if (mode === 'failure') {
      const result = await pending;
      assert.ok(result.downloadMbps > 0);
      assert.equal(result.network.provider, null);
      assert.ok(result.warnings.some(warning => /ASN registry name unavailable: Registry HTTP 404/.test(warning)));
    } else {
      await assert.rejects(pending, error => {
        assert.equal(error.code, mode);
        assert.equal(error.partialResult.network.provider, null);
        assert.equal(error.partialResult.network.asn, 4766);
        assert.equal(error.partialResult.partial, true);
        return true;
      });
      assert.equal(base.calls.length, 0);
    }
    clearTimeout(timer);
    assert.equal(calls, 1); assert.ok(base.closed);
  }
});

test('resolved registry source survives partial failure and stale ASN result is discarded', async () => {
  const factory = () => ({
    async getMetadata() { return normalizeMetadata({ asn: 4766 }); },
    async getProvider() { return { provider: 'REGISTERED-AS-NAME', providerSource: 'https://krnic.rdap.apnic.net/autnum/4766' }; },
    async request() { throw Object.assign(new Error('HTTP 403'), { code: 'HTTP_ERROR', status: 403 }); }, close() {},
  });
  await assert.rejects(runSpeedTest({ transportFactory: factory, _schedule: [step('download', 100)] }), error => {
    assert.equal(error.partialResult.network.provider, 'REGISTERED-AS-NAME');
    assert.equal(error.partialResult.network.providerSource, 'https://krnic.rdap.apnic.net/autnum/4766');
    return true;
  });
  let emit;
  const staleFactory = () => ({
    async request(options) {
      emit = options.onTransfer;
      return { direction: 'download', requestedBytes: 100, requestStart: 0, responseStart: 10, responseEnd: 100,
        ...normalizeMeasurementHeaders({ asn: '4766' }) };
    },
    async getProvider() {
      // Adversarial test injection: another observation changes ASN while the
      // registry result is outstanding. Production transport has no late emits.
      emit({ mbps: 1, network: normalizeMeasurementHeaders({ asn: '4767' }).network });
      return { provider: 'STALE-NAME', providerSource: 'https://rdap.apnic.net/autnum/4766' };
    }, close() {},
  });
  const result = await runSpeedTest({ transportFactory: staleFactory, _schedule: [step('download', 100)], onProgress() {} });
  assert.equal(result.network.asn, '4767');
  assert.equal(result.network.provider, null);
});
