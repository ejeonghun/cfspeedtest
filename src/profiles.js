// Upstream 1.14.1 default HTTP measurements, with packet loss omitted.
const latency = count => ({ phase: 'latency', count, bytes: 0 });
const bandwidth = (phase, bytes, count, bypassMinDuration = false) => ({ phase, bytes, count, bypassMinDuration });
const full = Object.freeze([
    latency(2), bandwidth('download', 100000, 1, true), latency(20),
    bandwidth('download', 100000, 9), latency(2), bandwidth('download', 1000000, 8), latency(2),
    bandwidth('upload', 100000, 8), latency(2), bandwidth('upload', 1000000, 6), latency(2),
    bandwidth('download', 10000000, 6), latency(2), bandwidth('upload', 10000000, 4), latency(2),
    bandwidth('download', 25000000, 4), latency(2), bandwidth('upload', 25000000, 4), latency(2),
    bandwidth('download', 100000000, 3), latency(2), bandwidth('upload', 50000000, 3), latency(2),
    bandwidth('download', 250000000, 2),
  ].map(Object.freeze));
export const profiles = Object.freeze({
  full,
  // Conservative software policy, NOT a published Cloudflare endpoint limit.
  default: Object.freeze(full.filter(step => step.phase === 'latency' || step.bytes <= 25000000)),
  quick: Object.freeze([
    latency(2), bandwidth('download', 100000, 1, true), latency(8),
    bandwidth('download', 1000000, 2), bandwidth('upload', 1000000, 2),
    bandwidth('download', 5000000, 2), bandwidth('upload', 2000000, 2), latency(2),
  ].map(Object.freeze)),
});

export function profileTotals(profile) {
  return profiles[profile].reduce((totals, step) => {
    if (step.phase !== 'latency') totals[step.phase] += step.bytes * step.count;
    return totals;
  }, { download: 0, upload: 0 });
}
