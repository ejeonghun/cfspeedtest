import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function javascriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await javascriptFiles(path));
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const files = (await Promise.all(
  ['bin', 'src', 'scripts', 'test', 'tests'].map((name) => javascriptFiles(join(root, name))),
)).flat();
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`Syntax check failed: ${relative(root, file)}`);
    if (result.error) console.error(result.error.message);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Syntax checked ${files.length} JavaScript files (offline).`);
