import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const documents = [
  'README.md', 'README.ko.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md',
  'DISCLAIMER.md', 'DISCLAIMER.ko.md',
];

test('release manifest uses the canonical public package and keeps the legacy executable', async () => {
  assert.equal(manifest.name, 'cfspeedtest');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.engines.node, '>=22');
  assert.equal(manifest.license, 'MIT');
  assert.match(manifest.description, /unofficial.*cloudflare.*speed test.*cli/i);
  assert.deepEqual(manifest.bin, {
    cfspeedtest: 'bin/cfspeedtest.js',
    'cloudflare-speedtestcli': 'bin/cloudflare-speedtestcli.js',
  });
  assert.deepEqual(manifest.publishConfig, {
    access: 'public', registry: 'https://registry.npmjs.org',
  });
  assert.deepEqual(manifest.files, ['bin/', 'src/', ...documents]);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.deepEqual(manifest[field] ?? {}, {});
  }
  assert.deepEqual(manifest.repository, {
    type: 'git', url: 'git+https://github.com/ejeonghun/cfspeedtest.git',
  });
  assert.equal(manifest.homepage, 'https://github.com/ejeonghun/cfspeedtest#readme');
  assert.deepEqual(manifest.bugs, { url: 'https://github.com/ejeonghun/cfspeedtest/issues' });
  for (const field of ['author', 'contributors']) {
    assert.equal(Object.hasOwn(manifest, field), false, `${field} must not be invented`);
  }
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(lock.packages[''].bin, manifest.bin);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.deepEqual(Object.keys(lock.packages), ['']);
});

test('both thin entrypoints have executable shebangs and share the canonical implementation', async () => {
  for (const entry of Object.values(manifest.bin)) {
    const path = new URL(`../${entry}`, import.meta.url);
    assert.match(await readFile(path, 'utf8'), /^#!\/usr\/bin\/env node\n/);
    assert.ok((await stat(path)).mode & 0o111, `${entry} must be executable`);
  }
  const legacy = await readFile(new URL('../bin/cloudflare-speedtestcli.js', import.meta.url), 'utf8');
  assert.equal(legacy, "#!/usr/bin/env node\nimport './cfspeedtest.js';\n");
});

// Block the measurement engine at module resolution, not with a runtime fake.
// These subprocesses must terminate before importing it or making a request.
const loader = `
  export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    if (resolved.url.endsWith('/src/engine.js')) throw new Error('Engine imported for informational command');
    return resolved;
  }
`;
const preload = `
  import * as module from 'node:module';
  if (module.registerHooks) {
    module.registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.endsWith('/src/engine.js')) throw new Error('Engine imported for informational command');
      return resolved;
    } });
  } else {
    module.register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
  }
  globalThis.fetch = () => { throw new Error('Unexpected network request'); };
`;

test('canonical and legacy entrypoints show identical help/version without importing the engine', () => {
  for (const flag of ['--help', '-h', '--version', '-v', '--invalid-option']) {
    const outputs = [];
    for (const entry of Object.values(manifest.bin)) {
      const child = spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(preload)}`, entry, flag,
      ], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.ifError(child.error);
      assert.equal(child.signal, null);
      assert.equal(child.status, flag === '--invalid-option' ? 1 : 0, child.stderr);
      if (flag === '--help' || flag === '-h') {
        assert.match(child.stdout, /^Usage: cfspeedtest \[options\]\n/);
        assert.equal(child.stderr, '');
      } else if (flag === '--invalid-option') {
        assert.equal(child.stdout, '');
        assert.equal(child.stderr, 'Error: Unknown option: --invalid-option\nRun cfspeedtest --help for usage.\n');
      } else {
        assert.equal(child.stdout, '0.1.0\n');
        assert.equal(child.stderr, '');
      }
      outputs.push({ stdout: child.stdout, stderr: child.stderr });
    }
    assert.deepEqual(outputs[0], outputs[1], flag);
  }
});

test('published file allowlist includes source and all release disclosures, excluding development and secrets', async () => {
  for (const name of documents) {
    const file = await stat(new URL(`../${name}`, import.meta.url));
    assert.ok(file.isFile() && file.size > 0, `${name} must exist and be nonempty`);
  }
  const child = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const [pack] = JSON.parse(child.stdout);
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  const paths = pack.files.map(({ path }) => path);
  const allowedRoot = new Set(['package.json', ...documents]);
  for (const path of paths) {
    assert.ok(allowedRoot.has(path) || /^(?:bin|src)\//.test(path), `Unexpected published file: ${path}`);
    assert.doesNotMatch(path, /(?:^|\/)(?:\.git|\.npmrc|node_modules|tests?|config|tmp|temp|credentials?)(?:\/|$)|\.(?:log|tgz)$/i);
  }
  for (const path of [...allowedRoot, ...Object.values(manifest.bin), 'src/cli.js', 'src/engine.js']) {
    assert.ok(paths.includes(path), `${path} must be published`);
  }
});
