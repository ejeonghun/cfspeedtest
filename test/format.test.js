import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, fitLine, formatBytes, formatResult, networkFields, number, payloadTotal, textWidth, useColor } from '../src/format.js';

test('null is unavailable, actual zero remains zero, and missing payload is not invented', () => {
  assert.equal(number(null, 'Mbps'), 'unavailable');
  assert.equal(number(0, 'Mbps'), '0.00 Mbps');
  assert.equal(number(NaN, 'ms'), 'unavailable');
  assert.equal(payloadTotal({ download: 1000 }), 'unavailable');
  assert.equal(payloadTotal({ download: 0, upload: 0 }), '0 B');
  assert.equal(formatBytes(18100000), '18.10 MB');
  const result = formatResult({ downloadMbps: 0, uploadMbps: null, durationMs: null });
  assert.match(result, /0\.00 Mbps/);
  assert.match(result, /Upload\s+unavailable/);
  assert.match(formatResult({ durationMs: null }, { verbose: true }), /Elapsed\s+unavailable/);
});

test('network fields are truthful, gradually available, and safe for the terminal', () => {
  assert.deepEqual(networkFields(null), { asn: 'unavailable', provider: 'unavailable', location: 'unavailable' });
  assert.deepEqual(networkFields({ asn: 'AS123', provider: 'Example', countryCode: 'US' }), { asn: 'AS123', provider: 'Example', location: 'US' });
  assert.equal(networkFields({ asn: 0 }).asn, 'AS0');
  assert.equal(networkFields({ city: 'City', region: 'Region', country: 'Country' }).location, 'City, Region, Country');
  assert.ok(!cleanText('\u001b[2J\r\nBad\u202e').includes('\u001b'));
  assert.ok(!formatResult({ server: { colo: '\u001b[2J' }, network: { provider: '\u001b[31mBad' } }).includes('\u001b'));
});

test('width clipping respects wide and combining characters and has no cursor escapes', () => {
  assert.equal(textWidth('abc'), 3);
  assert.equal(textWidth('東京'), 4);
  assert.equal(textWidth('e\u0301'), 1);
  for (const width of [1, 20, 59, 79]) assert.ok(textWidth(fitLine('東京 '.repeat(40), width)) <= width);
});

test('color always is still TTY-only and environment overrides all modes', () => {
  assert.equal(useColor({ isTTY: false }, 'always', {}), false);
  assert.equal(useColor({ isTTY: true }, 'auto', {}), true);
  assert.equal(useColor({ isTTY: true }, 'always', { NO_COLOR: '' }), false);
  assert.equal(useColor({ isTTY: true }, 'always', { TERM: 'dumb' }), false);
});

test('default summary is eight essential rows without profiles, usage or disclaimers', () => {
  const result = {
    profile: 'quick', downloadMbps: 125, uploadMbps: 20, latencyMs: 10, jitterMs: 1,
    server: { colo: 'SJC', country: 'US' },
    network: { asn: 123, provider: 'Example Registry', city: 'City', country: 'US' },
    downloadLoadedLatencyMs: null, bytes: { download: 1000, upload: 500 }, durationMs: 2000,
  };
  const before = structuredClone(result);
  const output = formatResult(result);
  assert.equal(output.trimEnd().split('\n').length, 8);
  for (const pattern of [/Download\s+125\.00 Mbps/, /Upload\s+20\.00 Mbps/,
    /Ping \(HTTP\)\s+10\.00 ms \| Jitter 1\.00 ms/, /Server\s+SJC \/ US/,
    /Client AS\s+AS123/, /Provider\s+Example Registry/, /Location \(approx\.\)\s+City, US/]) {
    assert.match(output, pattern);
  }
  assert.doesNotMatch(output, /Profile|quick|Usage|payload|Elapsed|loaded|Packet loss|verified|geolocation|registry name/);
  assert.deepEqual(result, before);
  const verbose = formatResult(result, { verbose: true });
  for (const label of ['Profile: quick', 'HTTP latency (not ICMP)', 'Download loaded / jitter',
    'Upload loaded / jitter', 'Approximate location', 'Usage', 'Application payload',
    'Elapsed', 'Packet loss:', 'not a verified retail ISP', 'approximate IP geolocation']) {
    assert.ok(verbose.includes(label), label);
  }
});

test('partial summaries stay clearly incomplete, missing values stay unavailable, colors are intentional', () => {
  for (const verbose of [false, true]) {
    const plain = formatResult({ downloadMbps: 0, jitterMs: 0 }, { partial: true, verbose });
    assert.match(plain, /^Last known measurements \(test incomplete\)/);
    assert.match(plain, /Upload\s+unavailable/);
    assert.match(plain, /Provider\s+unavailable/);
    assert.match(plain, /0\.00 Mbps/);
    assert.match(plain, /0\.00 ms/);
    assert.doesNotMatch(plain, /\u001b/);
    const colored = formatResult({ downloadMbps: 0 }, { color: true, verbose });
    assert.match(colored, /\u001b\[1mCloudflare speed test/);
    assert.match(colored, /\u001b\[36m  Download/);
    assert.match(colored, /\u001b\[35m  Upload/);
    const unsafe = formatResult({ profile: '\u001b[2J\nprofile', server: { colo: '\r\u001b[2J' },
      network: { provider: '\u001b[31mBad\n\u202e', city: '東京\r\n' } }, { verbose });
    assert.doesNotMatch(unsafe, /\u001b|\r|\u202e/);
  }
});
