#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runCli } from '../src/cli.js';

try {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  process.exitCode = await runCli(process.argv.slice(2), { version });
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}
