import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function validateLiveResult(result, maxBytes = 330_000_000) {
  const fail = field => { throw new Error(`Invalid live result: ${field}`); };
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('object required');
  if (result.schemaVersion !== 1) fail('schemaVersion');
  if (result.profile !== 'default') fail('profile');
  if (result.partial !== undefined && result.partial !== false) fail('partial');
  for (const field of ['downloadMbps', 'uploadMbps', 'durationMs']) {
    if (!Number.isFinite(result[field]) || result[field] <= 0) fail(field);
  }
  for (const field of ['latencyMs', 'jitterMs']) {
    if (!Number.isFinite(result[field]) || result[field] < 0) fail(field);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('maxBytes');
  if (!result.bytes || typeof result.bytes !== 'object' || Array.isArray(result.bytes)) fail('bytes');
  for (const field of ['download', 'upload']) {
    if (!Number.isSafeInteger(result.bytes[field]) || result.bytes[field] <= 0) fail(`bytes.${field}`);
  }
  const total = result.bytes.download + result.bytes.upload;
  if (!Number.isSafeInteger(total) || total > maxBytes) fail('bytes.total exceeds budget');
  return result;
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-live-result.js <result.json>');
  let text;
  try { text = await readFile(process.argv[2], 'utf8'); }
  catch { throw new Error('Cannot read live result file'); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Invalid live result: malformed JSON'); }
  const result = validateLiveResult(parsed);
  console.log(`Validated GitHub runner default measurement: download ${result.downloadMbps} Mbps; upload ${result.uploadMbps} Mbps; HTTP latency ${result.latencyMs} ms; jitter ${result.jitterMs} ms; duration ${result.durationMs} ms; payload ${result.bytes.download + result.bytes.upload} bytes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
