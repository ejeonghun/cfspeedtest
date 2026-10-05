import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDisplay, dashboardLines, mergeProgress } from '../src/live-display.js';
import { textWidth } from '../src/format.js';

test('dashboard distinguishes waiting, measuring, unavailable and genuine zero', () => {
  const initial = dashboardLines({ profile: 'quick', phase: 'metadata' }).join('\n');
  assert.match(initial, /Download\s+waiting/);
  assert.match(initial, /Upload\s+waiting/);
  assert.match(initial, /Client AS\s+unavailable/);
  assert.match(initial, /Ping \(HTTP\)\s+waiting \| Jitter waiting/);
  assert.match(dashboardLines({ phase: 'latency' }).join('\n'), /Ping \(HTTP\)\s+measuring \| Jitter measuring/);
  assert.match(dashboardLines({ phase: 'latency', latencyMs: null }).join('\n'), /Ping \(HTTP\)\s+unavailable/);
  const active = dashboardLines({ phase: 'download', downloadMbps: null, latencyMs: 0, jitterMs: 0 }).join('\n');
  assert.match(active, /Download\s+measuring/);
  assert.match(active, /0\.00 ms/);
  const zero = dashboardLines({ phase: 'upload', downloadMbps: 0, liveDirection: 'upload', liveMbps: 0 }).join('\n');
  assert.match(zero, /Download\s+0\.00 Mbps/);
  assert.match(zero, /Upload\s+0\.00 Mbps \(live\)/);
});

test('progress merges gradual metadata; provisional Mbps never replaces final aggregate across phases', () => {
  let state = mergeProgress({}, { phase: 'metadata', network: { asn: 123 }, server: { colo: 'SJC' } });
  state = mergeProgress(state, { network: { provider: 'Example' }, server: { country: 'US' } });
  assert.deepEqual(state.network, { asn: 123, provider: 'Example' });
  assert.deepEqual(state.server, { colo: 'SJC', country: 'US' });
  state = mergeProgress(state, { phase: 'download', liveDirection: 'download', liveMbps: 100 });
  assert.match(dashboardLines(state).join('\n'), /100\.00 Mbps \(live\)/);
  state = mergeProgress(state, { downloadMbps: 85 });
  assert.match(dashboardLines(state).join('\n'), /Download\s+85\.00 Mbps/);
  assert.ok(!dashboardLines(state).join('\n').includes('100.00'));
  state = mergeProgress(state, { phase: 'upload', liveDirection: 'upload', liveMbps: 10 });
  assert.match(dashboardLines(state).join('\n'), /Download\s+85\.00 Mbps/);
  assert.match(dashboardLines(state).join('\n'), /Upload\s+10\.00 Mbps \(live\)/);
  assert.match(dashboardLines(state, { stopped: true }).join('\n'), /10\.00 Mbps \(last live\)/);
});

test('compact frame has a fixed line count and leaves room for terminal autowrap', () => {
  for (const verbose of [false, true]) {
    for (const columns of [2, 20, 40, 60, 80, 120]) {
      for (const stopped of [false, true]) {
        const lines = dashboardLines({ network: { provider: 'A very long organization '.repeat(20), city: '東京'.repeat(20) } }, { width: columns - 1, verbose, stopped });
        assert.equal(lines.length, verbose ? 12 : 9);
        assert.ok(lines.every((line) => textWidth(line) < columns));
      }
    }
  }
});

test('live frames are throttled, width changes force redraw, late updates are ignored, cursor restored once', () => {
  let output = '';
  let time = 0;
  const stream = { columns: 80, write: (text) => { output += text; } };
  const display = createLiveDisplay({ stream, enabled: true, profile: 'quick', now: () => time, intervalMs: 150 });
  display.start();
  const initialLength = output.length;
  display.update({ phase: 'download', liveDirection: 'download', liveMbps: 1 });
  assert.equal(output.length, initialLength);
  time = 150;
  display.update({ liveMbps: 2 });
  assert.match(output, /2\.00 Mbps \(live\)/);
  stream.columns = 40;
  display.update({ liveMbps: 3 });
  assert.match(output, /3\.00 Mbps \(live\)/);
  assert.ok(!output.includes('\u001b[2J'));
  assert.ok(!output.includes('\u001b[3J'));
  display.finish();
  assert.ok(output.endsWith('\u001b[?25h'));
  const finalLength = output.length;
  display.update({ liveMbps: 4 });
  display.finish();
  assert.equal(output.length, finalLength);
  assert.equal((output.match(/\u001b\[\?25l/g) ?? []).length, 1);
  assert.equal((output.match(/\u001b\[\?25h/g) ?? []).length, 1);
});

test('disabled displays emit absolutely nothing but retain latest state', () => {
  let output = '';
  const display = createLiveDisplay({ stream: { write: (text) => { output += text; } }, enabled: false, profile: 'quick', now: () => 0 });
  display.start();
  display.update({ downloadMbps: 50 });
  display.finish({ preserve: true });
  assert.equal(output, '');
  assert.equal(display.snapshot().downloadMbps, 50);
});

test('default frames show only essential details and a phase; verbose keeps the original detail', () => {
  const state = { profile: 'quick', phase: 'download', liveDirection: 'download', liveMbps: 90,
    latencyMs: 10, jitterMs: 1, server: { colo: 'SJC' },
    network: { asn: 123, provider: 'Example', city: 'City' },
    bytes: { download: 1000, upload: 0 }, durationMs: 1000 };
  const before = structuredClone(state);
  const compact = dashboardLines(state).join('\n');
  for (const pattern of [/Download\s+90\.00 Mbps \(live\)/, /Upload\s+waiting/,
    /Ping \(HTTP\)\s+10\.00 ms \| Jitter 1\.00 ms/, /Server\s+SJC/,
    /Client AS\s+AS123/, /Provider\s+Example/, /Location \(approx\.\)\s+City/, /Downloading/]) {
    assert.match(compact, pattern);
  }
  assert.doesNotMatch(compact, /quick|payload|1\.00 s|Provider =|Location =|Live Mbps:|loaded|Packet loss/);
  const verbose = dashboardLines(state, { verbose: true }).join('\n');
  for (const label of ['Cloudflare speed test | quick', 'HTTP idle', 'Provider = AS organization / registry name',
    'Location = approximate IP geolocation', '1.00 kB payload', '1.00 s', 'Live Mbps: current transfer']) {
    assert.ok(verbose.includes(label), label);
  }
  assert.deepEqual(state, before);
});

test('both frame styles sanitize remote text and retain download/upload color hierarchy', () => {
  for (const verbose of [false, true]) {
    const state = { profile: '\u001b[2J\nquick', network: { provider: '\u001b[2J\r\nBad\u202e', city: '東京'.repeat(30) } };
    const plain = dashboardLines(state, { width: 39, verbose });
    assert.ok(plain.every((line) => textWidth(line) <= 39));
    assert.doesNotMatch(plain.join('\n'), /\u001b|\r|\u202e/);
    const colored = dashboardLines(state, { width: 39, color: true, verbose });
    assert.match(colored[0], /^\u001b\[1m/);
    assert.match(colored[1], /^\u001b\[36m/);
    assert.match(colored[2], /^\u001b\[35m/);
    assert.deepEqual(colored.map((line) => line.replace(/\u001b\[\d+m/g, '')), plain);
  }
});

test('each frame owns its exact row count, clears CJK reflow after resize, and preserves incomplete results safely', () => {
  for (const verbose of [false, true]) {
    let output = '';
    const stream = { columns: 80, write: (text) => { output += text; } };
    const display = createLiveDisplay({ stream, enabled: true, verbose, now: () => 0 });
    display.update({ network: { provider: '東京'.repeat(40), city: '東京'.repeat(40) } });
    const count = verbose ? 12 : 9;
    assert.ok(output.endsWith(`\u001b[${count}A\r`));
    const oldLines = dashboardLines(display.snapshot(), { width: 79, verbose });
    stream.columns = 20;
    output = '';
    display.update({});
    const physicalRows = oldLines.reduce((sum, line) => sum + Math.max(1, Math.ceil(textWidth(line) / 20)), 0);
    assert.equal((output.match(/\u001b\[2K/g) ?? []).length, physicalRows);
    assert.ok(output.includes(`\u001b[${physicalRows}A\r`));
    stream.columns = 80;
    output = '';
    display.finish({ preserve: true, partialResult: { downloadMbps: 42, uploadMbps: null } });
    assert.match(output, /Download\s+42\.00 Mbps/);
    assert.match(output, /Upload\s+unavailable/);
    assert.match(output, /incomplete/);
    assert.ok(output.endsWith(`\u001b[${count}B\r\u001b[?25h`));
    const final = output;
    display.start();
    display.update({ downloadMbps: 999 });
    display.finish({ preserve: true });
    assert.equal(output, final);
    assert.equal(display.snapshot().downloadMbps, 42);
  }
});
