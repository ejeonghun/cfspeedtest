import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { formatResult } from '../src/format.js';

const MAX_FILE_BYTES = 1_048_576;

// This is a presentation check, not the workflow's strict live-result validator.
function checkResult(result) {
  const fail = () => { throw new Error('Invalid CI summary result'); };
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail();
  if (result.schemaVersion !== 1 || result.profile !== 'default') fail();
  if (result.partial !== undefined && result.partial !== false) fail();
  for (const field of ['downloadMbps', 'uploadMbps', 'latencyMs', 'jitterMs']) {
    if (!Object.hasOwn(result, field)) fail();
    if (result[field] !== null && (!Number.isFinite(result[field]) || result[field] < 0)) fail();
  }
  for (const [section, fields] of [
    ['server', ['colo', 'country']],
    ['network', ['asn', 'provider', 'city', 'region', 'country', 'countryCode']],
  ]) {
    const metadata = result[section];
    if (metadata == null) continue;
    if (typeof metadata !== 'object' || Array.isArray(metadata)) fail();
    for (const field of fields) {
      const value = metadata[field];
      if (value != null && typeof value !== 'string' &&
          !(typeof value === 'number' && Number.isFinite(value))) fail();
    }
  }
}

export function renderCiSummary(result) {
  checkResult(result);
  const output = formatResult(result, { color: false, verbose: false });
  // Remote metadata stays literal, even if it contains Markdown fences or HTML.
  let longestRun = 0;
  for (const match of output.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${output}${fence}\n\nGitHub runner · default profile\n`;
}

async function readResult(path) {
  let file;
  let text;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw new Error();
    text = buffer.toString('utf8', 0, total);
  } catch {
    throw new Error('Cannot read CI summary result file (regular file, maximum 1 MiB)');
  } finally {
    await file?.close();
  }
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid CI summary result: malformed JSON'); }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/render-ci-summary.js <result.json>');
  process.stdout.write(renderCiSummary(await readResult(process.argv[2])));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
