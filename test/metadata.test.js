import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createTransport, createLedger, wait } from '../src/transport.js';
import { normalizeMetadata, normalizeMeasurementHeaders, emptyNetwork, METADATA_SOURCE, METADATA_LIMIT, MEASUREMENT_HEADERS_SOURCE } from '../src/metadata.js';

async function local(t, handler, { maxBytes = 1000000, timeoutMs = 5000 } = {}) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const controller = new AbortController();
  const ledger = createLedger(maxBytes);
  const transport = createTransport({ ledger, signal: controller.signal, testOrigin: `http://127.0.0.1:${server.address().port}`, _metadataTimeoutMs: timeoutMs });
  t.after(async () => { controller.abort(); transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { transport, ledger, controller, server };
}

test('metadata whitelist separates client country from edge, accepts ASN types and retains no IP/coordinates', () => {
  const result = normalizeMetadata({ asn: 1234, asOrganization: ' Test Network ', city: 'Seoul', region: 'Seoul Region', country: 'kr',
    colo: { iata: 'nrt', cca2: 'jp' }, clientIp: '203.0.113.9', latitude: 37.5, longitude: 127, unknown: 'private' });
  assert.deepEqual(result, { available: true, server: { colo: 'NRT', country: 'JP' }, network: {
    asn: 1234, provider: 'Test Network', providerSource: METADATA_SOURCE, city: 'Seoul', region: 'Seoul Region', country: 'South Korea', countryCode: 'KR', source: METADATA_SOURCE,
  } });
  assert.equal(normalizeMetadata({ asn: '1234' }).network.asn, '1234');
  assert.doesNotMatch(JSON.stringify(result), /clientIp|203\.0\.113|latitude|longitude|private/);
});

test('observed measurement headers expose only ASN/city/client country/edge and never infer edge country', () => {
  const result = normalizeMeasurementHeaders({ asn: '4766', city: 'Daegu', country: 'KR', colo: 'ICN',
    'cf-meta-ip': '203.0.113.9', latitude: '35.8', longitude: '128.6', postalcode: '12345', timezone: 'Asia/Seoul', unknown: 'private' });
  assert.deepEqual(result, { available: true, server: { colo: 'ICN', country: null }, network: {
    asn: '4766', provider: null, providerSource: null, city: 'Daegu', region: null, country: 'South Korea', countryCode: 'KR', source: MEASUREMENT_HEADERS_SOURCE,
  } });
  assert.doesNotMatch(JSON.stringify(result), /cf-meta-ip|203\.0\.113|latitude|longitude|postalcode|timezone|private/);
  assert.deepEqual(normalizeMeasurementHeaders({ 'cf-meta-colo': 'ICN' }, 'upload'), {
    available: true, server: { colo: 'ICN', country: null }, network: emptyNetwork(),
  });
  const rich = normalizeMeasurementHeaders({ asn: '4766', asorganization: 'Observed Organization', region: 'Observed Region', country: 'KR', 'cf-ray': 'abc-NRT', colo: 'ICN', 'cf-ipcountry': 'KR' }, 'upload');
  assert.equal(rich.network.provider, 'Observed Organization');
  assert.equal(rich.network.providerSource, 'https://speed.cloudflare.com/__up (response headers)');
  assert.equal(rich.network.region, 'Observed Region');
  assert.deepEqual(rich.server, { colo: 'NRT', country: null });
  assert.equal(normalizeMeasurementHeaders({ asn: 'bad', city: {}, country: 'Korea', colo: 'ICNN', asorganization: 'x'.repeat(161) }).available, false);
});

test('missing, unexpected and invalid field types become null without inventing metadata', () => {
  for (const value of [null, [], 3, 'text', {}, { clientIp: '203.0.113.9' }]) {
    assert.deepEqual(normalizeMetadata(value), { network: emptyNetwork(true), server: { colo: null, country: null }, available: false });
  }
  for (const asn of [-1, 0, Infinity, 1.5, 4294967296, {}, 'AS1234', '1.5']) assert.equal(normalizeMetadata({ asn }).network.asn, null);
  const result = normalizeMetadata({ asn: true, asOrganization: 'a'.repeat(161), city: {}, region: ['x'], country: 'Korea', colo: { iata: 'ICNN', cca2: 12 } });
  assert.deepEqual(result.network, emptyNetwork(true));
  assert.equal(result.available, false);
});

test('fixed /meta accepts text/plain JSON and counts its body without implicit requests at construction', async t => {
  let calls = 0;
  const body = JSON.stringify({ asn: 1234, asOrganization: 'Example Network', country: 'KR', colo: { iata: 'ICN', cca2: 'KR' } });
  const { transport, ledger } = await local(t, (req, res) => {
    calls++;
    assert.equal(req.url, '/meta');
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['accept-encoding'], 'identity');
    assert.match(req.headers['user-agent'], /cfspeedtest/);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'text/plain'); res.end(body);
  });
  assert.equal(calls, 0);
  const metadata = await transport.getMetadata();
  assert.equal(metadata.network.provider, 'Example Network');
  assert.equal(metadata.server.colo, 'ICN');
  assert.equal(calls, 1);
  assert.deepEqual(ledger.bytes, { download: Buffer.byteLength(body), upload: 0 });
});

test('metadata never redirects or retries HTTP403/404/429 and rejects malformed/truncated/encoded JSON', async t => {
  for (const mode of [403, 404, 429, 302, 'json', 'truncated', 'encoded']) await t.test(String(mode), async t => {
    let calls = 0;
    const { transport, ledger } = await local(t, (req, res) => {
      calls++;
      if (typeof mode === 'number') { res.writeHead(mode, { location: '/meta', 'retry-after': '0' }); res.end('0'); }
      if (mode === 'json') res.end('not JSON');
      if (mode === 'truncated') { res.writeHead(200, { 'content-length': 50 }); res.write('{}'); setTimeout(() => res.destroy(), 5); }
      if (mode === 'encoded') { res.setHeader('content-encoding', 'gzip'); res.end('{}'); }
    });
    await assert.rejects(transport.getMetadata(), { code: typeof mode === 'number' || mode === 'encoded' ? 'HTTP_ERROR' : mode === 'json' ? 'METADATA_ERROR' : 'NETWORK_ERROR' });
    assert.equal(calls, 1);
    assert.ok(ledger.bytes.download > 0);
  });
});

test('metadata reserves32KiB before requests and aborts oversized response without unchecked buffering', async t => {
  let calls = 0;
  const denied = await local(t, (req, res) => { calls++; res.end('{}'); }, { maxBytes: METADATA_LIMIT - 1 });
  await assert.rejects(denied.transport.getMetadata(), { code: 'BYTE_LIMIT' });
  assert.equal(calls, 0);
  assert.equal(denied.ledger.bytes.download, 0);
  const oversized = await local(t, (req, res) => res.end('x'.repeat(50000)));
  await assert.rejects(oversized.transport.getMetadata(), { code: 'BYTE_LIMIT' });
  assert.ok(oversized.ledger.bytes.download > METADATA_LIMIT && oversized.ledger.bytes.download <= 50000);
  const reservation = oversized.ledger.reserve(900000); reservation.close();
});

test('metadata deadline and global abort close sockets and release reservations', async t => {
  for (const mode of ['deadline', 'abort']) await t.test(mode, async t => {
    const { transport, ledger, controller, server } = await local(t, () => {}, { timeoutMs: mode === 'deadline' ? 15 : 5000 });
    const pending = transport.getMetadata();
    if (mode === 'abort') setTimeout(() => controller.abort(Object.assign(new Error('global timeout'), { code: 'TIMEOUT' })), 15);
    await assert.rejects(pending, { code: mode === 'deadline' ? 'METADATA_TIMEOUT' : 'TIMEOUT' });
    await wait(15);
    assert.equal(await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count))), 0);
    const reservation = ledger.reserve(1000000); reservation.close();
    assert.equal(ledger.bytes.download, 0);
  });
});
