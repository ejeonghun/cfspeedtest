import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runCli } from '../src/cli.js';

const result = {
  schemaVersion: 1,
  profile: 'default',
  startedAt: '2026-10-04T00:00:00.000Z',
  durationMs: 2500,
  server: { colo: 'SJC', country: 'US' },
  downloadMbps: 123.456,
  uploadMbps: 45.67,
  latencyMs: 12,
  jitterMs: 1.25,
  downloadLoadedLatencyMs: 23,
  downloadLoadedJitterMs: 2,
  uploadLoadedLatencyMs: null,
  uploadLoadedJitterMs: null,
  packetLoss: null,
  packetLossReason: 'Requires WebRTC/TURN.',
  bytes: { download: 12000000, upload: 6100000 },
  measurement: { reference: 'Cloudflare endpoints', transport: 'HTTP' },
  warnings: [],
};

function setup(overrides = {}) {
  const output = { stdout: '', stderr: '' };
  const emitter = new EventEmitter();
  const dependencies = {
    stdout: { write: (text) => { output.stdout += text; } },
    stderr: { write: (text) => { output.stderr += text; } },
    signalEmitter: emitter,
    env: {},
    engine: async () => structuredClone(result),
    ...overrides,
  };
  return { output, emitter, dependencies, run: (args = []) => runCli(args, dependencies) };
}

function assertClean(emitter) {
  assert.equal(emitter.listenerCount('SIGINT'), 0);
  assert.equal(emitter.listenerCount('SIGTERM'), 0);
}

test('help and version never load or initialize the engine', async () => {
  for (const flag of ['--help', '-h', '--version', '-v']) {
    const cli = setup({ engine: undefined, loadEngine: () => { assert.fail('Engine imported'); }, version: '9.8.7' });
    assert.equal(await cli.run([flag]), 0);
    assert.equal(cli.output.stderr, '');
    assert.match(cli.output.stdout, flag.includes('help') || flag === '-h' ? /^Usage: cfspeedtest \[options\]\n/ : /^9\.8\.7\n$/);
    assertClean(cli.emitter);
  }
});

test('defaults and valid options map to the engine without startup notices', async () => {
  for (const [args, expected] of [
    [[], { profile: 'default', timeoutMs: 300000 }],
    [['--quick', '--timeout', '1.5', '--max-bytes', '1234'], { profile: 'quick', timeoutMs: 1500, maxBytes: 1234 }],
    [['--timeout=3600', '--max-bytes=9007199254740991'], { profile: 'default', timeoutMs: 3600000, maxBytes: Number.MAX_SAFE_INTEGER }],
    [['--full'], { profile: 'full', timeoutMs: 300000 }],
    [['--full', '--full', '--timeout', '10', '--max-bytes', '1000'], { profile: 'full', timeoutMs: 10000, maxBytes: 1000 }],
  ]) {
    const cli = setup({ engine: async (options) => {
      assert.deepEqual({ profile: options.profile, timeoutMs: options.timeoutMs, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }, expected);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(typeof options.onProgress, 'function');
      assert.equal(Object.hasOwn(options, 'providerLookup'), false);
      assert.equal(Object.hasOwn(options, 'verbose'), false);
      assert.equal(cli.output.stderr, '');
      return { ...result, profile: options.profile };
    } });
    assert.equal(await cli.run(args), 0);
    assert.equal(cli.output.stderr, '');
    assertClean(cli.emitter);
  }
});

test('invalid options are rejected before importing the engine or installing listeners', async (t) => {
  const invalid = [
    ['--unknown'], ['positional'], ['--'], ['--help', '--bad'], ['--quick=true'],
    ['--timeout'], ['--timeout', '--json'], ['--timeout='], ['--timeout', '0'],
    ['--timeout', '-1'], ['--timeout', 'NaN'], ['--timeout', 'Infinity'],
    ['--timeout', '3600.1'], ['--timeout', '1s'], ['--timeout', ' '], ['--timeout', '1e-999'],
    ['--max-bytes'], ['--max-bytes', '0'], ['--max-bytes', '-1'], ['--max-bytes', '1.1'],
    ['--max-bytes', '1e3'], ['--max-bytes', '9007199254740992'], ['--max-bytes', 'Infinity'],
    ['--color'], ['--color='], ['--color', 'yes'], ['--color', 'AUTO'],
    ['--full=true'],
    ['--verbose=true'], ['--verbose=false'], ['--verbose='], ['--verbose', 'true'],
    ['--verbose', 'false'], ['--verbose', '--timeout=bad'], ['--verboses'], ['-V'],
    ['--no-provider-lookup=true'], ['--no-provider-lookup=false'], ['--no-provider-lookup='],
    ['--no-provider-lookup', 'false'], ['--no-provider-lookups'],
  ];
  for (const args of invalid) await t.test(JSON.stringify(args), async () => {
    const cli = setup({ engine: undefined, loadEngine: () => { assert.fail('Engine imported'); } });
    assert.equal(await cli.run(args), 1);
    assert.equal(cli.output.stdout, '');
    assert.match(cli.output.stderr, /^Error: /);
    assert.match(cli.output.stderr, /\nRun cfspeedtest --help for usage\.\n$/);
    assertClean(cli.emitter);
  });
});

test('quick and full are mutually exclusive in either order before engine import or listeners', async () => {
  for (const args of [
    ['--quick', '--full'], ['--full', '--quick'],
    ['--quick', '--json', '--full'], ['--full', '--full', '--quick'],
    ['--help', '--quick', '--full'], ['--version', '--full', '--quick'],
  ]) {
    const cli = setup({ engine: undefined, loadEngine: () => { assert.fail('Engine imported'); } });
    assert.equal(await cli.run(args), 1);
    assert.equal(cli.output.stdout, '');
    assert.match(cli.output.stderr, /--quick and --full cannot be combined/);
    assert.ok(!cli.output.stderr.includes('main payload'));
    assertClean(cli.emitter);
  }
});

test('help distinguishes conservative default CLI cap, quick and opt-in full traffic', async () => {
  const cli = setup({ engine: undefined, loadEngine: () => { assert.fail('Engine imported'); } });
  assert.equal(await cli.run(['--help']), 0);
  for (const text of ['315.8 MB', '25 MB', 'conservative CLI software cap, not a Cloudflare maximum', '--full', '1.266 GB', '--quick', '18.1 MB', 'HTTP 403', 'partial measurements', '--color <mode>', '--verbose', 'Detailed results, warnings and data usage', 'Latency is HTTP, not ICMP', 'Location is approximate IP geolocation']) {
    assert.ok(cli.output.stdout.includes(text), text);
  }
  assert.equal(cli.output.stderr, '');
});

test('provider lookup opt-out dispatches false for normal, quick, full and JSON runs', async () => {
  for (const [args, profile] of [
    [['--no-provider-lookup'], 'default'],
    [['--quick', '--no-provider-lookup'], 'quick'],
    [['--no-provider-lookup', '--full'], 'full'],
    [['--json', '--no-provider-lookup', '--no-provider-lookup'], 'default'],
    [['--full', '--no-provider-lookup', '--json'], 'full'],
  ]) {
    const cli = setup({ engine: async (options) => {
      assert.equal(options.providerLookup, false);
      assert.equal(options.profile, profile);
      return { ...result, profile };
    } });
    assert.equal(await cli.run(args), 0);
    assertClean(cli.emitter);
  }
});

test('provider lookup help explains the ASN-only query and ordinary source IP exposure without importing engine', async () => {
  const cli = setup({ engine: undefined, loadEngine: () => { assert.fail('Engine imported'); } });
  assert.equal(await cli.run(['--help', '--no-provider-lookup']), 0);
  for (const text of ['--no-provider-lookup', 'public ASN registration (RDAP)', 'Only the AS number is queried, not your IP, city, or coordinates', 'ordinary HTTPS source IP', 'Cloudflare-provided ASN, provider and location remain when available', 'registry name, not a verified retail ISP']) {
    assert.ok(cli.output.stdout.includes(text), text);
  }
  assert.equal(cli.output.stderr, '');
  assertClean(cli.emitter);
});

test('JSON preserves provider provenance without adding ANSI or changing metadata', async () => {
  for (const optOut of [false, true]) {
    const network = {
      asn: 123, provider: optOut ? null : 'Example registered name', city: '東京', region: null,
      country: '日本', countryCode: 'JP', source: 'Cloudflare/meta',
      providerSource: optOut ? null : 'RIR/RDAP',
    };
    const complete = { ...result, network };
    const cli = interactive({ engine: async (options) => {
      assert.equal(Object.hasOwn(options, 'providerLookup'), optOut);
      if (optOut) assert.equal(options.providerLookup, false);
      options.onProgress({ phase: 'metadata', network });
      return complete;
    } });
    assert.equal(await cli.run(['--json', '--color=always', ...(optOut ? ['--no-provider-lookup'] : [])]), 0);
    assert.equal(cli.output.stdout, JSON.stringify(complete) + '\n');
    assert.deepEqual(JSON.parse(cli.output.stdout).network, network);
    assert.equal(cli.output.stderr, '');
  }
});

test('opt-out retains provided Cloudflare network fields and missing fields remain unavailable', async () => {
  for (const network of [
    { asn: 123, provider: 'Reported organization', city: '東京', country: '日本', providerSource: 'Cloudflare/meta' },
    { asn: 123, provider: null, city: null, country: null, providerSource: null },
  ]) {
    const cli = interactive({ engine: async ({ providerLookup }) => {
      assert.equal(providerLookup, false);
      return { ...result, network };
    } });
    assert.equal(await cli.run(['--no-provider-lookup', '--color=never']), 0);
    assert.match(cli.output.stdout, /AS123/);
    assert.ok(cli.output.stdout.includes(network.provider || 'unavailable'));
    if (network.city) assert.ok(cli.output.stdout.includes('東京, 日本'));
    assert.doesNotMatch(cli.output.stdout, /reported AS organization|not a verified retail ISP/);
    assertClean(cli.emitter);
  }
});

test('full JSON dispatch stays clean and preserves the full profile in the result', async () => {
  const complete = { ...result, profile: 'full' };
  const cli = interactive({ engine: async ({ profile, onProgress }) => {
    assert.equal(profile, 'full');
    onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 42 });
    return complete;
  } });
  assert.equal(await cli.run(['--full', '--json', '--color=always']), 0);
  assert.equal(cli.output.stdout, JSON.stringify(complete) + '\n');
  assert.equal(cli.output.stderr, '');
  assertClean(cli.emitter);
});

test('full HTTP 403 is not retried and remains an error with details and partial measurements', async () => {
  let calls = 0;
  const cli = setup({ engine: async ({ profile }) => {
    calls += 1;
    assert.equal(profile, 'full');
    throw Object.assign(new Error('Large request rejected'), {
      code: 'HTTP_ERROR', status: 403, direction: 'download', requestedBytes: 100000000,
      endpoint: 'https://example.test/download', partialResult: { ...result, profile: 'full' },
    });
  } });
  assert.equal(await cli.run(['--full']), 1);
  assert.equal(calls, 1);
  assert.equal(cli.output.stdout, '');
  for (const text of ['HTTP 403', 'Large request rejected', 'download', 'https://example.test/download', '100000000 requested bytes', 'Last known measurements', '123.46 Mbps']) assert.ok(cli.output.stderr.includes(text), text);
  assert.doesNotMatch(cli.output.stderr, /Warning:|main payload|Packet loss|Loaded.*unavailable/i);
  assertClean(cli.emitter);
});

test('JSON stdout is exactly one intact object, including nulls; progress is suppressed', async () => {
  const complete = { ...result, warnings: ['A measurement was unavailable.'] };
  const cli = setup({ engine: async ({ onProgress }) => {
    onProgress({ phase: 'download', completed: 1, total: 2, bytes: { download: 1000, upload: 0 } });
    return complete;
  } });
  assert.equal(await cli.run(['--json']), 0);
  assert.equal(cli.output.stdout, `${JSON.stringify(complete)}\n`);
  assert.deepEqual(JSON.parse(cli.output.stdout), complete);
  assert.equal(cli.output.stderr, '');
  assertClean(cli.emitter);
});

test('default human output is concise and leaves stderr empty even with nonfatal warnings', async () => {
  const cli = setup({ engine: async () => ({ ...result, warnings: ['Metadata HTTP 403; unavailable.', 'Static diagnostic warning.'] }) });
  assert.equal(await cli.run(), 0);
  for (const text of ['Download', 'Upload', '123.46 Mbps', '45.67 Mbps', 'HTTP', 'Jitter', '12.00 ms', '1.25 ms', 'SJC']) {
    assert.ok(cli.output.stdout.includes(text), text);
  }
  assert.doesNotMatch(cli.output.stdout, /Warning:|Usage|Packet loss|reported AS organization|approximate IP geolocation|loaded|main payload|WebRTC|not ICMP/i);
  assert.equal(cli.output.stderr, '');
  assert.ok(!cli.output.stdout.includes('\u001b'));
});

test('verbose human output retains rich rows, startup traffic notices and sanitized warnings', async () => {
  for (const [profile, flags, notice] of [
    ['default', [], /315\.8 MB.*CLI software cap: 25 MB.*not a Cloudflare maximum.*--quick/],
    ['quick', ['--quick'], /18\.1 MB.*reply overhead/],
    ['full', ['--full'], /1\.266 GB.*HTTP 403.*partial measurements/],
  ]) {
    const cli = setup({ engine: async (options) => {
      assert.equal(options.profile, profile);
      assert.equal(options.timeoutMs, 300000);
      assert.equal(Object.hasOwn(options, 'verbose'), false);
      assert.match(cli.output.stderr, notice);
      return { ...result, profile, warnings: ['Metadata HTTP 403; unavailable.\u001b[31m'] };
    } });
    assert.equal(await cli.run([...flags, '--verbose', '--verbose']), 0);
    assert.match(cli.output.stderr, /Warning: Metadata HTTP 403; unavailable/);
    assert.ok(!cli.output.stderr.includes('\u001b'));
    assert.match(cli.output.stdout, /Download loaded \/ jitter/);
    assert.match(cli.output.stdout, /Packet loss: unavailable/);
    assertClean(cli.emitter);
  }
  const cli = setup();
  assert.equal(await cli.run(['--verbose']), 0);
  for (const text of ['123.46 Mbps', '45.67 Mbps', 'HTTP latency (not ICMP)', 'Idle latency / jitter', 'Download loaded / jitter', 'Upload loaded / jitter', 'unavailable / unavailable', 'SJC / US', '18.10 MB total', '2.50 s', 'Packet loss: unavailable (requires WebRTC/TURN).']) {
    assert.ok(cli.output.stdout.includes(text), text);
  }
  assert.ok(!cli.output.stdout.includes('\u001b'));
  const withoutServer = setup({ engine: async () => ({ ...result, server: {} }) });
  await withoutServer.run(['--verbose']);
  assert.ok(!withoutServer.output.stdout.includes('Server:'));
});

test('pipes have no accumulating progress logs', async () => {
  let time = 0;
  const cli = setup({ now: () => time, engine: async ({ onProgress }) => {
    const progress = { phase: 'download', completed: 1, total: 3, bytes: { download: 1000, upload: 0 } };
    onProgress(progress);
    time = 100;
    onProgress(progress);
    time = 500;
    onProgress({ ...progress, completed: 2 });
    onProgress({ ...progress, phase: 'upload' });
    return result;
  } });
  await cli.run(['--json']);
  assert.equal((cli.output.stderr.match(/Measuring download/g) ?? []).length, 0);
  assert.equal((cli.output.stderr.match(/Measuring upload/g) ?? []).length, 0);
  assert.equal(cli.output.stderr, '');
  assert.ok(!/[\r\u001b]/.test(cli.output.stderr));
});

function interactive(overrides = {}) {
  const cli = setup(overrides);
  cli.dependencies.stdout.isTTY = true;
  cli.dependencies.stderr.isTTY = true;
  cli.dependencies.stderr.columns = 80;
  return cli;
}

test('TTY dashboard updates rates and metadata in place and clears before final results', async () => {
  let time = 0;
  const cli = interactive({ now: () => time, engine: async ({ onProgress }) => {
    onProgress({ phase: 'metadata', network: { asn: 13335, provider: 'Example Network', city: 'Example City', country: 'US' }, server: { colo: 'SJC' } });
    time = 200;
    onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 12.34 });
    time = 400;
    onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 56.78 });
    return { ...result, network: { asn: 13335, provider: 'Example Network', city: 'Example City', country: 'US' } };
  } });
  assert.equal(await cli.run(), 0);
  assert.match(cli.output.stderr, /12\.34 Mbps \(live\)/);
  assert.match(cli.output.stderr, /56\.78 Mbps \(live\)/);
  assert.match(cli.output.stderr, /AS13335/);
  assert.match(cli.output.stderr, /Example Network/);
  assert.match(cli.output.stderr, /Example City/);
  assert.match(cli.output.stderr, /\u001b\[2K/);
  assert.ok(cli.output.stderr.endsWith('\u001b[?25h'));
  assert.match(cli.output.stdout, /\u001b\[36m.*Download/);
  assert.doesNotMatch(cli.output.stdout + cli.output.stderr, /reported AS organization|approximate IP geolocation|Packet loss|Usage|loaded|main payload/i);
  assertClean(cli.emitter);
});

test('color flags, NO_COLOR and TERM=dumb are respected and never color a pipe', async () => {
  for (const [args, env, colored, dashboard] of [
    [[], {}, true, true],
    [['--color=always'], {}, true, true],
    [['--color', 'auto'], {}, true, true],
    [['--color', 'never'], {}, false, true],
    [['--color=always'], { NO_COLOR: '' }, false, true],
    [['--verbose', '--color=always'], { NO_COLOR: '' }, false, true],
    [[], { TERM: 'dumb' }, false, false],
  ]) {
    const cli = interactive({ env });
    assert.equal(await cli.run(args), 0);
    assert.equal(/\u001b\[\d+m/.test(cli.output.stdout), colored);
    assert.equal(cli.output.stderr.includes('\u001b[?25l'), dashboard);
  }
  const piped = setup();
  piped.dependencies.stderr.isTTY = true;
  await piped.run(['--color=always']);
  assert.ok(!piped.output.stdout.includes('\u001b'));
  assert.ok(!piped.output.stderr.includes('\u001b'));
});

test('JSON disables dashboard and all color even on TTY with color always', async () => {
  const cli = interactive({ engine: async ({ onProgress }) => {
    onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 12 });
    return result;
  } });
  assert.equal(await cli.run(['--json', '--color=always']), 0);
  assert.equal(cli.output.stdout, JSON.stringify(result) + '\n');
  assert.equal(cli.output.stderr, '');
});

test('verbose JSON preserves the original schema and warnings with notices only on stderr', async () => {
  const complete = {
    ...result,
    warnings: ['Metadata HTTP 403; using headers.', 'Static warning.\u001b[31m'],
    network: { asn: 123, provider: 'Registered AS', providerSource: 'https://rdap.example.test/autnum/123' },
  };
  for (const tty of [false, true]) {
    const cli = (tty ? interactive : setup)({ engine: async (options) => {
      assert.equal(Object.hasOwn(options, 'verbose'), false);
      options.onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 12 });
      return complete;
    } });
    assert.equal(await cli.run(['--verbose', '--json', '--color=always']), 0);
    assert.equal(cli.output.stdout, JSON.stringify(complete) + '\n');
    assert.deepEqual(JSON.parse(cli.output.stdout), complete);
    assert.match(cli.output.stderr, /315\.8 MB/);
    assert.match(cli.output.stderr, /Warning: Metadata HTTP 403; using headers/);
    assert.match(cli.output.stderr, /Warning: Static warning/);
    assert.ok(!cli.output.stderr.includes('\u001b'));
    assertClean(cli.emitter);
  }
});

test('verbose TTY dashboard opts into rich rows and still restores the cursor', async () => {
  const cli = interactive({ engine: async ({ onProgress }) => {
    onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 12 });
    return result;
  } });
  assert.equal(await cli.run(['--verbose', '--color=never']), 0);
  assert.match(cli.output.stderr, /315\.8 MB/);
  assert.match(cli.output.stderr, /Provider = AS organization \/ registry name/);
  assert.match(cli.output.stderr, /Usage|Payload/i);
  assert.match(cli.output.stdout, /Download loaded \/ jitter/);
  assert.ok(cli.output.stderr.endsWith('\u001b[?25h'));
  assertClean(cli.emitter);
});

test('partial pipe results honor verbosity without concealing fatal HTTP details', async () => {
  for (const verbose of [false, true]) {
    const cli = setup({ engine: async () => {
      throw Object.assign(new Error('Denied body: 0'), {
        code: 'HTTP_ERROR', status: 403, direction: 'upload', requestedBytes: 50000000,
        endpoint: 'https://example.test/upload', partialResult: result,
      });
    } });
    assert.equal(await cli.run(verbose ? ['--verbose'] : []), 1);
    assert.equal(cli.output.stdout, '');
    for (const text of ['Denied body: 0', 'HTTP 403', 'upload', '50000000 requested bytes', 'https://example.test/upload', 'Last known measurements', '123.46 Mbps']) {
      assert.ok(cli.output.stderr.includes(text), text);
    }
    assert.equal(/Download loaded \/ jitter/.test(cli.output.stderr), verbose);
    assert.equal(/Packet loss/.test(cli.output.stderr), verbose);
    assertClean(cli.emitter);
  }
});

test('HTTP errors retain actual message, status, direction, request and endpoint; useful values survive', async () => {
  for (const tty of [false, true]) {
    const cli = (tty ? interactive : setup)({ engine: async ({ onProgress }) => {
      onProgress({ phase: 'download', downloadMbps: 42, server: { colo: 'SJC' } });
      throw Object.assign(new Error('Request rejected by endpoint'), {
        code: 'HTTP_ERROR', status: 403, direction: 'upload', requestedBytes: 1000,
        endpoint: 'https://example.test/upload', partialResult: { ...result, downloadMbps: 42 },
      });
    } });
    assert.equal(await cli.run(), 1);
    assert.equal(cli.output.stdout, '');
    for (const text of ['Request rejected by endpoint', 'HTTP 403', 'upload', '1000 requested bytes', 'https://example.test/upload', '42.00 Mbps', 'Retry with --quick']) assert.ok(cli.output.stderr.includes(text), text);
    if (tty) assert.ok(cli.output.stderr.includes('\u001b[?25h'));
    assertClean(cli.emitter);
  }
  const json = interactive({ engine: async () => { throw Object.assign(new Error('Budget exhausted before upload'), { code: 'BYTE_LIMIT', partialResult: result }); } });
  assert.equal(await json.run(['--json']), 1);
  assert.equal(json.output.stdout, '');
  assert.match(json.output.stderr, /Budget exhausted before upload/);
  assert.match(json.output.stderr, /increase --max-bytes/);
  assert.ok(!json.output.stderr.includes('\u001b'));
});

test('TTY cursor is restored on failures, import errors, SIGINT and SIGTERM', async () => {
  for (const cause of ['failure', 'import', 'SIGINT', 'SIGTERM']) {
    const cli = interactive();
    if (cause === 'import') {
      cli.dependencies.engine = undefined;
      cli.dependencies.loadEngine = async () => { throw new Error('Import failed'); };
    } else cli.dependencies.engine = async ({ onProgress }) => {
      onProgress({ phase: 'download', liveDirection: 'download', liveMbps: 9 });
      if (cause === 'failure') throw new Error('Failed');
      cli.emitter.emit(cause);
      return new Promise(() => {});
    };
    assert.equal(await cli.run(), cause === 'SIGINT' ? 130 : cause === 'SIGTERM' ? 143 : 1);
    assert.equal((cli.output.stderr.match(/\u001b\[\?25l/g) ?? []).length, 1);
    assert.equal((cli.output.stderr.match(/\u001b\[\?25h/g) ?? []).length, 1);
    assert.ok(cli.output.stderr.indexOf('\u001b[?25h') < cli.output.stderr.lastIndexOf('Error:'));
    assertClean(cli.emitter);
  }
});

test('engine errors and deferred import failures have nonzero status and no JSON stdout', async () => {
  for (const code of ['ABORTED', 'TIMEOUT', 'BYTE_LIMIT', 'HTTP_ERROR', 'NETWORK_ERROR', 'OTHER']) {
    const cli = setup({ engine: async () => { throw Object.assign(new Error('Useful failure'), { code }); } });
    assert.equal(await cli.run(['--json']), 1);
    assert.equal(cli.output.stdout, '');
    assert.match(cli.output.stderr, /Error: /);
    assert.ok(!cli.output.stderr.includes('at runCli'));
    assertClean(cli.emitter);
  }
  const cli = setup({ engine: undefined, loadEngine: async () => { throw new Error('Import failed'); } });
  assert.equal(await cli.run(['--json']), 1);
  assert.match(cli.output.stderr, /Import failed/);
  assertClean(cli.emitter);
});

test('default engine loader is deferred and called exactly once for a run', async () => {
  let imports = 0;
  const cli = setup({ engine: undefined, loadEngine: async () => {
    imports += 1;
    return { runSpeedTest: async () => result };
  } });
  assert.equal(await cli.run(['--json']), 0);
  assert.equal(imports, 1);
});

test('SIGINT and SIGTERM abort, return conventional exit codes and clean up only owned listeners', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    let receivedSignal;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const cli = setup({ engine: ({ signal: abortSignal }) => {
      receivedSignal = abortSignal;
      ready();
      return new Promise(() => {});
    } });
    const existing = () => {};
    cli.emitter.on(signal, existing);
    const running = cli.run(['--json']);
    await started;
    cli.emitter.emit(signal);
    assert.equal(await running, code);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(cli.output.stdout, '');
    assert.match(cli.output.stderr, /Test cancelled/);
    assert.deepEqual(cli.emitter.listeners(signal), [existing]);
    cli.emitter.removeListener(signal, existing);
    assertClean(cli.emitter);
  }
});

test('cancellation during engine import prevents initialization and cleans listeners', async () => {
  let resolveImport;
  const cli = setup({ engine: undefined, loadEngine: () => new Promise((resolve) => { resolveImport = resolve; }) });
  const running = cli.run(['--json']);
  cli.emitter.emit('SIGTERM');
  assert.equal(await running, 143);
  resolveImport({ runSpeedTest: () => assert.fail('Engine initialized after cancellation') });
  await Promise.resolve();
  assertClean(cli.emitter);
});
