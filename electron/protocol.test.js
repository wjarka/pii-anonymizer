import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  APP_HOST,
  APP_PROTOCOL,
  contentTypeForPath,
  createFileResponse,
  resolveAppPath,
  securityHeaders,
} from './protocol.js';

async function makeDist(files) {
  const distDir = await mkdtemp(path.join(tmpdir(), 'pii-protocol-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(distDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return distDir;
}

describe('Electron app protocol helpers', () => {
  let distDir;

  afterEach(async () => {
    if (distDir) {
      await rm(distDir, { recursive: true, force: true });
      distDir = null;
    }
  });

  it('exports the app protocol identity', () => {
    expect(APP_PROTOCOL).toBe('app');
    expect(APP_HOST).toBe('pii.tools');
  });

  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/app.js', 'text/javascript; charset=utf-8'],
    ['assets/app.css', 'text/css; charset=utf-8'],
    ['vendor/pdfjs/wasm/openjpeg.wasm', 'application/wasm'],
    ['manifest.json', 'application/json; charset=utf-8'],
    ['favicon.svg', 'image/svg+xml'],
    ['logo.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['readme.txt', 'text/plain; charset=utf-8'],
    ['ocr-models/latin_PP-OCRv5_mobile_rec.tar', 'application/x-tar'],
    ['local-models/model.onnx', 'application/octet-stream'],
  ])('maps %s to %s', (filePath, expected) => {
    expect(contentTypeForPath(filePath)).toBe(expected);
  });

  it('returns COOP and COEP security headers', () => {
    expect(securityHeaders()).toMatchObject({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
  });

  it.each([
    ['app://pii.tools/tool.html', 'tool.html'],
    ['app://pii.tools/index.html', 'index.html'],
    ['app://pii.tools/assets/foo.js', path.join('assets', 'foo.js')],
    ['app://pii.tools/vendor/pdfjs/wasm/foo.wasm', path.join('vendor', 'pdfjs', 'wasm', 'foo.wasm')],
    ['app://pii.tools/ocr-models/latin_PP-OCRv5_mobile_rec.tar', path.join('ocr-models', 'latin_PP-OCRv5_mobile_rec.tar')],
  ])('resolves %s inside dist', async (requestUrl, expectedRelativePath) => {
    distDir = await makeDist({
      'tool.html': '<!doctype html><title>tool</title>',
      'index.html': '<!doctype html><title>index</title>',
      'assets/foo.js': 'console.log("asset")',
      'vendor/pdfjs/wasm/foo.wasm': 'wasm',
      'ocr-models/latin_PP-OCRv5_mobile_rec.tar': 'tar',
    });

    const result = resolveAppPath({ distDir, requestUrl });

    expect(result).toEqual({
      filePath: path.join(distDir, expectedRelativePath),
      status: 200,
    });
  });

  it('returns a 404 for missing asset requests instead of falling back to HTML', async () => {
    distDir = await makeDist({ 'index.html': '<!doctype html><title>index</title>' });

    expect(resolveAppPath({ distDir, requestUrl: 'app://pii.tools/assets/missing.js' })).toEqual({
      filePath: null,
      status: 404,
    });
  });

  it('falls back missing document navigations to 404.html when present', async () => {
    distDir = await makeDist({
      'index.html': '<!doctype html><title>index</title>',
      '404.html': '<!doctype html><title>not found</title>',
    });

    expect(resolveAppPath({
      distDir,
      requestUrl: 'app://pii.tools/no-such-page',
      isNavigation: true,
    })).toEqual({
      filePath: path.join(distDir, '404.html'),
      status: 404,
    });
  });

  it('falls back missing document navigations to index.html when 404.html is absent', async () => {
    distDir = await makeDist({ 'index.html': '<!doctype html><title>index</title>' });

    expect(resolveAppPath({
      distDir,
      requestUrl: 'app://pii.tools/no-such-page',
      isNavigation: true,
    })).toEqual({
      filePath: path.join(distDir, 'index.html'),
      status: 200,
    });
  });

  it('rejects encoded traversal outside dist', async () => {
    distDir = await makeDist({ 'index.html': '<!doctype html><title>index</title>' });

    expect(resolveAppPath({
      distDir,
      requestUrl: 'app://pii.tools/assets/%2e%2e/package.json',
    })).toEqual({ filePath: null, status: 404 });
  });

  it('rejects wrong hosts', async () => {
    distDir = await makeDist({ 'tool.html': '<!doctype html><title>tool</title>' });

    expect(resolveAppPath({ distDir, requestUrl: 'app://evil.test/tool.html' })).toEqual({
      filePath: null,
      status: 404,
    });
  });

  it('creates file responses with status, security headers, content type, and file body', async () => {
    distDir = await makeDist({ 'assets/foo.js': 'console.log("ok");' });
    const response = await createFileResponse({
      filePath: path.join(distDir, 'assets', 'foo.js'),
      status: 206,
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toBe('console.log("ok");');
  });
});
