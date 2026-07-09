// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEXT_AT_DISPATCH = 'Jan Kowalski podpisał umowę.';
const TEXT_AFTER_PREFIX_INSERT = `PILNE: ${TEXT_AT_DISPATCH}`;
const PERSON_ENTITY_FOR_DISPATCH_TEXT = {
  entity_group: 'PERSON_NAME',
  start: 0,
  end: 'Jan Kowalski'.length,
  score: 0.99,
  source: 'ner',
};

const TOKENIZED_OUTCOME_TEXT = 'Cześć [PERSON_NAME_1].';
const RAW_OUTCOME_TEXT = 'Jan Kowalski zaakceptował ugodę bez anonimizacji.';
const SECOND_QUEUED_TEXT = 'Anna Nowak czeka na decyzję.';
const DOC_B_TEXT = 'Anna Nowak czeka na decyzję.';
const DOC_B_EDITED_TEXT = 'Anna Nowak czeka na pilną decyzję.';
const PERSON_ENTITY_FOR_DOC_B = {
  entity_group: 'PERSON_NAME',
  start: 0,
  end: 'Anna Nowak'.length,
  score: 0.98,
  source: 'ner',
};

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

function mcpJson(tools, name, args = {}) {
  const response = tools.get(name)(args);
  return JSON.parse(response.content[0].text);
}

function mcpText(tools, name, args = {}) {
  const response = tools.get(name)(args);
  return response.content[0].text;
}

async function bootApp() {
  vi.resetModules();
  FakeWorker.instances = [];
  installToolDom();
  const tools = installWebMcpFake();
  globalThis.Worker = FakeWorker;
  let nextUuid = 2;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `s${nextUuid++}`);

  await import('./main.js');

  const worker = FakeWorker.instances[0];
  worker.emit({ type: 'configured' });

  return { worker, tools };
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

async function clickAnonymize() {
  document.querySelector('[data-action="anonymize"]').click();
  await Promise.resolve();
}

function classifyMessages(worker) {
  return worker.messages.filter((message) => message.type === 'classify');
}

function switchToSource(id) {
  const tab = document.querySelector(`[data-testid="ws-tab-${id}"]`);
  expect(tab).not.toBeNull();
  tab.click();
}

function renameActiveSourceTo(label) {
  const labelEl = document.querySelector('[data-testid="editor-toolbar-label"]');
  expect(labelEl).not.toBeNull();
  labelEl.click();
  const input = document.querySelector('[data-testid^="source-label-input-"]');
  expect(input).not.toBeNull();
  input.value = label;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur'));
}

function renameActiveMcpLabelTo(label) {
  const labelEl = document.querySelector('[data-testid="editor-toolbar-mcp-label"]');
  expect(labelEl).not.toBeNull();
  labelEl.click();
  const input = document.querySelector('[data-testid^="source-mcp-label-input-"]');
  expect(input).not.toBeNull();
  input.value = label;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur'));
}

function outcomeListingIsUnreadable(entry) {
  return entry == null || entry.readable === false || entry.status === 'unreadable';
}

describe('classify result text snapshots', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete globalThis.Worker;
    delete globalThis.WebMCP;
  });

  it('rejects stale NER offsets when the source text changed after dispatch', async () => {
    const { worker, tools } = await bootApp();
    addPasteSourceWithText(TEXT_AT_DISPATCH);

    await clickAnonymize();
    expect(worker.messages).toContainEqual({
      type: 'classify',
      id: 's2',
      text: TEXT_AT_DISPATCH,
    });

    const textarea = document.querySelector('.ann-editor-textarea');
    textarea.value = TEXT_AFTER_PREFIX_INSERT;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    worker.emit({ type: 'result', id: 's2', data: [PERSON_ENTITY_FOR_DISPATCH_TEXT] });

    expect(document.querySelector('[data-testid="source-status-s2"]').dataset.status).toBe('idle');
    expect(document.querySelector('[data-testid="run-bar-tokens"]').textContent).toBe('0');
    expect(document.querySelector('[data-testid="editor-toolbar-entity-count"]')).toBeNull();
    expect(mcpJson(tools, 'list_sources')).toEqual([]);
  });

  it('accepts matching NER snapshots and exposes the returned entities as ready', async () => {
    const { worker, tools } = await bootApp();
    addPasteSourceWithText(TEXT_AT_DISPATCH);

    await clickAnonymize();
    worker.emit({ type: 'result', id: 's2', data: [PERSON_ENTITY_FOR_DISPATCH_TEXT] });

    expect(document.querySelector('[data-testid="source-status-s2"]').dataset.status).toBe('ready');
    expect(document.querySelector('[data-testid="run-bar-tokens"]').textContent).toBe('1');
    expect(document.querySelector('[data-testid="editor-toolbar-entity-count"]').textContent).toBe('1 encji wykrytych');
    expect(mcpJson(tools, 'list_sources')).toEqual([
      { id: 's2', label: 'Źródło 1', char_count: '[PERSON_NAME_1] podpisał umowę.'.length },
    ]);
    expect(mcpText(tools, 'read_source', { id: 's2' })).toBe('[PERSON_NAME_1] podpisał umowę.');
  });
  it('copy all uses custom MCP labels instead of private source labels', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

    const { worker } = await bootApp();
    addPasteSourceWithText(TEXT_AT_DISPATCH);
    renameActiveSourceTo('Jan_Kowalski_vs_Anna_Nowak.pdf');
    renameActiveMcpLabelTo('Źródło MCP A');
    addPasteSourceWithText(DOC_B_TEXT);
    renameActiveSourceTo('PESEL_44051401458.docx');
    renameActiveMcpLabelTo('Źródło MCP B');
    await clickAnonymize();
    worker.emit({ type: 'result', id: 's2', data: [PERSON_ENTITY_FOR_DISPATCH_TEXT] });
    worker.emit({ type: 'result', id: 's3', data: [PERSON_ENTITY_FOR_DOC_B] });

    document.querySelector('[data-testid="copy-all"]').click();

    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = navigator.clipboard.writeText.mock.calls[0][0];
    expect(copied).toBe(
      '── Źródło MCP A ──\n[PERSON_NAME_1] podpisał umowę.\n\n── Źródło MCP B ──\n[PERSON_NAME_2] czeka na decyzję.',
    );
    expect(copied).not.toContain('Jan_Kowalski_vs_Anna_Nowak.pdf');
    expect(copied).not.toContain('PESEL_44051401458.docx');
    expect(copied).not.toContain('Jan_Kowalski');
    expect(copied).not.toContain('44051401458');
  });
});

describe('re-anonymize source selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete globalThis.Worker;
    delete globalThis.WebMCP;
  });

  it('re-classifies only changed ready sources and preserves manual annotation edits on unchanged sources', async () => {
    const { worker, tools } = await bootApp();
    addPasteSourceWithText(TEXT_AT_DISPATCH);
    addPasteSourceWithText(DOC_B_TEXT);

    await clickAnonymize();
    expect(classifyMessages(worker)).toEqual([
      { type: 'classify', id: 's2', text: TEXT_AT_DISPATCH },
    ]);

    worker.emit({ type: 'result', id: 's2', data: [PERSON_ENTITY_FOR_DISPATCH_TEXT] });
    expect(classifyMessages(worker)).toEqual([
      { type: 'classify', id: 's2', text: TEXT_AT_DISPATCH },
      { type: 'classify', id: 's3', text: DOC_B_TEXT },
    ]);

    worker.emit({ type: 'result', id: 's3', data: [PERSON_ENTITY_FOR_DOC_B] });
    expect(document.querySelector('[data-testid="source-status-s2"]').dataset.status).toBe('ready');
    expect(document.querySelector('[data-testid="source-status-s3"]').dataset.status).toBe('ready');

    switchToSource('s2');
    document.querySelector('[data-testid="source-card-s2"] .ann-ent').click();
    const typeSelect = document.querySelector('.ann-popover select');
    expect(typeSelect).not.toBeNull();
    typeSelect.value = 'LOCATION';
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mcpText(tools, 'read_source', { id: 's2' })).toBe('[LOCATION_1] podpisał umowę.');

    switchToSource('s3');
    document.querySelector('[data-testid="source-edit-s3"]').click();
    const docBTextarea = document.querySelector('[data-testid="source-card-s3"] .ann-editor-textarea');
    expect(docBTextarea).not.toBeNull();
    docBTextarea.value = DOC_B_EDITED_TEXT;
    docBTextarea.dispatchEvent(new Event('input', { bubbles: true }));

    const anonymizeButton = document.querySelector('[data-action="anonymize"]');
    expect(anonymizeButton.textContent).toBe('Anonimizuj ponownie');
    await clickAnonymize();

    expect(classifyMessages(worker)).toEqual([
      { type: 'classify', id: 's2', text: TEXT_AT_DISPATCH },
      { type: 'classify', id: 's3', text: DOC_B_TEXT },
      { type: 'classify', id: 's3', text: DOC_B_EDITED_TEXT },
    ]);
    expect(document.querySelector('[data-testid="source-status-s2"]').dataset.status).toBe('ready');
    expect(mcpText(tools, 'read_source', { id: 's2' })).toBe('[LOCATION_1] podpisał umowę.');
  });
});

describe('MCP outcome boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete globalThis.Worker;
    delete globalThis.WebMCP;
  });

  it('read_outcome rejects raw freeform outcome text without echoing it while tokenized outcomes stay readable', async () => {
    const { tools } = await bootApp();
    const tokenized = mcpJson(tools, 'write_outcome', {
      label: 'Tokenized draft',
      text: TOKENIZED_OUTCOME_TEXT,
    });
    const raw = mcpJson(tools, 'write_outcome', {
      label: 'Raw draft',
      text: RAW_OUTCOME_TEXT,
    });

    expect(mcpText(tools, 'read_outcome', { id: tokenized.id })).toBe(TOKENIZED_OUTCOME_TEXT);

    const responseText = mcpText(tools, 'read_outcome', { id: raw.id });
    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      throw new Error('read_outcome for raw freeform text must return JSON error content, not raw outcome text');
    }

    expect(responseBody).toEqual({ error: expect.any(String) });
    expect(responseText).not.toContain(RAW_OUTCOME_TEXT);
    expect(responseText).not.toContain('Jan Kowalski');
  });

  it('list_outcomes keeps tokenized outcomes readable but omits or marks raw freeform outcomes unreadable', async () => {
    const { tools } = await bootApp();
    const tokenized = mcpJson(tools, 'write_outcome', {
      label: 'Tokenized draft',
      text: TOKENIZED_OUTCOME_TEXT,
    });
    const raw = mcpJson(tools, 'write_outcome', {
      label: 'Raw draft',
      text: RAW_OUTCOME_TEXT,
    });

    const listing = mcpJson(tools, 'list_outcomes');
    expect(listing).toContainEqual({
      id: tokenized.id,
      label: 'Tokenized draft',
      char_count: TOKENIZED_OUTCOME_TEXT.length,
    });

    const rawListing = listing.find((entry) => entry.id === raw.id);
    expect(
      outcomeListingIsUnreadable(rawListing),
      `raw outcome listing must be omitted or marked unreadable; got ${JSON.stringify(rawListing)}`,
    ).toBe(true);
  });
});

describe('queued source removal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete globalThis.Worker;
    delete globalThis.WebMCP;
  });

  it('does not dispatch text for a queued source removed before its turn', async () => {
    const { worker, tools } = await bootApp();
    addPasteSourceWithText(TEXT_AT_DISPATCH);
    addPasteSourceWithText(SECOND_QUEUED_TEXT);

    await clickAnonymize();
    expect(classifyMessages(worker)).toEqual([
      { type: 'classify', id: 's2', text: TEXT_AT_DISPATCH },
    ]);

    document.querySelector('[data-testid="source-remove-s3"]').click();
    expect(document.querySelector('[data-testid="source-card-s3"]')).toBeNull();

    worker.emit({ type: 'result', id: 's2', data: [PERSON_ENTITY_FOR_DISPATCH_TEXT] });

    expect(classifyMessages(worker)).toEqual([
      { type: 'classify', id: 's2', text: TEXT_AT_DISPATCH },
    ]);
    expect(JSON.stringify(classifyMessages(worker))).not.toContain(SECOND_QUEUED_TEXT);
    expect(mcpJson(tools, 'list_sources')).toEqual([
      { id: 's2', label: 'Źródło 1', char_count: '[PERSON_NAME_1] podpisał umowę.'.length },
    ]);
  });
});
