import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, jitter, serverTime, calculateSample, speed, loadedMetrics } from '../src/calculations.js';

test('interpolated percentiles, consecutive jitter, empty metrics', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.9), 37);
  assert.equal(percentile([NaN, 10, Infinity], 0.5), 10);
  assert.equal(percentile([], 0.5), null);
  assert.equal(jitter([10, 20, 15, 35]), 35 / 3);
  assert.equal(jitter([1]), null);
});

test('server timing preferred family, fallback sum, strict validity boundary', () => {
  assert.equal(serverTime('cfSpeedOne;dur=4, cfSpeedTwo;dur=6'), 10);
  assert.equal(serverTime('cfSpeedOne;dur=4, cfReqDur;dur=8, cfRequestDuration;dur=9'), 8);
  assert.equal(serverTime('cfReqDur;dur=0.01, cfSpeedOne;dur=2'), 2);
  assert.equal(serverTime('cfReqDur;dur=0.011'), 0.011);
  assert.equal(serverTime('other;dur=20, cfSpeedOne;dur=-1'), 0);
  assert.equal(serverTime(), 0);
});

test('source-golden Server-Timing regexes recognize exactly the four preferred names', () => {
  for (const name of ['cfReqDur', 'cfRequestDur', 'cfReqDuration', 'cfRequestDuration']) {
    assert.equal(serverTime(`${name};dur=8, cfSpeedOne;dur=4`), 8);
    assert.equal(serverTime(`other;dur=99, ${name.toUpperCase()}; dur=8`), 8);
  }
  for (const entry of [
    'cfReqDurFoo;dur=8', 'cfRequestDurationFoo;dur=8', 'prefixcfReqDur;dur=8',
    'cfReqDur;desc=x;dur=8', 'cfReqDur;dur =8', 'cfReqDur;dur="8"', ' cfReqDur;dur=8',
  ]) assert.equal(serverTime(`${entry}, cfSpeedOne;dur=4`), 4, entry);
  assert.equal(serverTime('cfSpeedOne; dur=0.006, cfSpeedTwo;dur=0.006'), 0.012);
  assert.equal(serverTime('cfSpeed;dur=.006, cfSpeedTwo;dur=.006'), 0.012);
  assert.equal(serverTime('cfSpeedOne;dur=0.005, cfSpeedTwo;dur=0.005'), 0);
  assert.equal(serverTime('cfSpeedOne2;dur=8, cfSpeedOne;desc=x;dur=8'), 0);
  assert.equal(serverTime('cfReqDur;dur=0.01, cfReqDur;dur=9, cfSpeedOne;dur=0.02'), 0.02);
  assert.equal(serverTime('cfReqDur;dur=1..2, cfSpeedOne;dur=0.02'), 0.02);
  assert.equal(serverTime('cfReqDur;dur=invalid, cfSpeedOne;dur=0.02'), 0.02);
});

const result = (options = {}) => ({ direction: 'download', requestedBytes: 100000,
  requestStart: 0, responseStart: 35, responseEnd: 45, serverTiming: 'cfReqDur;dur=20', tcpDuration: 5, ...options });

test('source-golden sample formulas apply newly updated calibration to the current sample', () => {
  const sample = calculateSample(result(), 4);
  assert.deepEqual(sample, { ping: 6.5, duration: 16.5, nextDelta: 8.5, mbps: 100000 * 1.005 * 8 / 16.5 / 1000 });
  const sourceExample = calculateSample(result({ responseStart: 30, tcpDuration: 10, serverTiming: 'cfReqDur;dur=15' }));
  assert.equal(sourceExample.nextDelta, 3.75);
  assert.equal(sourceExample.ping, 11.25);
  assert.equal(calculateSample(result({ responseStart: 30, tcpDuration: 10, serverTiming: 'cfReqDur;dur=15' }), 44).ping, 15);
  assert.equal(calculateSample(result({ direction: 'upload' }), 4).duration, 35);
  assert.equal(calculateSample(result({ responseStart: 24 }), 4).ping, 4);
  assert.equal(calculateSample(result({ responseStart: 18 }), 4).ping, 0);
  assert.equal(calculateSample(result({ tcpDuration: undefined }), 4).nextDelta, 4);
});

test('calibration boundaries', () => {
  for (const [d, server, expected] of [[0, 20, 4], [15, 20, 12.25], [15.001, 20, 4], [10, 9, 4], [10, 150, 8.5], [10, 150.001, 4]]) {
    assert.equal(calculateSample(result({ responseStart: server + d + 5, serverTiming: `cfReqDur;dur=${server}` }), 4).nextDelta, expected);
  }
  for (const tcpDuration of [undefined, 0, -1, NaN, Infinity]) {
    const sample = calculateSample(result({ responseStart: 30, tcpDuration }), 4);
    assert.equal(sample.nextDelta, 4);
    assert.equal(sample.ping, 6);
  }
  assert.equal(calculateSample(result({ serverTiming: '' }), 4).nextDelta, 4);
});

test('10ms speed and 250ms loaded eligibility are inclusive; insertion order last20', () => {
  assert.equal(speed([{ duration: 9.999, mbps: 999 }, { duration: 10, mbps: 8 }, { duration: 11, mbps: 12 }, { duration: 100, mbps: Infinity }]), 11.6);
  assert.equal(speed([{ duration: 9, mbps: 5 }]), null);
  const buckets = new Map([
    [100, { durations: [249.999, 300], pings: [999] }],
    [1000, { durations: [250], pings: Array.from({ length: 25 }, (_, i) => i) }],
    [2000, { durations: [300], pings: [100] }],
  ]);
  assert.deepEqual(loadedMetrics(buckets), { latency: 15.5, jitter: 94 / 19 });
});
