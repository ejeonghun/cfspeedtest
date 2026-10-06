import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateLiveResult } from '../scripts/verify-live-result.js';

// Synthetic offline fixtures only: these tests never perform a speed measurement.
const fixture = () => ({
  schemaVersion: 1, profile: 'default', downloadMbps: 100, uploadMbps: 50,
  latencyMs: 10, jitterMs: 0, durationMs: 1000,
  bytes: { download: 169_000_000, upload: 146_800_000 },
  downloadLoadedLatencyMs: null, downloadLoadedJitterMs: null,
  uploadLoadedLatencyMs: null, uploadLoadedJitterMs: null, packetLoss: null,
  network: { provider: null, asn: null, country: null },
});

test('live validator accepts complete default metrics with unavailable optional metadata', () => {
  const result = fixture();
  assert.equal(validateLiveResult(result), result);
  assert.doesNotThrow(() => validateLiveResult({ ...result, latencyMs: 0, partial: false }));
});

test('live validator rejects invalid required fields and incomplete measurements', () => {
  for (const result of [null, [], 'result', 1]) assert.throws(() => validateLiveResult(result), /object required/);
  for (const field of ['schemaVersion', 'profile', 'downloadMbps', 'uploadMbps', 'durationMs', 'latencyMs', 'jitterMs', 'bytes']) {
    const result = fixture();
    delete result[field];
    assert.throws(() => validateLiveResult(result), new RegExp(field));
  }
  for (const [field, values] of [
    ['schemaVersion', [2, '1']], ['profile', ['full', 'quick']],
    ['partial', [true, 'true', null]],
    ...['downloadMbps', 'uploadMbps', 'durationMs'].map(field => [field, [0, -1, NaN, Infinity, null, '10']]),
    ...['latencyMs', 'jitterMs'].map(field => [field, [-1, NaN, Infinity, null, '10']]),
  ]) {
    for (const value of values) assert.throws(() => validateLiveResult({ ...fixture(), [field]: value }), new RegExp(field));
  }
});

test('live validator enforces positive safe byte counters and the combined body budget', () => {
  for (const field of ['download', 'upload']) {
    for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, null, '100', Number.MAX_SAFE_INTEGER + 1]) {
      const result = fixture();
      result.bytes[field] = value;
      assert.throws(() => validateLiveResult(result), new RegExp(`bytes.${field}`));
    }
  }
  for (const bytes of [null, [], 'bytes']) assert.throws(() => validateLiveResult({ ...fixture(), bytes }), /bytes/);
  assert.throws(() => validateLiveResult({ ...fixture(), bytes: { download: 165_000_001, upload: 165_000_000 } }), /budget/);
  assert.throws(() => validateLiveResult({ ...fixture(), bytes: { download: Number.MAX_SAFE_INTEGER, upload: 1 } }), /budget/);
  assert.doesNotThrow(() => validateLiveResult({ ...fixture(), bytes: { download: 165_000_000, upload: 165_000_000 } }));
  for (const budget of [0, -1, Infinity, 1.5]) assert.throws(() => validateLiveResult(fixture(), budget), /maxBytes/);
});

test('live validator CLI requires one readable JSON object and exits honestly without raw payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfspeedtest-validator-'));
  const script = fileURLToPath(new URL('../scripts/verify-live-result.js', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });
  try {
    const path = join(directory, 'result.json');
    await writeFile(path, `${JSON.stringify(fixture())}\n`);
    const success = run([path]);
    assert.ifError(success.error);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, '');
    assert.match(success.stdout, /^Validated GitHub runner default measurement: download 100 Mbps;/);
    for (const args of [[], [path, path], [join(directory, 'missing.json')]]) {
      const child = run(args);
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.match(child.stderr, /Usage:|Cannot read/);
    }
    for (const text of ['private-marker malformed', '', `${JSON.stringify(fixture())}\n${JSON.stringify(fixture())}`, JSON.stringify({ ...fixture(), partial: true })]) {
      await writeFile(path, text);
      const child = run([path]);
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.match(child.stderr, /Invalid live result:/);
      assert.doesNotMatch(child.stderr, /private-marker/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
