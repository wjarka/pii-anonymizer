import { app, BrowserWindow, ipcMain, powerSaveBlocker, protocol } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileResponse, resolveAppPath, securityHeaders } from './protocol.js';
import { configureWebnnFeatures } from './webnn-features.js';

configureWebnnFeatures(app.commandLine);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_WORK_KEYS = new Set(['pii-file-import', 'pii-anonymize']);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (process.env.PII_ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.PII_ELECTRON_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.PII_ELECTRON_USER_DATA_DIR, 'session'));
}

const activeWork = new Set();
let powerSaveBlockerId = null;

function stopPowerSaveBlocker() {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = null;
}

function syncPowerSaveBlocker() {
  if (activeWork.size > 0 && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (activeWork.size === 0 && powerSaveBlockerId !== null) {
    stopPowerSaveBlocker();
  }
}

function resolveDistDir() {
  const stagedDist = path.join(__dirname, 'dist');
  if (existsSync(stagedDist)) return stagedDist;

  const repoDist = path.join(__dirname, '..', 'dist');
  if (existsSync(repoDist)) return repoDist;

  throw new Error('Run npm run electron:build-renderer before launching Electron.');
}


let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.once('ready-to-show', () => win.show());
  return win.loadURL('app://pii.tools/tool.html');
}

ipcMain.handle('pii:set-active-work', (_event, { key, active } = {}) => {
  if (!ACTIVE_WORK_KEYS.has(key)) {
    throw new Error(`Unknown active work key: ${key}`);
  }

  if (active) activeWork.add(key);
  else activeWork.delete(key);

  syncPowerSaveBlocker();

  return {
    activeKeys: [...activeWork].sort(),
    powerSaveBlockerActive: powerSaveBlockerId !== null,
  };
});

app.on('before-quit', () => {
  activeWork.clear();
  stopPowerSaveBlocker();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    void createWindow();
  }
});

async function startApp() {
  const distDir = resolveDistDir();

  protocol.handle('app', async (request) => {
    const isNavigation = request.mode === 'navigate' || request.destination === 'document';
    const result = resolveAppPath({ distDir, requestUrl: request.url, isNavigation });
    if (!result.filePath) {
      return new Response('Not found', { status: 404, headers: securityHeaders() });
    }
    return createFileResponse(result);
  });

  await createWindow();
}

app.whenReady().then(startApp).catch((err) => {
  console.error('[electron] failed to start:', err);
  app.quit();
});
