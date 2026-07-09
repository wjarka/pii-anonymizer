import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const APP_PROTOCOL = 'app';
export const APP_HOST = 'pii.tools';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.tar', 'application/x-tar'],
  ['.onnx', 'application/octet-stream'],
]);

export function contentTypeForPath(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

export function securityHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  };
}

function existingFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isInsideDirectory(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fallbackNavigationPath(distRoot) {
  const notFoundPath = path.join(distRoot, '404.html');
  if (existingFile(notFoundPath)) {
    return { filePath: notFoundPath, status: 404 };
  }

  const indexPath = path.join(distRoot, 'index.html');
  if (existingFile(indexPath)) {
    return { filePath: indexPath, status: 200 };
  }

  return { filePath: null, status: 404 };
}

export function resolveAppPath({ distDir, requestUrl, isNavigation = false }) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return { filePath: null, status: 404 };
  }

  if (url.protocol !== `${APP_PROTOCOL}:` || url.host !== APP_HOST) {
    return { filePath: null, status: 404 };
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(url.pathname || '/');
  } catch {
    return { filePath: null, status: 404 };
  }

  if (decodedPathname.includes('\0')) {
    return { filePath: null, status: 404 };
  }

  const rawSegments = decodedPathname.split('/');
  if (rawSegments.some((segment) => segment === '..')) {
    return { filePath: null, status: 404 };
  }

  const normalizedPathname = path.posix.normalize(decodedPathname === '/' ? '/index.html' : decodedPathname);
  const relativePath = normalizedPathname.replace(/^\/+/, '') || 'index.html';
  const distRoot = path.resolve(distDir);
  const filePath = path.resolve(distRoot, ...relativePath.split('/'));

  if (!isInsideDirectory(distRoot, filePath)) {
    return { filePath: null, status: 404 };
  }

  if (existsSync(filePath) && existingFile(filePath)) {
    return { filePath, status: 200 };
  }

  if (isNavigation) {
    return fallbackNavigationPath(distRoot);
  }

  return { filePath: null, status: 404 };
}

export async function createFileResponse({ filePath, status = 200 }) {
  const body = await readFile(filePath);
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders(),
      'Content-Type': contentTypeForPath(filePath),
    },
  });
}
