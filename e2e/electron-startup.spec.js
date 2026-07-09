import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ELECTRON_MAIN = path.join(ROOT, '.electron-build', 'app', 'main.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const CACHE_NAME = 'transformers-cache';
const CACHE_KEY = 'https://huggingface.co/bardsai/eu-pii-anonimization/resolve/main/config.json';
const CACHE_VALUE = 'sentinel-transformers-cache';
const ASSET_DIAGNOSTIC_PATTERN = /\/assets\/|worker\.js|\/vendor\/pdfjs\/wasm\/|\/ocr-models\/|paddle-model-ecology\.bj\.bcebos\.com|PP-OCRv5[^/]*\.tar/i;

function createDiagnostics() {
  return {
    pages: new WeakSet(),
    consoleErrors: [],
    requestFailures: [],
    badAssetResponses: [],
    processOutput: [],
  };
}

function attachPageDiagnostics(page, diagnostics) {
  if (diagnostics.pages.has(page)) return;
  diagnostics.pages.add(page);

  page.on('console', (msg) => {
    if (msg.type() === 'error') diagnostics.consoleErrors.push(msg.text());
  });
  page.on('requestfailed', (request) => {
    if (ASSET_DIAGNOSTIC_PATTERN.test(request.url())) {
      diagnostics.requestFailures.push(`${request.url()} ${request.failure()?.errorText ?? ''}`.trim());
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && ASSET_DIAGNOSTIC_PATTERN.test(response.url())) {
      diagnostics.badAssetResponses.push(`${response.status()} ${response.url()}`);
    }
  });
}

function attachProcessDiagnostics(electronApp, diagnostics) {
  const child = electronApp.process();
  child.stdout?.on('data', (chunk) => diagnostics.processOutput.push(String(chunk)));
  child.stderr?.on('data', (chunk) => diagnostics.processOutput.push(String(chunk)));
}

async function closeAfterLaunchFailure(electronApp, diagnostics, err) {
  await electronApp.close().catch(() => {});
  if (diagnostics.processOutput.length === 0) throw err;
  throw new Error(`${err.message}\n\nElectron output before first window:\n${diagnostics.processOutput.join('')}`);
}

function assetConsoleErrors(consoleErrors) {
  return consoleErrors.filter((message) => ASSET_DIAGNOSTIC_PATTERN.test(message));
}

function formatDiagnostics(diagnostics) {
  return JSON.stringify({
    consoleErrors: diagnostics.consoleErrors,
    requestFailures: diagnostics.requestFailures,
    badAssetResponses: diagnostics.badAssetResponses,
    processOutput: diagnostics.processOutput,
  }, null, 2);
}


async function launchApp(userDataDir) {
  const diagnostics = createDiagnostics();
  const electronApp = await electron.launch({
    args: [ELECTRON_MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      PII_ELECTRON_USER_DATA_DIR: userDataDir,
    },
  });
  attachProcessDiagnostics(electronApp, diagnostics);
  electronApp.on('window', (page) => attachPageDiagnostics(page, diagnostics));
  try {
    const page = await electronApp.firstWindow();
    attachPageDiagnostics(page, diagnostics);
    await page.waitForLoadState('domcontentloaded');
    return { electronApp, page, diagnostics };
  } catch (err) {
    await closeAfterLaunchFailure(electronApp, diagnostics, err);
  }
}

test('Electron app boots through app protocol, exposes IPC, and preserves CacheStorage', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pii-electron-user-data-'));
  let electronApp;

  try {
    let launched = await launchApp(userDataDir);
    electronApp = launched.electronApp;
    let page = launched.page;

    expect(page.url()).toMatch(/^app:\/\/pii\.tools\/tool\.html/);
    await expect(page).toHaveTitle(/pii\.tools/i);
    await expect(page.locator('[data-testid="sources-add-paste"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => 'caches' in window)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.piiDesktop?.platform)).not.toBeFalsy();
    const allowGpu = page.locator('[data-testid="allow-gpu-checkbox"]');
    await expect(allowGpu).not.toBeChecked();
    const workerBackendLog = page.waitForEvent('console', (message) => {
      const text = message.text();
      return text.includes('[main] WebNN') && text.includes('(requested=auto)');
    });
    await allowGpu.check();
    const backendMessage = await workerBackendLog;
    expect(backendMessage.text()).toContain('[main] WebNN available');
    expect(backendMessage.text()).toContain('(requested=auto)');
    await expect.poll(() => page.evaluate(() => 'ml' in navigator)).toBe(true);
    await expect(page.locator('#webnn-hint')).toBeHidden();

    if (process.platform === 'darwin') {
      await expect.poll(() => page.evaluate(async () => {
        const context = await navigator.ml.createContext({ deviceType: 'gpu' });
        return Object.prototype.toString.call(context);
      })).toBe('[object MLContext]');
    }

    const active = await page.evaluate(() => window.piiDesktop.setActiveWork('pii-anonymize', true));
    expect(active.powerSaveBlockerActive).toBe(true);
    expect(active.activeKeys).toEqual(['pii-anonymize']);

    const inactive = await page.evaluate(() => window.piiDesktop.setActiveWork('pii-anonymize', false));
    expect(inactive.powerSaveBlockerActive).toBe(false);
    expect(inactive.activeKeys).toEqual([]);

    await page.evaluate(async ({ cacheName, key, value }) => {
      const cache = await caches.open(cacheName);
      await cache.put(key, new Response(value, { headers: { 'Content-Type': 'text/plain' } }));
    }, { cacheName: CACHE_NAME, key: CACHE_KEY, value: CACHE_VALUE });

    expect(assetConsoleErrors(launched.diagnostics.consoleErrors)).toEqual([]);
    expect(launched.diagnostics.requestFailures).toEqual([]);
    expect(launched.diagnostics.badAssetResponses).toEqual([]);

    await electronApp.close();
    electronApp = null;

    launched = await launchApp(userDataDir);
    electronApp = launched.electronApp;
    page = launched.page;

    const cachedValue = await page.evaluate(async ({ cacheName, key }) => {
      const cache = await caches.open(cacheName);
      const response = await cache.match(key);
      return response ? response.text() : null;
    }, { cacheName: CACHE_NAME, key: CACHE_KEY });

    expect(cachedValue).toBe(CACHE_VALUE);
  } finally {
    if (electronApp) await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('Electron imports an image with OCR from application-owned assets', async () => {
  test.setTimeout(150_000);
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pii-electron-ocr-user-data-'));
  let electronApp;
  let diagnostics;

  try {
    const launched = await launchApp(userDataDir);
    electronApp = launched.electronApp;
    ({ diagnostics } = launched);
    const { page } = launched;
    await page.locator('[data-testid="sources-add-file-input"]')
      .setInputFiles(path.join(FIXTURES, 'sample-photo.png'));

    const sourceTab = page.locator('[data-testid^="ws-tab-"]', { hasText: 'sample-photo.png' });
    const status = sourceTab.locator('[data-testid^="source-status-"]');
    await expect(status).toHaveAttribute('data-status', 'idle', { timeout: 120_000 });

    await expect(page.locator('[data-testid^="source-card-"][data-active="true"] .ann-editor-textarea'))
      .toHaveValue(/Jan/i);
    expect(assetConsoleErrors(diagnostics.consoleErrors)).toEqual([]);
    expect(diagnostics.requestFailures).toEqual([]);
    expect(diagnostics.badAssetResponses).toEqual([]);
  } catch (error) {
    if (!diagnostics) throw error;
    throw new Error(
      `${error.message}\n\nElectron OCR diagnostics:\n${formatDiagnostics(diagnostics)}`,
      { cause: error }
    );
  } finally {
    if (electronApp) await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
