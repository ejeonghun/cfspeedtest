import { cleanText, formatResult, paint, useColor } from './format.js';
import { createLiveDisplay, mergeProgress } from './live-display.js';

export const HELP = `Usage: cfspeedtest [options]

Measure download, upload, and HTTP latency using Cloudflare endpoints.
One command runs the test; no confirmation is requested.

Options:
  --quick               Smaller test: 18.1 MB main payload, plus small reply overhead
  --full                Full upstream sequence: 1.266 GB main payload
  --json                Write one complete result object to stdout
  --verbose             Detailed results, warnings and data usage
  --color <mode>        auto (default), always, or never; TTY streams only
  --timeout <seconds>   Overall timeout, greater than 0 and up to 3600 (default: 300)
  --max-bytes <bytes>   Application payload limit; positive safe integer
  --no-provider-lookup  Disable the ASN registration lookup for missing provider names
  -h, --help            Show this help without running a test
  -v, --version         Show the version without running a test

Default: 315.8 MB main payload, plus small reply overhead. Bandwidth requests
over 25 MB are omitted: a conservative CLI software cap, not a Cloudflare maximum.
Use --quick for less data. --quick and --full cannot be combined.
With --full, large requests may return HTTP 403 on some network paths;
the test then ends with an error and any available partial measurements.
Live dashboard on interactive terminals only; no progress in pipes or JSON.
Warnings and data usage notices require --verbose; errors always go to stderr.
NO_COLOR and TERM=dumb disable color.
Provider is the reported AS organization / registry name, not a verified retail ISP.
Missing provider names may be looked up via public ASN registration (RDAP).
Only the AS number is queried, not your IP, city, or coordinates. The third party
still sees your ordinary HTTPS source IP. --no-provider-lookup disables this
fallback; Cloudflare-provided ASN, provider and location remain when available.
Location is approximate IP geolocation, not your precise location.
Latency is HTTP, not ICMP. Packet loss requires WebRTC/TURN and is unavailable.
Results are not guaranteed to match the website. This is an independent tool.
`;

function parseArgs(args) {
  const options = { profile: 'default', timeoutMs: 300000, json: false, verbose: false, help: false, version: false, color: 'auto' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--quick' || argument === '--full') {
      const profile = argument === '--quick' ? 'quick' : 'full';
      if (options.profile !== 'default' && options.profile !== profile) throw new Error('--quick and --full cannot be combined.');
      options.profile = profile;
    }
    else if (argument === '--json') options.json = true;
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--no-provider-lookup') options.providerLookup = false;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (argument === '--color' || argument.startsWith('--color=') || argument === '--timeout' || argument.startsWith('--timeout=') || argument === '--max-bytes' || argument.startsWith('--max-bytes=')) {
      const equals = argument.indexOf('=');
      const flag = equals === -1 ? argument : argument.slice(0, equals);
      const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      if (flag === '--color') {
        if (!['auto', 'always', 'never'].includes(value)) throw new Error('--color must be auto, always, or never.');
        options.color = value;
      } else if (flag === '--timeout') {
        const seconds = Number(value);
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 3600 || seconds * 1000 === 0) {
          throw new Error('--timeout must be a positive finite number of seconds, up to 3600.');
        }
        options.timeoutMs = seconds * 1000;
      } else {
        const bytes = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes) || bytes <= 0) {
          throw new Error('--max-bytes must be a positive safe integer.');
        }
        options.maxBytes = bytes;
      }
    } else {
      throw new Error(argument.startsWith('-') ? `Unknown option: ${argument}` : `Unexpected argument: ${argument}`);
    }
  }
  return options;
}

function errorMessage(error) {
  const messages = {
    ABORTED: 'Test cancelled.',
    TIMEOUT: 'Test timed out. Try --quick or increase --timeout.',
    BYTE_LIMIT: 'Application payload limit reached. Try --quick or increase --max-bytes.',
    HTTP_ERROR: 'The test endpoint returned an HTTP error.',
    NETWORK_ERROR: 'Network request failed. Check your connection and try again.',
  };
  const message = cleanText(error?.message) || messages[error?.code] || 'Test failed.';
  const details = [
    error?.status != null ? `HTTP ${cleanText(error.status)}` : '',
    error?.direction ? cleanText(error.direction) : '',
    error?.requestedBytes != null ? `${cleanText(error.requestedBytes)} requested bytes` : '',
    error?.endpoint ? `endpoint ${cleanText(error.endpoint)}` : '',
  ].filter(Boolean).join(' | ');
  const advice = {
    TIMEOUT: 'Try --quick or increase --timeout.',
    BYTE_LIMIT: 'Try --quick or increase --max-bytes.',
    HTTP_ERROR: 'Retry with --quick; if it persists, the endpoint may be unavailable.',
    NETWORK_ERROR: 'Check your connection and try again.',
  }[error?.code];
  return `${message}${details ? `\n  ${details}` : ''}${advice ? `\n  ${advice}` : ''}`;
}

/** Run without exiting the process. The engine and process signal emitter are injectable. */
export async function runCli(args = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  engine,
  loadEngine = () => import('./engine.js'),
  version = '0.1.0',
  signalEmitter = process,
  now = Date.now,
  progressIntervalMs = 150,
  env = process.env,
} = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    stderr.write(`Error: ${error.message}\nRun cfspeedtest --help for usage.\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    stdout.write(`${version}\n`);
    return 0;
  }

  const notices = {
    default: 'Default test: 315.8 MB main payload, plus small reply overhead. Conservative CLI software cap: 25 MB per bandwidth request, not a Cloudflare maximum. Use --quick for less data.\n',
    full: 'Warning: full test uses 1.266 GB main payload, plus small reply overhead. Large requests may return HTTP 403 on some network paths; the test then ends with an error and any available partial measurements.\n',
    quick: 'Quick test: 18.1 MB main payload, plus small reply overhead.\n',
  };
  if (options.verbose) stderr.write(notices[options.profile]);

  const controller = new AbortController();
  let signalCode;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = (code) => {
    if (signalCode) return;
    signalCode = code;
    const error = Object.assign(new Error('Test cancelled.'), { code: 'ABORTED' });
    controller.abort(error);
    rejectCancellation(error);
  };
  const onInterrupt = () => cancel(130);
  const onTerminate = () => cancel(143);
  signalEmitter.on('SIGINT', onInterrupt);
  signalEmitter.on('SIGTERM', onTerminate);
  let finished = false;
  let latest = { profile: options.profile };
  let hasProgress = false;
  const display = createLiveDisplay({
    stream: stderr,
    enabled: Boolean(!options.json && stdout.isTTY && stderr.isTTY && env.TERM !== 'dumb'),
    color: useColor(stderr, options.color, env),
    profile: options.profile,
    verbose: options.verbose,
    now,
    intervalMs: progressIntervalMs,
  });
  const onProgress = (progress) => {
    if (finished || controller.signal.aborted) return;
    latest = mergeProgress(latest, progress);
    hasProgress = true;
    display.update(progress);
  };

  try {
    display.start();
    const work = (async () => {
      const runSpeedTest = engine ?? (await loadEngine()).runSpeedTest;
      controller.signal.throwIfAborted();
      return runSpeedTest({
        profile: options.profile,
        timeoutMs: options.timeoutMs,
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(options.providerLookup === false ? { providerLookup: false } : {}),
        signal: controller.signal,
        onProgress,
      });
    })();
    const result = await Promise.race([work, cancellation]);
    if (signalCode) throw controller.signal.reason;
    finished = true;
    display.finish();
    if (options.verbose) {
      for (const warning of result.warnings ?? []) stderr.write(`Warning: ${cleanText(warning)}\n`);
    }
    stdout.write(options.json ? `${JSON.stringify(result)}\n` : formatResult(result, { color: useColor(stdout, options.color, env), verbose: options.verbose }));
    return 0;
  } catch (error) {
    finished = true;
    display.finish({ preserve: true, partialResult: error?.partialResult });
    // Pipes retain useful measurements once on failure, without claiming a successful result.
    if (!options.json && !(stdout.isTTY && stderr.isTTY && env.TERM !== 'dumb') && (error?.partialResult || hasProgress)) {
      stderr.write(formatResult(error?.partialResult ? mergeProgress(latest, error.partialResult) : latest, { partial: true, verbose: options.verbose }));
    }
    stderr.write(`${paint('Error:', 'error', !options.json && useColor(stderr, options.color, env))} ${signalCode ? 'Test cancelled.' : errorMessage(error)}\n`);
    return signalCode ?? 1;
  } finally {
    finished = true;
    display.finish();
    signalEmitter.removeListener('SIGINT', onInterrupt);
    signalEmitter.removeListener('SIGTERM', onTerminate);
  }
}
