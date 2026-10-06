import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatResult } from '../src/format.js';
import { renderCiSummary } from '../scripts/render-ci-summary.js';

// Synthetic offline fixture, not a measured result.
const fixture = () => ({
  schemaVersion: 1, profile: 'default', partial: false,
  downloadMbps: 123.456, uploadMbps: 45.678, latencyMs: 12.345, jitterMs: 0.456,
  server: { colo: 'TST', country: 'Example Country' },
  network: { asn: 64500, provider: 'Example Network', city: 'Sample City', countryCode: 'ZZ' },
});

function unwrap(summary) {
  const lines = summary.split('\n');
  const fence = lines[0].slice(0, -4);
  assert.match(fence, /^`{3,}$/);
  const end = lines.indexOf(fence, 1);
  assert.equal(end, 9);
  assert.equal(lines.slice(end + 1).join('\n'), '\nGitHub runner · default profile\n');
  return lines.slice(1, end).join('\n') + '\n';
}

test('summary preserves the exact concise eight-row CLI layout and rounded values', () => {
  const result = fixture();
  const output = unwrap(renderCiSummary(result));
  assert.equal(output, formatResult(result, { color: false, verbose: false }));
  assert.deepEqual(output.trimEnd().split('\n'), [
    'Cloudflare speed test',
    '  Download           123.46 Mbps',
    '  Upload             45.68 Mbps',
    '  Ping (HTTP)        12.35 ms | Jitter 0.46 ms',
    '  Server             TST / Example Country',
    '  Client AS          AS64500',
    '  Provider           Example Network',
    '  Location (approx.) Sample City, ZZ',
  ]);
  assert.doesNotMatch(output, /\x1b|Usage|Packet loss|loaded|payload/i);
});

test('nulls and missing metadata remain unavailable; true zeros stay zero', () => {
  const result = { ...fixture(), downloadMbps: null, uploadMbps: 0, latencyMs: null, jitterMs: 0,
    server: null, network: {} };
  const output = unwrap(renderCiSummary(result));
  assert.equal(output, formatResult(result, { color: false, verbose: false }));
  assert.match(output, /Download +unavailable\n/);
  assert.match(output, /Upload +0\.00 Mbps\n/);
  assert.match(output, /Ping \(HTTP\) +unavailable \| Jitter 0\.00 ms\n/);
  for (const label of ['Server', 'Client AS', 'Provider', 'Location (approx.)']) {
    assert.ok(output.split('\n').some(line => line.trimStart().startsWith(label) && line.endsWith('unavailable')));
  }
  assert.doesNotThrow(() => renderCiSummary({ ...result, server: undefined, network: undefined }));
});

test('remote controls, ANSI, backticks, HTML and links cannot escape the code card', () => {
  const result = fixture();
  result.network.provider = '\x1b[31m```\r\n``````\t<img src=x onerror=alert(1)> [link](https://example.invalid)\x00\u202e';
  result.server.colo = '```\n# injected';
  result.network.city = 'City\n```\n<script>alert(1)</script>';
  const summary = renderCiSummary(result);
  assert.ok(summary.startsWith('```````text\n'));
  const output = unwrap(summary);
  assert.equal(output, formatResult(result, { color: false, verbose: false }));
  assert.doesNotMatch(output.replaceAll('\n', ''), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  assert.match(output, /<img src=x onerror=alert\(1\)>/);
  assert.match(output, /<script>alert\(1\)<\/script>/);
  const fence = summary.split('\n')[0].slice(0, -4);
  assert.equal(summary.split('\n').filter(line => line === fence).length, 1);
});

test('presentation rejects invalid objects, profiles, partials and metric types', () => {
  const invalid = [null, [], 'private-payload', {},
    { ...fixture(), schemaVersion: 2 }, { ...fixture(), profile: 'quick' },
    { ...fixture(), partial: true }, { ...fixture(), partial: null },
    { ...fixture(), downloadMbps: '123' }, { ...fixture(), uploadMbps: Infinity },
    { ...fixture(), latencyMs: -1 }, { ...fixture(), jitterMs: undefined },
    { ...fixture(), network: [] }, { ...fixture(), server: 'private-payload' },
    { ...fixture(), network: { provider: { secret: 'private-payload' } } },
  ];
  for (const result of invalid) {
    assert.throws(() => renderCiSummary(result), { message: 'Invalid CI summary result' });
  }
});

const script = fileURLToPath(new URL('../scripts/render-ci-summary.js', import.meta.url));
const invoke = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });

test('CLI emits Markdown only on stdout with quiet stderr', async () => {
  const directory = await mkdtemp('/tmp/opencode/cfspeedtest-summary-test-');
  try {
    const path = join(directory, 'result.json');
    await writeFile(path, JSON.stringify(fixture()));
    const child = invoke([path]);
    assert.equal(child.status, 0);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, renderCiSummary(fixture()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI rejects arguments, unreadable/oversized files and bad JSON without echoing payloads or paths', async () => {
  const directory = await mkdtemp('/tmp/opencode/cfspeedtest-summary-test-');
  try {
    const malformed = join(directory, 'private-malformed.json');
    const invalid = join(directory, 'private-invalid.json');
    const oversized = join(directory, 'private-large.json');
    await writeFile(malformed, 'private-payload {');
    await writeFile(invalid, JSON.stringify({ secret: 'private-payload' }));
    await writeFile(oversized, ' '.repeat(1_048_577));
    for (const args of [[], ['one', 'two'], [join(directory, 'private-missing.json')],
      [directory], [malformed], [invalid], [oversized]]) {
      const child = invoke(args);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.match(child.stderr, /^(Usage:|Cannot read CI summary|Invalid CI summary)/);
      assert.doesNotMatch(child.stderr, /private-|cfspeedtest-summary-test-/);
      assert.equal(child.stderr.trimEnd().split('\n').length, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
