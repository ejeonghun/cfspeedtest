import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createLedger, wait, createTransport } from '../src/transport.js';
import { BOOTSTRAP_URL, PROVIDER_LIMIT, RIR_BASES, validAsn, selectRegistry, referralUrl, parseAutnum, lookupProvider } from '../src/provider.js';

const bootstrap = (base = RIR_BASES[1]) => ({ version: '1.0', services: [[['4608-4865', '2043'], [base]]] });
const autnum = (name = 'REGISTERED-AS-NAME') => ({ objectClassName: 'autnum', startAutnum: 4766, endAutnum: 4766, name });
const krnicUrl = asn => `https://krnic.rdap.apnic.net/autnum/${asn}`;
const declared = text => ({ ...autnum(), remarks: [{ title: 'description', description: [text] }] });
const registrant = (label, { roles = ['registrant'], kind = 'org', property = 'org' } = {}) => ({
  objectClassName: 'entity', roles,
  vcardArray: ['vcard', [['kind', {}, 'text', kind], [property, {}, 'text', label]]],
});
const send = (res, value) => { res.setHeader('content-type', 'application/rdap+json'); res.end(JSON.stringify(value)); };
async function local(t, handler, { timeoutMs = 5000, maxBytes = 10000000 } = {}) {
  const targets = [];
  let calls = 0;
  const server = http.createServer((req, res) => handler(req, res, targets[calls], calls++));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const controller = new AbortController();
  const ledger = createLedger(maxBytes);
  const requestFactory = (url, options) => {
    targets.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['accept-encoding'], 'identity');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.referer, undefined);
    assert.equal(new URL(url).search, '');
    assert.equal(new URL(url).hash, '');
    return http.request(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, { ...options, agent: false });
  };
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { controller, ledger, targets, server, requestFactory,
    lookup: asn => lookupProvider(asn, { ledger, signal: controller.signal, timeoutMs, headers: { 'user-agent': 'cloudflare-speedtestcli/test' }, requestFactory }) };
}

test('ASN validation and IANA inclusive ranges/singletons preserve all five official base paths', () => {
  for (const base of RIR_BASES) {
    assert.equal(selectRegistry(bootstrap(base), '4766'), `${base}autnum/4766`);
    assert.equal(selectRegistry(bootstrap(base), 2043), `${base}autnum/2043`);
    assert.equal(selectRegistry(bootstrap(base), 4608), `${base}autnum/4608`);
    assert.equal(selectRegistry(bootstrap(base), 4865), `${base}autnum/4865`);
    assert.equal(selectRegistry(bootstrap(base), 4866), null);
  }
  assert.ok(validAsn(4294967295));
  for (const value of [0, -1, 4294967296, 1.2, Infinity, true, 'AS4766', '4766?ip=1', '1e3']) assert.equal(validAsn(value), false);
  assert.equal(selectRegistry({ version: '1.0', services: [[['4766'], ['http://rdap.apnic.net/', RIR_BASES[1]]]] }, 4766), `${RIR_BASES[1]}autnum/4766`);
});

test('bootstrap rejects ambiguity, malformed ranges and SSRF/credentials/ports/paths/fragments', () => {
  for (const base of ['https://evil.example/', 'https://[::1]/', 'https://localhost/', 'http://rdap.apnic.net/',
    'https://user:pass@rdap.apnic.net/', 'https://rdap.apnic.net:443/', 'https://rdap.apnic.net:444/',
    'https://rdap.apnic.net/evil/', 'https://rdap.apnic.net/?x=1', 'https://rdap.apnic.net/#x']) assert.equal(selectRegistry(bootstrap(base), 4766), null, base);
  for (const range of ['4865-4608', '-1-4766', '1.2-4766', '0-4294967296', 'garbage', '4766-']) {
    const value = bootstrap(); value.services[0][0] = [range]; assert.equal(selectRegistry(value, 4766), null, range);
  }
  assert.equal(selectRegistry({ version: '1.0', services: [[['4766'], [RIR_BASES[1]]], [['4766'], [RIR_BASES[1]]]] }, 4766), null);
  assert.equal(selectRegistry({ version: '1.0', services: [[['4766'], [RIR_BASES[1], RIR_BASES[2]]]] }, 4766), null);
  assert.equal(selectRegistry({ version: '1.0', services: [[['4766'], [RIR_BASES[1], 'https://evil.example/']]] }, 4766), null);
  for (const value of [null, {}, { version: '2.0', services: [] }, { version: '1.0', services: [{}] }]) assert.equal(selectRegistry(value, 4766), null);
});

test('RDAP parser validates autnum name/range and strips controls/bidi, never unrelated PII', () => {
  assert.equal(parseAutnum({ ...autnum('\u202eREGISTERED\u2066-AS\nNAME'), entities: [{ vcardArray: ['vcard', ['fn', {}, 'text', 'Private Person']] }], remarks: [{ description: ['Retail ISP claim'] }] }, 4766), 'REGISTERED-ASNAME');
  for (const value of [null, {}, { ...autnum(), objectClassName: 'entity' }, { ...autnum(), errorCode: 404 },
    { ...autnum(), startAutnum: 4767 }, { ...autnum(), endAutnum: 4765 }, { ...autnum(), startAutnum: '4766' },
    autnum(''), autnum('x'.repeat(161)), autnum(null)]) assert.equal(parseAutnum(value, 4766), null);
  assert.equal(parseAutnum({ ...autnum(), status: ['unannounced'] }, 4766), 'REGISTERED-AS-NAME');
});

test('KRNIC AS description requires an exact source URL, not an arbitrary registry remark', () => {
  const record = declared('Example Network Company');
  for (const source of [undefined, 'https://example.com/autnum/4766', `${RIR_BASES[1]}autnum/4766`,
    ...RIR_BASES.map(base => `${base}autnum/4766`), krnicUrl(4767), `${krnicUrl(4766)}?x=1`,
    `${krnicUrl(4766)}#x`, 'https://krnic.rdap.apnic.net:443/autnum/4766',
    'https://user@krnic.rdap.apnic.net/autnum/4766', 'http://krnic.rdap.apnic.net/autnum/4766',
    'https://evil.krnic.rdap.apnic.net/autnum/4766', krnicUrl('04766')]) {
    assert.equal(parseAutnum(record, 4766, source), 'REGISTERED-AS-NAME', String(source));
  }
  assert.equal(parseAutnum(record, '04766', krnicUrl(4766)), 'Example Network Company');
  const synthetic = { ...declared('Different Network Ltd'), startAutnum: 64500, endAutnum: 64500 };
  synthetic.remarks[0].title = ' Description ';
  assert.equal(parseAutnum(synthetic, 64500, krnicUrl(64500)), 'Different Network Ltd');
  assert.equal(parseAutnum({ ...synthetic, name: undefined }, 64500, krnicUrl(64500)), 'Different Network Ltd');
});

test('KRNIC missing, ambiguous, malformed, multiline and contact-like descriptions fall back', () => {
  for (const remarks of [undefined, {}, [], [{ title: 'other', description: ['Organization'] }],
    [{ title: 'description', description: 'Organization' }], [{ title: 'description', description: [] }],
    [{ title: 'description', description: ['Organization', 'Second line'] }],
    [{ title: 'description', description: [{ name: 'Organization' }] }],
    [{ title: 'description', description: ['Organization'] }, { title: 'DESCRIPTION', description: ['Other'] }],
    [{ title: 'description', description: ['Organization'] }, { title: 'description', description: ['Organization'] }]]) {
    assert.equal(parseAutnum({ ...autnum(), remarks }, 4766, krnicUrl(4766)), 'REGISTERED-AS-NAME');
  }
  for (const text of ['', '   ', 'x'.repeat(161), 'Organization\nAddress', 'Organization\rAddress',
    'Organization\u2028Address', 'Organization\u2029Address', '\x1b[31mOrganization', 'Organization\x00',
    'Contact user@example.com', 'https://example.com', 'www.example.com', 'Tel: +82-2-1234-5678',
    'telephone: 12345', 'phone=12345', 'Fax: 12345', 'mailto:user@example.com',
    'Address: Private location', '+82 (2) 1234-5678', '12345', '\u202e12345', 'Te\u2066l: 12345']) {
    assert.equal(parseAutnum(declared(text), 4766, krnicUrl(4766)), 'REGISTERED-AS-NAME', text);
  }
  assert.equal(parseAutnum(declared(' \u202eExample\u2066 Network '), 4766, krnicUrl(4766)), 'Example Network');
  assert.equal(parseAutnum({ ...declared('Declared Organization'), notices: [{ description: ['Private Person'] }],
    remarks: [{ title: 'other', description: ['Private Person'] }, { title: 'description', description: ['Declared Organization'] }] },
  4766, krnicUrl(4766)), 'Declared Organization');
});

test('explicit registrant organizations outrank descriptions and support org components or organizational fn', () => {
  for (const entity of [registrant('Registered Organization'), registrant(['Registered Organization', 'Department']),
    registrant('Registered Organization', { property: 'fn' })]) {
    const record = { ...declared('Description Organization'), entities: [entity] };
    assert.equal(parseAutnum(record, 4766, krnicUrl(4766)), 'Registered Organization');
    assert.equal(parseAutnum({ ...record, name: undefined }, 4766), 'Registered Organization');
  }
  const entity = registrant(' \u202eRegistered\u2066\x00 Organization ');
  entity.vcardArray[1].push(['fn', {}, 'text', 'Private Display Name'], ['email', {}, 'text', 'private@example.com'],
    ['tel', {}, 'uri', 'tel:+12345'], ['adr', {}, 'text', ['Private Address']]);
  assert.equal(parseAutnum({ ...autnum(), entities: [entity] }, 4766), 'Registered Organization');
  assert.equal(parseAutnum({ ...autnum(), entities: [registrant('Same Organization'), registrant('Same Organization')] }, 4766), 'Same Organization');
});

test('individual and nonregistrant entities never supply personal or contact labels', () => {
  for (const entity of [registrant('Private Person', { kind: 'individual', property: 'fn' }),
    registrant('ASManager', { roles: ['technical', 'administrative'], property: 'fn' }),
    registrant('Abuse Group', { roles: ['abuse'], property: 'fn' }),
    registrant('Private Person', { kind: null, property: 'fn' }),
    { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Private Person']]] },
    { ...registrant('Private Person'), roles: 'registrant' },
    { ...registrant('Private Person'), objectClassName: 'autnum' },
    { ...registrant('Private Person'), vcardArray: ['not-vcard', []] },
    registrant({ name: 'Private Person' }), registrant('x'.repeat(161))]) {
    assert.equal(parseAutnum({ ...autnum(), entities: [entity] }, 4766), 'REGISTERED-AS-NAME');
    assert.equal(parseAutnum({ ...declared('Declared Organization'), entities: [entity] }, 4766, krnicUrl(4766)), 'Declared Organization');
  }
});

test('conflicting registrant organizations fall back to registered name, never an arbitrary owner', () => {
  const conflicting = [registrant('First Organization'), registrant('Second Organization')];
  assert.equal(parseAutnum({ ...declared('Description Organization'), entities: conflicting }, 4766, krnicUrl(4766)), 'REGISTERED-AS-NAME');
  assert.equal(parseAutnum({ ...autnum(), name: undefined, entities: conflicting }, 4766), null);
  const entity = registrant('First Organization');
  entity.vcardArray[1].push(['org', {}, 'text', 'Second Organization']);
  assert.equal(parseAutnum({ ...autnum(), entities: [entity] }, 4766), 'REGISTERED-AS-NAME');
});

test('organization candidates cannot bypass autnum type, ASN, range or error validation', () => {
  const record = { ...declared('Description Organization'), entities: [registrant('Registered Organization')] };
  for (const invalid of [{ objectClassName: 'entity' }, { errorCode: 404 }, { startAutnum: 4767 },
    { endAutnum: 4765 }, { startAutnum: '4766' }, { startAutnum: -1 }, { endAutnum: 4294967296 }]) {
    assert.equal(parseAutnum({ ...record, ...invalid }, 4766, krnicUrl(4766)), null);
  }
  assert.equal(parseAutnum(record, 'AS4766', krnicUrl(4766)), null);
});

test('official same-AS referrals allow only exact RIR paths and APNIC-specific KRNIC delegation', () => {
  const from = `${RIR_BASES[1]}autnum/4766`;
  const krnic = 'https://krnic.rdap.apnic.net/autnum/4766';
  assert.equal(referralUrl(krnic, from, 4766), krnic);
  assert.equal(referralUrl(krnic, `${RIR_BASES[2]}autnum/4766`, 4766), null);
  for (const target of ['https://evil.rdap.apnic.net/autnum/4766', 'https://krnic.rdap.apnic.net/autnum/4767',
    'http://krnic.rdap.apnic.net/autnum/4766', '/autnum/4767', 'https://krnic.rdap.apnic.net:443/autnum/4766',
    'https://x@krnic.rdap.apnic.net/autnum/4766', `${krnic}?ip=1`, `${krnic}#x`, 'https://[::1]/autnum/4766']) assert.equal(referralUrl(target, from, 4766), null);
  for (const base of RIR_BASES) assert.equal(referralUrl(`${base}autnum/4766`, from, 4766), `${base}autnum/4766`);
});

test('real injected HTTP streaming follows APNIC301 to KRNIC, accounts every body, and returns only name/source', async t => {
  const bodies = [JSON.stringify(bootstrap()), 'referral body', JSON.stringify({ ...autnum(), entities: [{ private: '203.0.113.9' }] })];
  const fixture = await local(t, (req, res, target, index) => {
    assert.equal(req.headers.accept, index === 0 ? 'application/json' : 'application/rdap+json');
    if (index === 1) { res.writeHead(301, { location: 'https://krnic.rdap.apnic.net/autnum/4766' }); res.end(bodies[index]); }
    else { res.setHeader('content-type', 'application/json'); res.write(bodies[index].slice(0, 5)); setTimeout(() => res.end(bodies[index].slice(5)), 5); }
  });
  assert.deepEqual(await fixture.lookup(4766), { provider: 'REGISTERED-AS-NAME', providerSource: 'https://krnic.rdap.apnic.net/autnum/4766' });
  assert.deepEqual(fixture.targets, [BOOTSTRAP_URL, `${RIR_BASES[1]}autnum/4766`, 'https://krnic.rdap.apnic.net/autnum/4766']);
  assert.equal(fixture.ledger.bytes.download, bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0));
});

test('bootstrap redirects, unknown referrals, loops and redirect exhaustion never retry or escape guards', async t => {
  for (const mode of ['bootstrap', 'unknown', 'loop', 'limit', 'http429']) await t.test(mode, async t => {
    const fixture = await local(t, (req, res, target, index) => {
      if (!index && mode !== 'bootstrap') { send(res, bootstrap()); return; }
      if (mode === 'http429') { res.writeHead(429, { 'retry-after': '0' }); res.end('busy'); return; }
      const location = mode === 'unknown' ? 'https://evil.example/autnum/4766' : mode === 'limit'
        ? `${RIR_BASES[(index + 1) % RIR_BASES.length]}autnum/4766` : target;
      res.writeHead(302, { location }); res.end('redirect');
    });
    await assert.rejects(fixture.lookup(4766), { code: 'PROVIDER_ERROR' });
    assert.ok(fixture.targets.length <= 4);
    if (mode === 'bootstrap') assert.equal(fixture.targets.length, 1);
    if (['unknown', 'loop', 'http429'].includes(mode)) assert.equal(fixture.targets.length, 2);
    if (mode === 'limit') assert.equal(fixture.targets.length, 4);
  });
});

test('one combined deadline and global abort cover bootstrap/read/referrals and release sockets/budget', async t => {
  for (const mode of ['deadline', 'abort']) await t.test(mode, async t => {
    const fixture = await local(t, (req, res, target, index) => {
      if (!index) setTimeout(() => send(res, bootstrap()), 10);
    }, { timeoutMs: mode === 'deadline' ? 30 : 5000 });
    const pending = fixture.lookup(4766);
    if (mode === 'abort') setTimeout(() => fixture.controller.abort(Object.assign(new Error('global timeout'), { code: 'TIMEOUT' })), 25);
    await assert.rejects(pending, { code: mode === 'deadline' ? 'PROVIDER_TIMEOUT' : 'TIMEOUT' });
    await wait(20);
    assert.equal(await new Promise((resolve, reject) => fixture.server.getConnections((error, count) => error ? reject(error) : resolve(count))), 0);
    const reservation = fixture.ledger.reserve(9000000); reservation.close();
    assert.equal(fixture.targets.length, 2);
  });
});

test('decoded body cap, reserve before GET, encoding/truncation/media/JSON errors are bounded failures', async t => {
  const budget = await local(t, () => {}, { maxBytes: PROVIDER_LIMIT - 1 });
  await assert.rejects(budget.lookup(4766), { code: 'BYTE_LIMIT' }); assert.equal(budget.targets.length, 0);
  for (const mode of ['oversized', 'encoding', 'truncated', 'media', 'json']) await t.test(mode, async t => {
    const fixture = await local(t, (req, res) => {
      res.setHeader('content-type', mode === 'media' ? 'text/plain' : 'application/json');
      if (mode === 'oversized') res.end('x'.repeat(PROVIDER_LIMIT + 1000));
      if (mode === 'encoding') { res.setHeader('content-encoding', 'gzip'); res.end('{}'); }
      if (mode === 'truncated') { res.setHeader('content-length', 50); res.write('{}'); setTimeout(() => res.destroy(), 5); }
      if (mode === 'media') res.end(JSON.stringify(bootstrap()));
      if (mode === 'json') res.end('invalid');
    });
    await assert.rejects(fixture.lookup(4766), { code: mode === 'oversized' ? 'BYTE_LIMIT' : mode === 'truncated' ? 'NETWORK_ERROR' : 'PROVIDER_ERROR' });
    assert.equal(fixture.targets.length, 1);
    assert.ok(fixture.ledger.bytes.download > 0);
    if (mode === 'oversized') assert.ok(fixture.ledger.bytes.download > PROVIDER_LIMIT && fixture.ledger.bytes.download <= PROVIDER_LIMIT + 1000);
  });
});

test('transport provider capability uses injected client only and shares the body ledger', async t => {
  const fixture = await local(t, (req, res, target) => send(res, target === BOOTSTRAP_URL ? bootstrap() : autnum()));
  const transport = createTransport({ ledger: fixture.ledger, signal: fixture.controller.signal, _providerRequestFactory: fixture.requestFactory });
  t.after(() => transport.close());
  assert.equal((await transport.getProvider('4766')).providerSource, `${RIR_BASES[1]}autnum/4766`);
  assert.equal(fixture.targets.length, 2);
  assert.ok(fixture.ledger.bytes.download > 0);
});

test('verified sanitized KRNIC golden selects declared organization only with actual source', async t => {
  const record = JSON.parse(readFileSync(new URL('./fixtures/provider/krnic-autnum-4766.json', import.meta.url), 'utf8'));
  assert.equal(parseAutnum(record, 4766), 'KIXS-AS-KR-KR');
  assert.equal(parseAutnum(record, 4766, krnicUrl(4766)), 'Korea Telecom');
  const fixture = await local(t, (req, res, target, index) => {
    if (index === 0) send(res, bootstrap());
    else if (index === 1) { res.writeHead(301, { location: 'https://krnic.rdap.apnic.net/autnum/4766' }); res.end(); }
    else send(res, record);
  });
  assert.deepEqual(await fixture.lookup(4766), {
    provider: 'Korea Telecom', providerSource: 'https://krnic.rdap.apnic.net/autnum/4766',
  });
});
