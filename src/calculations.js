// HTTP measurement formulas ported from @cloudflare/speedtest 1.14.1
// (upstream commit 323da2ea5697ab4953f2c90c931125ac35d019d8).
export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

export function jitter(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  return valid.slice(1).reduce((sum, value, index) => sum + Math.abs(value - valid[index]), 0) / (valid.length - 1);
}

export function serverTime(header = '') {
  // Exact Server-Timing name/parameter regexes from upstream BandwidthEngine.
  const text = String(header);
  const preferred = text.match(/(?:^|,\s*)cfReq(?:uest)?Dur(?:ation)?;\s*dur=([0-9.]+)/i);
  const duration = preferred ? Number(preferred[1]) : 0;
  if (Number.isFinite(duration) && duration > 0.01) return duration;
  let sum = 0;
  for (const match of text.matchAll(/(?:^|,\s*)cfSpeed[a-zA-Z]*;\s*dur=([0-9.]+)/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) sum += value;
  }
  return Number.isFinite(sum) && sum > 0.01 ? sum : 0;
}

export function calculateSample(result, delta = 0) {
  const time = serverTime(result.serverTiming);
  const ttfb = result.responseStart - result.requestStart;
  let nextDelta = delta;
  if (time && Number.isFinite(result.tcpDuration) && result.tcpDuration > 0) {
    const d = Math.max(0, ttfb - result.tcpDuration) - time;
    if (d > 0 && d <= 15 && d <= time && time <= 150) nextDelta = 0.25 * delta + 0.75 * d;
  }
  // Upstream updates calibration before calculating the CURRENT sample's ping.
  let ping = ttfb - time - nextDelta;
  if (ping <= 1) ping = Math.max(0, ttfb - time);
  const duration = result.direction === 'upload' ? ttfb : ping + result.responseEnd - result.responseStart;
  return { ping, duration, nextDelta, mbps: duration > 0 ? result.requestedBytes * 1.005 * 8 / duration / 1000 : null };
}

export function speed(samples) {
  return percentile(samples.filter(sample => sample.duration >= 10 && sample.mbps > 0 && Number.isFinite(sample.mbps)).map(sample => sample.mbps), 0.9);
}

export function loadedMetrics(buckets) {
  const pings = [...buckets.values()].filter(bucket => bucket.durations.length && bucket.durations.every(duration => duration >= 250))
    .flatMap(bucket => bucket.pings).slice(-20);
  return { latency: percentile(pings, 0.5), jitter: jitter(pings) };
}
