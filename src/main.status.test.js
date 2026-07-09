// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Harness mirrors src/main.stale-classify.test.js (inline fakes per repo convention).

class FakeWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.messages = [];
    this.onmessage = null;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  emit(message) {
    this.onmessage?.({ data: message });
  }
}

function installToolDom() {
  document.body.innerHTML = `
    <div id="webnn-hint" hidden>
      <button id="webnn-hint-trigger" type="button" aria-expanded="false"></button>
      <div id="webnn-hint-panel" hidden>
        <div data-webnn-copy="browser" hidden>
          <p>Enable <code>chrome://flags/#web-machine-learning-neural-network</code>.</p>
        </div>
        <div data-webnn-copy="desktop" hidden>
          <p>WebNN is enabled by the desktop application.</p>
        </div>
        <button id="webnn-hint-close" type="button"></button>
      </div>
    </div>
    <div class="tool">
      <p data-status="model"></p>
      <div data-mode-panel="anonymize">
        <div id="doc-list-root"></div>
        <div id="entity-selector-root"></div>
        <input id="allow-gpu-checkbox" type="checkbox">
        <input id="preload-ocr-checkbox" type="checkbox">
        <input id="preload-ner-checkbox" type="checkbox">
        <div id="workspace-tabs-root"></div>
        <div class="editor-pane">
          <div id="editor-toolbar-root"></div>
          <div id="sources-list-root"></div>
          <section id="debug-section" hidden><div id="debug-panel"></div></section>
        </div>
        <b data-testid="run-bar-docs">0</b>
        <b data-testid="run-bar-tokens">0</b>
        <div data-testid="run-bar-meter" hidden><div data-testid="run-bar-meter-fill"></div></div>
        <p data-testid="run-bar-status" hidden></p>
        <div id="webmcp-control-root"></div>
        <button data-action="copy-all" data-testid="copy-all" type="button" disabled>Kopiuj wszystkie</button>
        <button data-action="anonymize" type="button" disabled>Anonimizuj</button>
      </div>
      <div data-mode-panel="deanonymize" hidden>
        <div id="deanon-workspace-root"></div>
      </div>
    </div>
  `;
}

function installWebMcpFake() {
  const tools = new Map();
  globalThis.WebMCP = class FakeWebMCP {
    constructor() {
      this.isConnected = false;
    }
    registerTool(name, _description, _schema, handler) {
      tools.set(name, handler);
    }
  };
  return tools;
}

// `emitConfigured` defaults to true to match the live boot path; the boot-failure
// cases opt out so the handshake timer / onerror path is exercised in isolation.
async function bootApp({ emitConfigured = true } = {}) {
  vi.resetModules();
  FakeWorker.instances = [];
  installToolDom();
  installWebMcpFake();
  globalThis.Worker = FakeWorker;
  let nextUuid = 2;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `s${nextUuid++}`);
  await import('./main.js');
  const worker = FakeWorker.instances[0];
  if (emitConfigured) worker.emit({ type: 'configured' });
  return worker;
}

function modelStatusText() {
  return document.querySelector('[data-status="model"]').textContent;
}

function addPasteSourceWithText(text) {
  let pasteButton = document.querySelector('[data-testid="sources-add-paste"]');
  if (!pasteButton) {
    document.querySelector('[data-testid="ws-tab-add"]')?.click();
    pasteButton = document.querySelector('[data-testid="sources-add-paste"]');
  }
  expect(pasteButton).not.toBeNull();
  pasteButton.click();
  const activeCard = document.querySelector('[data-testid^="source-card-"][data-active="true"]');
  const textarea = activeCard?.querySelector('.ann-editor-textarea')
    ?? document.querySelector('.ann-editor-textarea');
  expect(textarea).not.toBeNull();
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickAnonymize() {
  document.querySelector('[data-action="anonymize"]').click();
}

function enableGpuAndOpenWebnnHint() {
  const allowGpu = document.querySelector('#allow-gpu-checkbox');
  expect(allowGpu.checked).toBe(false);
  allowGpu.checked = true;
  allowGpu.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.querySelector('#webnn-hint').hidden).toBe(false);
  document.querySelector('#webnn-hint-trigger').click();
  expect(document.querySelector('#webnn-hint-panel').hidden).toBe(false);
}

describe('worker boot failure (#34)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    delete globalThis.Worker;
    delete globalThis.WebMCP;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces boot failure on worker.onerror before any configured message', async () => {
    const worker = await bootApp({ emitConfigured: false });
    worker.onerror(new Event('error'));
    expect(modelStatusText()).toContain('Nie udało się uruchomić');
  });

  it('surfaces boot failure after the handshake timeout elapses without configured', async () => {
    await bootApp({ emitConfigured: false });
    expect(modelStatusText()).not.toContain('Nie udało się uruchomić');
    vi.advanceTimersByTime(20000);
    expect(modelStatusText()).toContain('Nie udało się uruchomić');
  });

  it('does not report boot failure once configured arrives before the timeout', async () => {
    await bootApp({ emitConfigured: true });
    vi.advanceTimersByTime(20000);
    expect(modelStatusText()).not.toContain('Nie udało się uruchomić');
  });
});

describe('result status persistence (#41)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    delete globalThis.Worker;
    delete globalThis.WebMCP;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the no-PII result message after refreshAnonymizeButton', async () => {
    const worker = await bootApp();
    addPasteSourceWithText('test test test');
    clickAnonymize();
    worker.emit({ type: 'result', id: 's2', data: [] });
    expect(modelStatusText()).toBe('Nie znaleziono żadnych danych osobowych w tekście.');
  });

  it('keeps the worker error message after refreshAnonymizeButton', async () => {
    const worker = await bootApp();
    worker.emit({ type: 'error', message: 'Coś się stało' });
    expect(modelStatusText()).toBe('Błąd: Coś się stało');
  });
});

describe('WebNN hint copy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete window.piiDesktop;
    delete navigator.ml;
    localStorage.setItem('pii.selected-entities', JSON.stringify(['PERSON_NAME']));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete window.piiDesktop;
    delete navigator.ml;
  });

  it('shows desktop guidance without Chrome flags in Electron mode', async () => {
    window.piiDesktop = { platform: 'darwin' };
    await bootApp();

    enableGpuAndOpenWebnnHint();

    const browserCopy = document.querySelector('[data-webnn-copy="browser"]');
    const desktopCopy = document.querySelector('[data-webnn-copy="desktop"]');
    expect(browserCopy.hidden).toBe(true);
    expect(desktopCopy.hidden).toBe(false);
    expect(desktopCopy.textContent).toContain('WebNN is enabled by the desktop application.');
    expect(desktopCopy.textContent).not.toContain('chrome://flags');
  });

  it('retains browser guidance outside Electron', async () => {
    await bootApp();

    enableGpuAndOpenWebnnHint();

    const browserCopy = document.querySelector('[data-webnn-copy="browser"]');
    expect(browserCopy.hidden).toBe(false);
    expect(browserCopy.textContent)
      .toContain('chrome://flags/#web-machine-learning-neural-network');
    expect(document.querySelector('[data-webnn-copy="desktop"]').hidden).toBe(true);
  });
});
