import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prepareElectronApp } from './prepare-electron-app.js';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFixture(rootDir, relativePath, content = '') {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function makeRoot({ withDist = true } = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'pii-stage-'));
  await writeFixture(rootDir, 'package.json', JSON.stringify({
    name: 'pii-anonymizer',
    version: '9.8.7',
    description: 'Root package description should not leak by accident.',
    dependencies: { '@huggingface/transformers': '^3.4.0' },
  }, null, 2));
  await writeFixture(rootDir, 'package-lock.json', '{}');
  await writeFixture(rootDir, 'electron/main.js', 'main');
  await writeFixture(rootDir, 'electron/preload.cjs', 'preload');
  await writeFixture(rootDir, 'electron/protocol.js', 'protocol');
  await writeFixture(rootDir, 'electron/webnn-features.js', 'webnn features');
  await writeFixture(rootDir, 'src/main.js', 'source');
  await writeFixture(rootDir, 'test-data/synthetic/example.txt', 'pii');
  await writeFixture(rootDir, 'bench/runner.js', 'bench');
  await writeFixture(rootDir, '.github/workflows/web.yml', 'workflow');
  await writeFixture(rootDir, 'node_modules/root-only/index.js', 'dependency');

  if (withDist) {
    await writeFixture(rootDir, 'dist/tool.html', '<!doctype html><title>tool</title>');
    await writeFixture(rootDir, 'dist/assets/app.js', 'console.log("app")');
  }

  return rootDir;
}

describe('prepareElectronApp', () => {
  let rootDir;

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it('refuses to run if dist/tool.html is missing', async () => {
    rootDir = await makeRoot({ withDist: false });

    await expect(prepareElectronApp({ rootDir })).rejects.toThrow(/dist[/\\]tool\.html/);
  });

  it('recreates the staging directory from scratch', async () => {
    rootDir = await makeRoot();
    await writeFixture(rootDir, '.electron-build/app/stale.txt', 'stale');
    await writeFixture(rootDir, '.electron-build/app/node_modules/dep/index.js', 'stale dependency');

    await prepareElectronApp({ rootDir });

    expect(await exists(path.join(rootDir, '.electron-build/app/stale.txt'))).toBe(false);
    expect(await exists(path.join(rootDir, '.electron-build/app/node_modules'))).toBe(false);
  });

  it('copies the renderer dist into the staged app', async () => {
    rootDir = await makeRoot();

    await prepareElectronApp({ rootDir });

    await expect(readFile(path.join(rootDir, '.electron-build/app/dist/tool.html'), 'utf8'))
      .resolves.toContain('<title>tool</title>');
    await expect(readFile(path.join(rootDir, '.electron-build/app/dist/assets/app.js'), 'utf8'))
      .resolves.toContain('console.log("app")');
  });

  it('copies only the Electron runtime files needed by the staged app', async () => {
    rootDir = await makeRoot();

    await prepareElectronApp({ rootDir });

    await expect(readFile(path.join(rootDir, '.electron-build/app/main.js'), 'utf8')).resolves.toBe('main');
    await expect(readFile(path.join(rootDir, '.electron-build/app/preload.cjs'), 'utf8')).resolves.toBe('preload');
    await expect(readFile(path.join(rootDir, '.electron-build/app/protocol.js'), 'utf8')).resolves.toBe('protocol');
    await expect(readFile(path.join(rootDir, '.electron-build/app/webnn-features.js'), 'utf8'))
      .resolves.toBe('webnn features');
  });

  it('writes a minimal app package without root production dependencies', async () => {
    rootDir = await makeRoot();

    await prepareElectronApp({ rootDir });

    const packageJson = JSON.parse(await readFile(path.join(rootDir, '.electron-build/app/package.json'), 'utf8'));
    expect(packageJson).toEqual({
      name: 'pii-tools-desktop',
      productName: 'pii.tools',
      version: '9.8.7',
      description: 'Browser-based PII anonymizer for Polish legal documents.',
      license: 'Apache-2.0',
      type: 'module',
      main: 'main.js',
      dependencies: {},
    });
  });

  it('does not copy source, test data, build metadata, root deps, or lockfile', async () => {
    rootDir = await makeRoot();

    await prepareElectronApp({ rootDir });

    const stageRoot = path.join(rootDir, '.electron-build/app');
    await expect(Promise.all([
      exists(path.join(stageRoot, 'src')),
      exists(path.join(stageRoot, 'test-data')),
      exists(path.join(stageRoot, 'bench')),
      exists(path.join(stageRoot, '.github')),
      exists(path.join(stageRoot, 'node_modules')),
      exists(path.join(stageRoot, 'package-lock.json')),
    ])).resolves.toEqual([false, false, false, false, false, false]);
  });
});
