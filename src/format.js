export const number = (value, unit) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} ${unit}`
    : 'unavailable';

export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'unavailable';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value.toFixed(2)} ${units[index]}`;
}

// Metadata is remote text: never allow it to move the terminal cursor.
export const cleanText = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();

export function useColor(stream, mode = 'auto', env = process.env) {
  return Boolean(stream.isTTY && mode !== 'never' && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb');
}

export function paint(text, style, enabled) {
  const codes = { title: 1, muted: 90, download: 36, upload: 35, error: 31 };
  return enabled ? `\u001b[${codes[style] ?? 0}m${text}\u001b[0m` : text;
}

function characterWidth(character) {
  if (/\p{Mark}/u.test(character) || character === '\u200d' || character === '\ufe0f') return 0;
  const code = character.codePointAt(0);
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
}

export const textWidth = (text) => [...text].reduce((sum, character) => sum + characterWidth(character), 0);

export function fitLine(text, width) {
  text = cleanText(text);
  if (textWidth(text) <= width) return text;
  const suffix = width >= 3 ? '...' : '';
  let fitted = '';
  for (const character of text) {
    if (textWidth(fitted) + characterWidth(character) > width - suffix.length) break;
    fitted += character;
  }
  return fitted + suffix;
}

export function networkFields(network) {
  const asn = cleanText(network?.asn);
  return {
    asn: asn ? (/^AS/i.test(asn) ? asn : `AS${asn}`) : 'unavailable',
    provider: cleanText(network?.provider) || 'unavailable',
    location: [network?.city, network?.region, network?.country || network?.countryCode].map(cleanText).filter(Boolean).join(', ') || 'unavailable',
  };
}

export function payloadTotal(bytes) {
  return Number.isSafeInteger(bytes?.download) && Number.isSafeInteger(bytes?.upload)
    ? formatBytes(bytes.download + bytes.upload) : 'unavailable';
}

export function formatResult(result, { color = false, partial = false, verbose = false } = {}) {
  const row = (label, value) => `  ${label.padEnd(verbose ? 25 : 18)} ${value}`;
  const server = [result.server?.colo, result.server?.country].map(cleanText).filter(Boolean).join(' / ');
  const network = networkFields(result.network);
  const title = partial ? 'Last known measurements (test incomplete)' : 'Cloudflare speed test';
  if (!verbose) return [
    paint(title, 'title', color),
    paint(row('Download', number(result.downloadMbps, 'Mbps')), 'download', color),
    paint(row('Upload', number(result.uploadMbps, 'Mbps')), 'upload', color),
    row('Ping (HTTP)', `${number(result.latencyMs, 'ms')} | Jitter ${number(result.jitterMs, 'ms')}`),
    row('Server', server || 'unavailable'),
    row('Client AS', network.asn),
    row('Provider', network.provider),
    row('Location (approx.)', network.location),
    '',
  ].join('\n');
  return [
    paint(title, 'title', color),
    `Profile: ${cleanText(result.profile) || 'unavailable'}${server ? `  |  Server: ${server}` : ''}`,
    '',
    'Speed',
    paint(row('Download', number(result.downloadMbps, 'Mbps')), 'download', color),
    paint(row('Upload', number(result.uploadMbps, 'Mbps')), 'upload', color),
    '',
    'HTTP latency (not ICMP)',
    row('Idle latency / jitter', `${number(result.latencyMs, 'ms')} / ${number(result.jitterMs, 'ms')}`),
    row('Download loaded / jitter', `${number(result.downloadLoadedLatencyMs, 'ms')} / ${number(result.downloadLoadedJitterMs, 'ms')}`),
    row('Upload loaded / jitter', `${number(result.uploadLoadedLatencyMs, 'ms')} / ${number(result.uploadLoadedJitterMs, 'ms')}`),
    '',
    'Network',
    row('Client AS', network.asn),
    row('Provider', network.provider),
    row('Approximate location', network.location),
    '  Provider: reported AS organization / registry name, not a verified retail ISP.',
    '  Location: approximate IP geolocation.',
    '',
    'Usage',
    row('Application payload', `${payloadTotal(result.bytes)} total`),
    row('Downloaded / uploaded', `${formatBytes(result.bytes?.download)} / ${formatBytes(result.bytes?.upload)}`),
    row('Elapsed', number(typeof result.durationMs === 'number' ? result.durationMs / 1000 : null, 's')),
    '',
    'Packet loss: unavailable (requires WebRTC/TURN).',
    '',
  ].join('\n');
}
