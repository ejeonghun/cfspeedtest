import { cleanText, fitLine, networkFields, number, paint, payloadTotal, textWidth } from './format.js';

export function mergeProgress(state, progress) {
  const next = { ...state, ...progress };
  for (const key of ['server', 'network', 'bytes']) {
    if (progress[key] && typeof progress[key] === 'object') next[key] = { ...state[key], ...progress[key] };
  }
  // Never carry a provisional transfer rate into a different phase or past an aggregate update.
  if ((progress.phase && progress.phase !== state.phase) ||
      Object.hasOwn(progress, `${state.liveDirection}Mbps`)) {
    next.liveDirection = undefined;
    next.liveMbps = undefined;
  }
  if (Object.hasOwn(progress, 'liveDirection')) next.liveDirection = progress.liveDirection;
  if (Object.hasOwn(progress, 'liveMbps')) next.liveMbps = progress.liveMbps;
  return next;
}

function speed(state, direction, stopped) {
  if (!stopped && state.phase === direction && state.liveDirection === direction &&
      typeof state.liveMbps === 'number' && Number.isFinite(state.liveMbps)) {
    return `${number(state.liveMbps, 'Mbps')} (live)`;
  }
  const value = state[`${direction}Mbps`];
  if (typeof value === 'number' && Number.isFinite(value)) return number(value, 'Mbps');
  if (stopped && state.liveDirection === direction && typeof state.liveMbps === 'number' && Number.isFinite(state.liveMbps)) {
    return `${number(state.liveMbps, 'Mbps')} (last live)`;
  }
  if (stopped) return 'unavailable';
  if (state.phase === direction) return 'measuring';
  if (direction === 'download' && state.phase === 'upload') return 'unavailable';
  return 'waiting';
}

export function dashboardLines(state, { width = 80, color = false, stopped = false, verbose = false } = {}) {
  const network = networkFields(state.network);
  const server = [state.server?.colo, state.server?.country].map(cleanText).filter(Boolean).join(' / ') || 'unavailable';
  const phase = { metadata: 'Getting network details', latency: 'HTTP latency', download: 'Downloading', upload: 'Uploading' }[state.phase] || 'Starting';
  const row = (label, value) => `${label.padEnd(width < 50 ? 10 : verbose ? 13 : 18)} ${value}`;
  const httpMetric = (key) => {
    if (Object.hasOwn(state, key)) return number(state[key], 'ms');
    if (stopped || state.phase === 'download' || state.phase === 'upload') return 'unavailable';
    return state.phase === 'latency' ? 'measuring' : 'waiting';
  };
  const lines = verbose ? [
    ['Cloudflare speed test | ' + (stopped ? 'incomplete' : cleanText(state.profile)), 'title'],
    [row('Download', speed(state, 'download', stopped)), 'download'],
    [row('Upload', speed(state, 'upload', stopped)), 'upload'],
    [row('HTTP idle', `${httpMetric('latencyMs')} | jitter ${httpMetric('jitterMs')}`)],
    [row('Server', server)],
    [row('Client AS', network.asn)],
    [row('Provider', network.provider)],
    ['Provider = AS organization / registry name', 'muted'],
    [row('Location', network.location)],
    ['Location = approximate IP geolocation', 'muted'],
    [`${stopped ? 'Stopped' : phase} | ${payloadTotal(state.bytes)} payload | ${number(state.durationMs / 1000, 's')}`, 'muted'],
    ['Live Mbps: current transfer, not final aggregate', 'muted'],
  ] : [
    [stopped ? 'Last known measurements (test incomplete)' : 'Cloudflare speed test', 'title'],
    [row('Download', speed(state, 'download', stopped)), 'download'],
    [row('Upload', speed(state, 'upload', stopped)), 'upload'],
    [row('Ping (HTTP)', `${httpMetric('latencyMs')} | Jitter ${httpMetric('jitterMs')}`)],
    [row('Server', server)],
    [row('Client AS', network.asn)],
    [row('Provider', network.provider)],
    [row('Location (approx.)', network.location)],
    [stopped ? 'Stopped' : phase, 'muted'],
  ];
  return lines.map(([text, style]) => paint(fitLine(text, width), style, color && Boolean(style)));
}

/** Only touches the lines it owns; never clears the screen or writes into stdout. */
export function createLiveDisplay({ stream, enabled, color = false, verbose = false, profile, now = Date.now, intervalMs = 150 }) {
  const started = now();
  let state = { profile, phase: 'metadata' };
  let rendered = false;
  let closed = false;
  let lineCount = 0;
  let lastAt = -Infinity;
  let lastColumns;
  let renderedWidths = [];
  // Keeping the cursor at the frame's beginning makes width changes safe: all rows
  // have explicit newlines and leave one spare column to avoid terminal autowrap.
  const clear = () => {
    const columns = Number.isInteger(stream.columns) && stream.columns > 1 ? stream.columns : 80;
    // A terminal can reflow existing rows when resized. Clear the old frame's
    // physical rows at the new width, not just its original logical row count.
    const rows = renderedWidths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / columns)), 0);
    for (let index = 0; index < rows; index += 1) stream.write('\r\u001b[2K\n');
    if (rows) stream.write(`\u001b[${rows}A\r`);
  };
  const render = (force = false, stopped = false) => {
    if (!enabled || closed) return;
    const time = now();
    const columns = Number.isInteger(stream.columns) && stream.columns > 1 ? stream.columns : 80;
    if (!force && time - lastAt < intervalMs && columns === lastColumns) return;
    if (!rendered) stream.write('\u001b[?25l');
    else clear();
    state.durationMs ??= Math.max(0, time - started);
    const lines = dashboardLines(state, { width: Math.max(1, columns - 1), color, stopped, verbose });
    renderedWidths = dashboardLines(state, { width: Math.max(1, columns - 1), stopped, verbose }).map(textWidth);
    stream.write(lines.join('\n') + '\n' + `\u001b[${lines.length}A\r`);
    lineCount = lines.length;
    rendered = true;
    lastAt = time;
    lastColumns = columns;
  };
  return {
    start: () => render(true),
    update(progress) {
      if (closed) return;
      state = mergeProgress(state, progress);
      if (!Object.hasOwn(progress, 'durationMs')) state.durationMs = Math.max(0, now() - started);
      render();
    },
    snapshot: () => ({ ...state }),
    finish({ preserve = false, partialResult } = {}) {
      if (closed) return;
      if (partialResult) state = mergeProgress(state, partialResult);
      try {
        if (rendered) {
          if (preserve) {
            render(true, true);
            stream.write(`\u001b[${lineCount}B\r`);
          } else clear();
        }
      } finally {
        closed = true;
        if (rendered) stream.write('\u001b[?25h');
      }
    },
  };
}
