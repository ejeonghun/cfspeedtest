import test from 'node:test';
import assert from 'node:assert/strict';
import { profiles, profileTotals } from '../src/profiles.js';

test('exact upstream full schedule, excluding packet loss', () => {
  assert.deepEqual(profiles.full.map(s => [s.phase, s.bytes, s.count, s.bypassMinDuration ?? false]), [
    ['latency',0,2,false], ['download',100000,1,true], ['latency',0,20,false], ['download',100000,9,false],
    ['latency',0,2,false], ['download',1000000,8,false], ['latency',0,2,false], ['upload',100000,8,false],
    ['latency',0,2,false], ['upload',1000000,6,false], ['latency',0,2,false], ['download',10000000,6,false],
    ['latency',0,2,false], ['upload',10000000,4,false], ['latency',0,2,false], ['download',25000000,4,false],
    ['latency',0,2,false], ['upload',25000000,4,false], ['latency',0,2,false], ['download',100000000,3,false],
    ['latency',0,2,false], ['upload',50000000,3,false], ['latency',0,2,false], ['download',250000000,2,false],
  ]);
  assert.deepEqual(profileTotals('full'), { download: 969000000, upload: 296800000 });
});

test('default preserves ordered full steps and every idle phase, omitting only requests over25MB', () => {
  assert.deepEqual(profiles.default, profiles.full.filter(step => step.phase === 'latency' || step.bytes <= 25000000));
  assert.deepEqual(profiles.default.filter(step => step.phase === 'latency'), profiles.full.filter(step => step.phase === 'latency'));
  assert.ok(profiles.default.every(step => step.bytes <= 25000000));
  assert.deepEqual(profileTotals('default'), { download: 169000000, upload: 146800000 });
  assert.ok(Object.isFrozen(profiles.default));
});

test('exact quick schedule and body total', () => {
  assert.deepEqual(profiles.quick.map(s => [s.phase, s.bytes, s.count]), [
    ['latency',0,2], ['download',100000,1], ['latency',0,8], ['download',1000000,2],
    ['upload',1000000,2], ['download',5000000,2], ['upload',2000000,2], ['latency',0,2],
  ]);
  assert.equal(profiles.quick[1].bypassMinDuration, true);
  assert.deepEqual(profileTotals('quick'), { download: 12100000, upload: 6000000 });
  assert.ok(Object.isFrozen(profiles.quick[0]));
});
