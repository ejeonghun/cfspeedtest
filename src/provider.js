// ASN-only registry lookup: RFC 9224 bootstrap, RFC 9082 autnum URLs,
// RFC 9083 autnum/registrant organization fields and a source-bound KRNIC
// declared AS description. No IP lookup, contact labels, or persistent cache.
export const BOOTSTRAP_URL = 'https://data.iana.org/rdap/asn.json';
export const PROVIDER_LIMIT = 131072;
export const RIR_BASES = Object.freeze([
  'https://rdap.afrinic.net/rdap/', 'https://rdap.apnic.net/',
  'https://rdap.arin.net/registry/', 'https://rdap.db.ripe.net/', 'https://rdap.lacnic.net/rdap/',
]);
const failure = (code, message) => Object.assign(new Error(message), { code });
export function validAsn(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^\d{1,10}$/.test(value))
    && Number(value) > 0 && Number(value) <= 4294967295;
}
function exactHttps(value, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}
export function selectRegistry(bootstrap, asn) {
  if (!validAsn(asn) || bootstrap?.version !== '1.0' || !Array.isArray(bootstrap.services)) return null;
  const matches = [];
  for (const service of bootstrap.services) {
    if (!Array.isArray(service) || service.length !== 2 || !Array.isArray(service[0]) || !service[0].length || !Array.isArray(service[1]) || !service[1].length) return null;
    let covers = false;
    for (const range of service[0]) {
      if (typeof range !== 'string' || !/^\d+(?:-\d+)?$/.test(range)) return null;
      const [start, end = start] = range.split('-').map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > 4294967295 || start > end) return null;
      if (Number(asn) >= start && Number(asn) <= end) covers = true;
    }
    if (service[1].some(url => typeof url !== 'string')) return null;
    if (covers) {
      if (service[1].some(url => !RIR_BASES.includes(url) && !RIR_BASES.map(base => base.replace('https:', 'http:')).includes(url))) return null;
      const bases = [...new Set(service[1].filter(url => exactHttps(url, RIR_BASES)))];
      if (bases.length !== 1) return null;
      matches.push(bases[0]);
    }
  }
  return matches.length === 1 ? `${matches[0]}autnum/${Number(asn)}` : null;
}
export function referralUrl(location, from, asn) {
  if (!validAsn(asn) || typeof location !== 'string') return null;
  const allowed = RIR_BASES.map(base => `${base}autnum/${Number(asn)}`);
  if (from === `https://rdap.apnic.net/autnum/${Number(asn)}`) allowed.push(`https://krnic.rdap.apnic.net/autnum/${Number(asn)}`);
  return exactHttps(location, allowed) ? location : null;
}
function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return label && label.length <= 160 ? label : null;
}
function registrantOrganizations(entities) {
  const candidates = new Set();
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)
        || (entity.objectClassName !== undefined && entity.objectClassName !== 'entity')
        || !Array.isArray(entity.roles) || !entity.roles.includes('registrant')
        || !Array.isArray(entity.vcardArray) || entity.vcardArray.length !== 2
        || entity.vcardArray[0] !== 'vcard' || !Array.isArray(entity.vcardArray[1])) continue;
    const properties = entity.vcardArray[1].filter(property => Array.isArray(property) && property.length === 4
      && typeof property[0] === 'string' && property[1] && typeof property[1] === 'object'
      && !Array.isArray(property[1]) && property[2] === 'text');
    const kinds = properties.filter(property => property[0] === 'kind');
    if (kinds.length !== 1 || kinds[0][3] !== 'org') continue;
    const organizations = properties.filter(property => property[0] === 'org')
      .map(property => cleanLabel(Array.isArray(property[3]) ? property[3][0] : property[3])).filter(Boolean);
    const labels = organizations.length ? organizations
      : properties.filter(property => property[0] === 'fn').map(property => cleanLabel(property[3])).filter(Boolean);
    for (const label of labels) candidates.add(label);
  }
  return candidates;
}
function krnicDescription(value, asn, sourceUrl) {
  // This exact mirror schema declares the AS description, not arbitrary RIR remarks.
  if (sourceUrl !== `https://krnic.rdap.apnic.net/autnum/${Number(asn)}` || !Array.isArray(value.remarks)) return null;
  const descriptions = value.remarks.filter(remark => typeof remark?.title === 'string' && remark.title.trim().toLowerCase() === 'description');
  if (descriptions.length !== 1 || !Array.isArray(descriptions[0].description)
      || descriptions[0].description.length !== 1 || typeof descriptions[0].description[0] !== 'string') return null;
  const raw = descriptions[0].description[0];
  const label = cleanLabel(raw);
  if (!label || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(raw)
      || /\S+@\S+|\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:mailto|tel|telephone|phone|fax|email|e-mail|address)\s*[:=]/i.test(label)
      || (/\d/.test(label) && /^[+\d\s()./-]+$/.test(label))) return null;
  return label;
}
export function parseAutnum(value, asn, sourceUrl) {
  if (!validAsn(asn) || !value || typeof value !== 'object' || Array.isArray(value) || value.objectClassName !== 'autnum'
      || Object.hasOwn(value, 'errorCode') || !Number.isSafeInteger(value.startAutnum) || !Number.isSafeInteger(value.endAutnum)
      || value.startAutnum < 0 || value.endAutnum > 4294967295 || value.startAutnum > Number(asn) || value.endAutnum < Number(asn)) return null;
  const organizations = registrantOrganizations(value.entities);
  if (organizations.size === 1) return organizations.values().next().value;
  if (organizations.size > 1) return cleanLabel(value.name);
  return krnicDescription(value, asn, sourceUrl) ?? cleanLabel(value.name);
}

export async function lookupProvider(asn, { client, agent, headers, ledger, signal, timeoutMs = 5000, requestFactory } = {}) {
  if (!validAsn(asn)) throw failure('PROVIDER_ERROR', 'Invalid ASN for registry lookup');
  if (signal?.aborted) throw signal.reason ?? failure('ABORTED', 'Aborted');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? failure('ABORTED', 'Aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(failure('PROVIDER_TIMEOUT', 'ASN registry lookup deadline exceeded')), Math.max(1, Math.min(5000, timeoutMs)));
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  async function get(url, bootstrap = false) {
    check();
    // URLs are fixed or selected from the explicit registry allowlist above.
    const reservation = ledger.reserve(PROVIDER_LIMIT);
    try {
      return await new Promise((resolve, reject) => {
        let response, settled = false;
        const options = { method: 'GET', agent, headers: { 'user-agent': headers['user-agent'], 'accept-encoding': 'identity', accept: bootstrap ? 'application/json' : 'application/rdap+json' } };
        const req = requestFactory ? requestFactory(url, options) : client.request(url, options);
        const onAbort = () => finish(controller.signal.reason);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', onAbort);
          if (error) { response?.destroy(); req.destroy(); reject(error); } else resolve(value);
        };
        req.on('error', error => finish(failure('NETWORK_ERROR', error.message)));
        req.on('response', incoming => {
          response = incoming;
          const chunks = [];
          incoming.on('data', chunk => {
            if (settled) return;
            try { reservation.add('download', chunk.length); chunks.push(chunk); } catch (error) { finish(error); }
          });
          incoming.on('aborted', () => finish(failure('NETWORK_ERROR', 'Truncated registry response')));
          incoming.on('error', error => finish(failure('NETWORK_ERROR', error.message)));
          incoming.on('end', () => {
            if (!incoming.complete) return finish(failure('NETWORK_ERROR', 'Incomplete registry response'));
            if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') return finish(failure('PROVIDER_ERROR', 'Encoded registry response'));
            const body = Buffer.concat(chunks).toString('utf8');
            const type = String(incoming.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            finish(null, { status: incoming.statusCode, location: incoming.headers.location, body, type });
          });
        });
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort(); else req.end();
      });
    } finally { reservation.close(); }
  }
  function json(response) {
    if (response.status !== 200 || !['application/json', 'application/rdap+json'].includes(response.type)) throw failure('PROVIDER_ERROR', `Registry HTTP ${response.status} or invalid JSON media type`);
    try { return JSON.parse(response.body); } catch { throw failure('PROVIDER_ERROR', 'Invalid registry JSON'); }
  }
  try {
    let url = selectRegistry(json(await get(BOOTSTRAP_URL, true)), asn);
    check();
    if (!url) throw failure('PROVIDER_ERROR', 'No unambiguous allowed ASN registry in bootstrap');
    const visited = new Set();
    for (let redirects = 0; ; redirects++) {
      check();
      visited.add(url);
      const response = await get(url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = redirects < 2 ? referralUrl(response.location, url, asn) : null;
        if (!next || visited.has(next)) throw failure('PROVIDER_ERROR', 'Refused or exhausted official registry referral');
        url = next;
        continue;
      }
      const provider = parseAutnum(json(response), asn, url);
      check();
      if (!provider) throw failure('PROVIDER_ERROR', 'No valid ASN organization or registered name in registry response');
      return { provider, providerSource: url };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort(failure('ABORTED', 'Registry lookup ended'));
  }
}
