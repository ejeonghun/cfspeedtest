// Optional, public but undocumented Cloudflare /meta response. Never retain
// client IPs, coordinates, unknown keys, or claims about the retail ISP.
export const METADATA_SOURCE = 'https://speed.cloudflare.com/meta';
export const METADATA_LIMIT = 32768;
export const MEASUREMENT_HEADERS_SOURCE = 'https://speed.cloudflare.com/__down (response headers)';
export function emptyNetwork(attempted = false) {
  return { asn: null, provider: null, providerSource: null, city: null, region: null, country: null, countryCode: null,
    source: attempted ? METADATA_SOURCE : null };
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  return cleaned && cleaned.length <= max ? cleaned : null;
}
function code(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-z]{${length}}$`, 'i').test(value) ? value.toUpperCase() : null;
}
export function normalizeMetadata(value) {
  const network = emptyNetwork(true);
  const server = { colo: null, country: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { network, server, available: false };
  const asn = value.asn;
  if ((typeof asn === 'number' && Number.isSafeInteger(asn) || typeof asn === 'string' && /^\d{1,10}$/.test(asn))
      && Number(asn) > 0 && Number(asn) <= 4294967295) network.asn = asn;
  network.provider = text(value.asOrganization, 160);
  if (network.provider) network.providerSource = METADATA_SOURCE;
  network.city = text(value.city, 100);
  network.region = text(value.region, 100);
  network.countryCode = code(value.country, 2);
  if (network.countryCode) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(network.countryCode);
      network.country = name ?? null;
    } catch { /* Local display names are optional, not a server-provided name. */ }
  }
  if (value.colo && typeof value.colo === 'object' && !Array.isArray(value.colo)) {
    server.colo = code(value.colo.iata, 3);
    server.country = code(value.colo.cca2, 2);
  }
  const available = Object.entries(network).some(([key, item]) => key !== 'source' && item !== null) || server.colo !== null || server.country !== null;
  return { network, server, available };
}

// Only explicit successful measurement headers provide client facts. The
// client country is never used as the edge's country; no IP/coordinates leak.
export function normalizeMeasurementHeaders(headers = {}, direction = 'download') {
  const safe = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
  const normalized = normalizeMetadata({ asn: safe.asn, asOrganization: safe.asorganization,
    city: safe.city, region: safe.region, country: safe.country });
  const { network } = normalized;
  const clientAvailable = Object.entries(network).some(([key, value]) => !['source', 'providerSource'].includes(key) && value !== null);
  const source = direction === 'upload' ? 'https://speed.cloudflare.com/__up (response headers)' : MEASUREMENT_HEADERS_SOURCE;
  network.source = clientAvailable ? source : null;
  network.providerSource = network.provider ? source : null;
  const rayColo = typeof safe['cf-ray'] === 'string' ? safe['cf-ray'].match(/-([a-z]{3})$/i)?.[1] : null;
  const server = { colo: code(rayColo, 3) ?? code(safe.colo, 3) ?? code(safe['cf-meta-colo'], 3), country: null };
  return { network, server, available: clientAvailable || server.colo !== null };
}

const error = (code, message) => Object.assign(new Error(message), { code });
export async function fetchMetadata({ client, agent, origin, headers, signal, ledger, timeoutMs = 5000 }) {
  if (signal?.aborted) throw signal.reason ?? error('ABORTED', 'Aborted');
  const reservation = ledger.reserve(METADATA_LIMIT);
  try {
    return await new Promise((resolve, reject) => {
      const endpoint = new URL('/meta', origin);
      let settled = false, response, timer;
      const req = client.request(endpoint, { method: 'GET', agent, headers });
      const abort = () => finish(signal.reason ?? error('ABORTED', 'Aborted'));
      const finish = (failure, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) { response?.destroy(); req.destroy(); reject(failure); } else resolve(result);
      };
      timer = setTimeout(() => finish(error('METADATA_TIMEOUT', 'Metadata deadline exceeded')), Math.max(1, Math.min(5000, timeoutMs)));
      req.on('error', cause => finish(error('NETWORK_ERROR', cause.message)));
      req.on('response', incoming => {
        response = incoming;
        const chunks = [];
        incoming.on('data', chunk => {
          if (settled) return;
          try { reservation.add('download', chunk.length); chunks.push(chunk); }
          catch (cause) { finish(cause); }
        });
        incoming.on('aborted', () => finish(error('NETWORK_ERROR', 'Truncated metadata response')));
        incoming.on('error', cause => finish(error('NETWORK_ERROR', cause.message)));
        incoming.on('end', () => {
          if (!incoming.complete) return finish(error('NETWORK_ERROR', 'Incomplete metadata response'));
          if (incoming.statusCode < 200 || incoming.statusCode >= 300) return finish(Object.assign(error('HTTP_ERROR', `Metadata HTTP ${incoming.statusCode}`), { status: incoming.statusCode, endpoint: endpoint.href }));
          if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') return finish(error('HTTP_ERROR', 'Encoded metadata response'));
          try { finish(null, normalizeMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
          catch { finish(error('METADATA_ERROR', 'Invalid metadata JSON')); }
        });
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else req.end();
    });
  } finally { reservation.close(); }
}
