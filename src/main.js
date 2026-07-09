import { buildTokenMapMulti, applyTokens } from './anonymizer.js';
import { buildSourceListing, buildReadSourceContent, buildOutcomeListing, buildReadOutcomeContent, createLabelSequence } from './mcp/listings.js';
import { createEntitySelector } from './ui/entity-selector.js';
import { createSourcesList } from './ui/sources-list/index.js';
import { createDeanonWorkspace } from './ui/deanon-workspace/index.js';
import { createOutcomesCoordinator } from './ui/outcomes-coordinator.js';
import { createToolModeController } from './ui/tool-mode.js';
import { createProgressOverlay } from './ui/progress-overlay.js';
import {
  createInitialProgressState,
  formatBytes,
  progressReducer,
} from './ui/progress-state.js';
import {
  createInitialFileImportProgressState,
  fileImportProgressReducer,
  getFileImportProgressView,
} from './ui/file-import-progress-state.js';
import { extractText } from './file-import/index.js';
import { holdBackgroundLock } from './background-lock.js';
import { holdDesktopActiveWork, setDesktopActiveWork } from './desktop-active-work.js';
import { backfillOccurrencesStep } from './pipeline/steps/backfill.js';
import {
  ENTITY_CATEGORIES,
  ENTITY_LABELS,
  SOURCES,
  defaultEnabledEntities,
  requiredSources,
} from './pipeline/configs/entity-sources.js';
import './style.css';
import './ui/annotation-editor/styles.css';
import './ui/sources-list/styles.css';

const worker = new Worker(new URL('./worker.js', import.meta.url), {
  type: 'module',
});
worker.onerror = () => {
  if (everConfigured) setResultStatus('Błąd analizatora: odśwież stronę, jeśli problem się powtarza.');
  else handleWorkerBootFailure();
};
worker.onmessageerror = worker.onerror;

const sources = [];
const outcomes = [];
let legend = {};
let seen = {};
const nextSourceMcpLabel = createLabelSequence('Źródło');
const nextOutcomeMcpLabel = createLabelSequence('Wynik');
let lastRun = null;
const inFlightSourceIds = new Set();
const inFlightClassifyTexts = new Map();
const inFlightFileImportIds = new Set();
let configuredOnce = false;
let everConfigured = false;
let workerBootFailed = false;
let handshakeTimer = null;
const CONFIGURE_HANDSHAKE_TIMEOUT_MS = 20000;
const urlParams = new URLSearchParams(window.location.search);
const isDebug = urlParams.get('debug') === '1';
const LS_KEY = 'pii.selected-entities';
const GPU_LS_KEY = 'pii.allow-gpu';
const PRELOAD_OCR_LS_KEY = 'pii.preload-ocr';
const PRELOAD_NER_LS_KEY = 'pii.preload-ner';

function isAnyClassifyInFlight() { return inFlightSourceIds.size > 0; }
function isAnyFileImportInFlight() { return inFlightFileImportIds.size > 0; }
function isAnyModelPredownloadInFlight() { return predownloadInFlight; }
function isBlockingModelPredownloadInFlight() { return predownloadInFlight && predownloadBlocking; }

const anonymizeBtns = document.querySelectorAll('[data-action="anonymize"]');
const copyAllBtns = document.querySelectorAll('[data-action="copy-all"]');
const modelStatusEls = document.querySelectorAll('[data-status="model"]');
const runBarDocsEl = document.querySelector('[data-testid="run-bar-docs"]');
const runBarTokensEl = document.querySelector('[data-testid="run-bar-tokens"]');
const runBarMeterEl = document.querySelector('[data-testid="run-bar-meter"]');
const runBarMeterFillEl = document.querySelector('[data-testid="run-bar-meter-fill"]');
const runBarStatusEl = document.querySelector('[data-testid="run-bar-status"]');

function setHidden(els, hidden) { els.forEach(el => { el.hidden = hidden; }); }
function setDisabled(els, disabled) { els.forEach(el => { el.disabled = disabled; }); }
function setText(els, text) { els.forEach(el => { el.textContent = text; }); }
let resultStatus = '';
function setResultStatus(text) { resultStatus = text; setText(modelStatusEls, text); }
function handleWorkerBootFailure() {
  if (everConfigured || workerBootFailed) return;
  workerBootFailed = true;
  setResultStatus('Nie udało się uruchomić modułu analizy. Odśwież stronę (Ctrl+R / Cmd+R), aby spróbować ponownie.');
  refreshAnonymizeButton();
}

const debugSection = document.getElementById('debug-section');
const debugPanel = document.getElementById('debug-panel');
const selectorRoot = document.getElementById('entity-selector-root');
const docListRoot = document.getElementById('doc-list-root');
const sourcesListRoot = document.getElementById('sources-list-root');
const workspaceTabsRoot = document.getElementById('workspace-tabs-root');
const editorToolbarRoot = document.getElementById('editor-toolbar-root');
const deanonWorkspaceRoot = document.getElementById('deanon-workspace-root');
const editorPaneEl = document.querySelector('.editor-pane');
const toolRoot = document.querySelector('.tool');
const webnnHint = document.getElementById('webnn-hint');
const webnnHintTrigger = document.getElementById('webnn-hint-trigger');
const webnnHintPanel = document.getElementById('webnn-hint-panel');
const webnnHintClose = document.getElementById('webnn-hint-close');
const webnnBrowserCopy = document.querySelector('[data-webnn-copy="browser"]');
const webnnDesktopCopy = document.querySelector('[data-webnn-copy="desktop"]');
const isDesktop = Boolean(window.piiDesktop);
if (webnnBrowserCopy) webnnBrowserCopy.hidden = isDesktop;
if (webnnDesktopCopy) webnnDesktopCopy.hidden = !isDesktop;
const webmcpControlRoot = document.getElementById('webmcp-control-root');
const allowGpuInput = document.getElementById('allow-gpu-checkbox');
const preloadOcrInput = document.getElementById('preload-ocr-checkbox');
const preloadNerInput = document.getElementById('preload-ner-checkbox');

// Keep GPU usage opt-in by default, but persist explicit user choice between sessions.

// Show the hint only when:
//   - the browser doesn't expose WebNN, AND
//   - the user opted into GPU usage, AND
//   - at least one required source for the current entity selection actually
//     supports webnn-gpu — no point nagging when the user only enabled q8-backed types.
const webnnSupported = 'ml' in navigator;
const progressOverlay = editorPaneEl ? createProgressOverlay(editorPaneEl) : null;
let progressState = createInitialProgressState();
let progressHideTimer = null;
let progressBatchTotal = 0;
let progressSourceIndex = 0;
let fileImportProgressState = createInitialFileImportProgressState();
let fileImportProgressHideTimer = null;
let fileImportAbortController = null;
let configureTimer = null;
let configRequestId = 0;
let predownloadInFlight = false;
let predownloadBlocking = false;
let predownloadRequestId = 0;
let predownloadWorkerRequest = null;
let predownloadRunBarHideTimer = null;
let ocrPreloadStarted = false;
let autoNerPreloadSatisfiedSignature = null;
let autoNerPreloadInFlightSignature = null;

function renderProgressState() {
  progressOverlay?.render(progressState);
}

function renderFileImportProgressState() {
  progressOverlay?.renderView(getFileImportProgressView(fileImportProgressState), { onCancel: () => fileImportAbortController?.abort() });
}

function updateProgress(event) {
  progressState = progressReducer(progressState, event);
  renderProgressState();
}

function fileImportStatusText() {
  const view = getFileImportProgressView(fileImportProgressState);
  if (!view.visible || view.status !== 'running') return '';
  return view.currentMetric ? `${view.currentLabel} — ${view.currentMetric}` : view.currentLabel;
}

function updateFileImportProgress(event) {
  fileImportProgressState = fileImportProgressReducer(fileImportProgressState, event);
  renderFileImportProgressState();
  const status = fileImportStatusText();
  if (status) setText(modelStatusEls, status);
}

function clearProgressHideTimer() {
  if (progressHideTimer) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
}

function clearFileImportProgressHideTimer() {
  if (fileImportProgressHideTimer) {
    clearTimeout(fileImportProgressHideTimer);
    fileImportProgressHideTimer = null;
  }
}

function scheduleProgressHide() {
  clearProgressHideTimer();
  updateProgress({ type: 'fade' });
  progressHideTimer = setTimeout(() => {
    progressHideTimer = null;
    updateProgress({ type: 'hide' });
  }, 350);
}

function scheduleFileImportProgressHide() {
  if (!getFileImportProgressView(fileImportProgressState).visible) return;
  clearFileImportProgressHideTimer();
  updateFileImportProgress({ type: 'fade' });
  fileImportProgressHideTimer = setTimeout(() => {
    fileImportProgressHideTimer = null;
    updateFileImportProgress({ type: 'hide' });
  }, 350);
}

function isGpuAllowed() {
  return Boolean(allowGpuInput?.checked);
}

function isOcrPreloadEnabled() {
  return Boolean(preloadOcrInput?.checked);
}

function isNerPreloadEnabled() {
  return Boolean(preloadNerInput?.checked);
}

function requestedBackend() {
  return isGpuAllowed() ? 'auto' : 'wasm';
}

function beginConfigureRequest() {
  configRequestId += 1;
  configuredOnce = false;
  autoNerPreloadSatisfiedSignature = null;
  refreshAnonymizeButton();
  return configRequestId;
}

function postConfigureForRequest(enabledEntities, requestId) {
  worker.postMessage({
    type: 'configure',
    enabledEntities,
    backend: requestedBackend(),
    configRequestId: requestId,
  });
}

function postConfigure(enabledEntities) {
  postConfigureForRequest(enabledEntities, beginConfigureRequest());
}

function isCurrentConfigMessage(msg) {
  return msg.configRequestId == null || msg.configRequestId === configRequestId;
}

function shouldShowWebnnHint(enabledEntities) {
  if (webnnSupported) return false;
  if (!isGpuAllowed()) return false;
  return requiredSources(enabledEntities).some((alias) => {
    const def = SOURCES[alias];
    return def?.kind === 'hf' && def.backends?.includes('webnn-gpu');
  });
}

function setWebnnPanelOpen(open) {
  webnnHintPanel.hidden = !open;
  webnnHintTrigger.setAttribute('aria-expanded', String(open));
}

function updateWebnnHint(enabledEntities) {
  const show = shouldShowWebnnHint(enabledEntities);
  webnnHint.hidden = !show;
  document.body.classList.toggle('has-webnn-hint', show);
  if (!show) setWebnnPanelOpen(false);
}

webnnHintTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  setWebnnPanelOpen(webnnHintPanel.hidden);
});

webnnHintClose.addEventListener('click', () => {
  setWebnnPanelOpen(false);
});

// Click outside the panel closes it.
document.addEventListener('click', (e) => {
  if (webnnHint.hidden || webnnHintPanel.hidden) return;
  if (!webnnHint.contains(e.target)) setWebnnPanelOpen(false);
});

function loadSelectionFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((e) => typeof e === 'string');
  } catch {
    return null;
  }
}

function loadBooleanFromStorage(key, fallback = false) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) === true;
  } catch {
    return fallback;
  }
}

function persistBoolean(key, value) {
  try { localStorage.setItem(key, JSON.stringify(Boolean(value))); } catch {}
}

const initialSelection = loadSelectionFromStorage() ?? defaultEnabledEntities();
const initialAllowGpu = loadBooleanFromStorage(GPU_LS_KEY);
const initialPreloadOcr = loadBooleanFromStorage(PRELOAD_OCR_LS_KEY);
const initialPreloadNer = loadBooleanFromStorage(PRELOAD_NER_LS_KEY);
if (allowGpuInput) allowGpuInput.checked = initialAllowGpu;
if (preloadOcrInput) preloadOcrInput.checked = initialPreloadOcr;
if (preloadNerInput) preloadNerInput.checked = initialPreloadNer;

function scheduleConfigure(enabledEntities) {
  clearTimeout(configureTimer);
  const requestId = beginConfigureRequest();
  configureTimer = setTimeout(() => {
    postConfigureForRequest(enabledEntities, requestId);
  }, 300);
}

const selector = createEntitySelector(selectorRoot, {
  categories: ENTITY_CATEGORIES,
  labels: ENTITY_LABELS,
  initial: initialSelection,
  onChange(selected) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(selected)); } catch {}
    refreshAnonymizeButton();
    updateWebnnHint(selected);
    scheduleConfigure(selected);
  },
});

allowGpuInput?.addEventListener('change', () => {
  persistBoolean(GPU_LS_KEY, isGpuAllowed());
  const selected = selector.getSelected();
  updateWebnnHint(selected);
  clearTimeout(configureTimer);
  postConfigure(selected);
});

preloadOcrInput?.addEventListener('change', () => {
  persistBoolean(PRELOAD_OCR_LS_KEY, isOcrPreloadEnabled());
  if (isOcrPreloadEnabled()) scheduleOcrPreload();
});

preloadNerInput?.addEventListener('change', () => {
  persistBoolean(PRELOAD_NER_LS_KEY, isNerPreloadEnabled());
  if (isNerPreloadEnabled()) maybeAutoPreloadNer();
});

updateWebnnHint(initialSelection);

postConfigure(selector.getSelected());
handshakeTimer = setTimeout(handleWorkerBootFailure, CONFIGURE_HANDSHAKE_TIMEOUT_MS);

function runWhenIdle(fn) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout: 1500 });
    return;
  }
  setTimeout(fn, 0);
}

function scheduleOcrPreload() {
  if (ocrPreloadStarted) return;
  ocrPreloadStarted = true;
  runWhenIdle(() => {
    import('./ocr/index.js').then(({ getWorkerBackedOcr }) => {
      const ocr = getWorkerBackedOcr();
      if (!isAnyClassifyInFlight() && !isAnyFileImportInFlight() && !isAnyModelPredownloadInFlight()) {
        setText(modelStatusEls, 'Przygotowywanie OCR…');
      }
      return ocr.init?.();
    }).catch((err) => {
      console.warn('[main] OCR preload failed:', err);
    }).finally(() => {
      if (!isAnyClassifyInFlight() && !isAnyFileImportInFlight() && !isAnyModelPredownloadInFlight()) {
        setText(modelStatusEls, '');
      }
    });
  });
}

const ocrWarm = urlParams.get('ocr') === 'warm';
if (initialPreloadOcr || ocrWarm) scheduleOcrPreload();

const sourcesList = createSourcesList(sourcesListRoot, {
  tabsHost: workspaceTabsRoot,
  toolbarHost: editorToolbarRoot,
  entityCategories: ENTITY_CATEGORIES,
  entityLabels: ENTITY_LABELS,
  postEdit(text, entities) {
    return backfillOccurrencesStep({ text, entities }).entities;
  },
  onAddPaste() {
    const id = crypto.randomUUID();
    const label = nextPasteLabel();
    const mcpLabel = nextSourceMcpLabel();
    sources.push({
      id, label, mcpLabel, text: '', entities: [], meta: null, status: 'idle', error: null, lastReadyText: null,
    });
    sourcesList.addSource(id, label, {
      text: '', entities: [], status: 'idle', type: 'paste', mcpLabel,
    });
    sourcesList.setActive(id);
    sourcesList.enterTextMode(id);
    refreshAnonymizeButton();
  },
  async onAddFiles(files) {
    const batch = Array.from(files ?? []);
    if (batch.length === 0) return;
    fileImportAbortController = new AbortController();
    updateFileImportProgress({ type: 'batch-start', total: batch.length, t: performance.now() });
    let index = 0;
    for (const file of batch) {
      if (fileImportAbortController.signal.aborted) break;
      index += 1;
      await addSourceFromFile(file, { index, total: batch.length });
    }
  },
  onRemove(id) {
    const idx = sources.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const removed = sources[idx];
    if (removed.status === 'ready' && removed.entities.length > 0) {
      const ok = window.confirm(`Usunąć "${removed.label}"?`);
      if (!ok) return;
    }
    sources.splice(idx, 1);
    const removedQueued = removePendingClassify(id);
    if (removedQueued) inFlightSourceIds.delete(id);
    syncClassifyLock();
    sourcesList.removeSource(id);
    refreshLegend();
    refreshAnonymizeButton();
  },
  onRename(id, label) {
    const s = sources.find((x) => x.id === id);
    if (s) s.label = label;
  },
  getGlobalSeen: () => seen,
  onMcpLabelChange(id, mcpLabel) {
    const s = sources.find((x) => x.id === id);
    if (s) s.mcpLabel = mcpLabel;
  },
  onAnnotationChange(id, entities) {
    const s = sources.find((x) => x.id === id);
    if (!s) return;
    s.entities = entities;
    refreshLegend();
  },
  onTextChange(id, text) {
    const s = sources.find((x) => x.id === id);
    if (!s) return;
    s.text = text;
    refreshAnonymizeButton();
    maybeAutoPreloadNer();
  },
  onTextDirtyChange(id, dirty) {
    updateSourceDirtyState(id, dirty);
  },
  onModeChange() { refreshAnonymizeButton(); },
});
sourcesList.renderDocList(docListRoot);

const deanonWorkspace = createDeanonWorkspace(deanonWorkspaceRoot, {
  getOutcomes: () => outcomes,
  getLegend: () => legend,
  entityLabels: ENTITY_LABELS,
  onAdd(label, text) {
    createOutcome(label, text, nextOutcomeMcpLabel());
  },
  onUpdate(id, label, text) {
    updateOutcomeFields(id, label, text);
  },
  onRemove(id) {
    removeOutcome(id);
  },
  onExport(format) {
    return exportDeanonDocuments(format);
  },
});

const outcomeCoordinator = createOutcomesCoordinator({
  outcomes,
  deanonWorkspace,
  getLegend: () => legend,
});

deanonWorkspace.render();

const modeController = createToolModeController(toolRoot, {
  onChange(mode) {
    if (mode === 'deanonymize') deanonWorkspace.render();
  },
});

// Single code path for outcome creation — used by both the deanonymize-tab UI
// affordance and the write_outcome MCP handler. Caller is responsible for
// validating `label` and `text` are non-empty strings.
function createOutcome(label, text, mcpLabel) {
  return outcomeCoordinator.createOutcome(label, text, mcpLabel);
}

// Single code path for outcome updates — used by both the inline edit
// affordance and the write_outcome MCP handler's update branch. Returns
// true on success, false if the id is unknown.
function updateOutcomeFields(id, label, text, opts) {
  return outcomeCoordinator.updateOutcomeFields(id, label, text, opts);
}

function removeOutcome(id) {
  return outcomeCoordinator.removeOutcome(id);
}

async function exportDeanonDocuments(format) {
  const { exportDeanonOutcomes, downloadBlob } = await import('./export/deanon.js');
  const result = await exportDeanonOutcomes({
    outcomes: outcomes.map((o) => ({ id: o.id, label: o.label, text: o.text, legendSnapshot: o.legendSnapshot })),
    legend: { ...legend },
    format,
  });
  downloadBlob(result.blob, result.fileName);
  return result;
}

function nextPasteLabel() {
  const used = sources
    .map((s) => /^Wklejony tekst (\d+)$/.exec(s.label)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return `Wklejony tekst ${next}`;
}

async function addSourceFromFile(file, batch = {}) {
  const batchIndex = batch.index ?? 1;
  const batchTotal = batch.total ?? 1;
  const isLastInBatch = batchIndex >= batchTotal;
  const id = crypto.randomUUID();
  const label = file.name || `Plik ${sources.length + 1}`;
  const mcpLabel = nextSourceMcpLabel();
  sources.push({
    id, label, mcpLabel, text: '', entities: [], meta: null, status: 'pending', error: null, lastReadyText: null,
  });
  sourcesList.addSource(id, label, {
    text: '', entities: [], status: 'pending', type: 'file', mcpLabel,
  });
  sourcesList.setActive(id);
  inFlightFileImportIds.add(id);
  clearFileImportProgressHideTimer();
  updateFileImportProgress({
    type: 'file-start',
    id,
    label,
    index: batchIndex,
    total: batchTotal,
    t: performance.now(),
  });
  refreshAnonymizeButton();

  const onProgress = (event) => updateFileImportProgress({
    ...event,
    type: 'progress',
    id,
    label,
    batchIndex,
    batchTotal,
    t: performance.now(),
  });
  const onModelLoad = (event) => updateFileImportProgress({
    type: 'model-load',
    mark: event.type,
    engine: event.engine,
    id,
    label,
    batchIndex,
    batchTotal,
    t: performance.now(),
  });

  // Keeps OCR/import alive while the tab is hidden (see background-lock.js).
  const releaseImportLock = holdBackgroundLock('pii-file-import');
  const releaseDesktopImportWork = await holdDesktopActiveWork('pii-file-import');
  try {
    const { text, meta } = await extractText(file, { onProgress, onModelLoad, signal: fileImportAbortController?.signal });
    const s = sources.find((x) => x.id === id);
    if (s) {
      s.text = text;
      s.meta = meta;
      s.status = 'idle';
      s.error = null;
      sourcesList.setSourceText(id, text);
      sourcesList.setSourceStatus(id, 'idle');
    }
    if (isLastInBatch) {
      updateFileImportProgress({ type: 'file-result', id, label, t: performance.now() });
      scheduleFileImportProgressHide();
    }
  } catch (err) {
    const message = err.name === 'OcrCancelledError' ? 'Import anulowany' : err.message;
    const s = sources.find((x) => x.id === id);
    if (s) {
      s.status = 'error';
      s.error = message;
      sourcesList.setSourceStatus(id, 'error', message);
    }
    updateFileImportProgress({ type: 'error', id, label, message, t: performance.now() });
    if (isLastInBatch) scheduleFileImportProgressHide();
  } finally {
    releaseImportLock();
    await releaseDesktopImportWork();
    inFlightFileImportIds.delete(id);
    if (isLastInBatch) {
      if (!isAnyFileImportInFlight() && !isAnyClassifyInFlight()) setText(modelStatusEls, '');
      refreshAnonymizeButton();
      maybeAutoPreloadNer();
    }
  }
}

function updateSourceDirtyState(id, dirty) {
  const s = sources.find((x) => x.id === id);
  if (!s) return;

  const canRestoreReady = s.lastReadyText !== null && s.text === s.lastReadyText;
  const nextStatus = dirty ? 'idle' : (canRestoreReady ? 'ready' : s.status);
  if (nextStatus !== s.status) {
    s.status = nextStatus;
    sourcesList.setSourceStatus(id, nextStatus);
    refreshLegend();
  }
  refreshAnonymizeButton();
}

function refreshLegend() {
  const ready = sources.filter((s) => s.status === 'ready' && s.entities.length > 0);
  if (ready.length === 0) {
    legend = {};
    seen = {};
    outcomeCoordinator.refreshLegend({});
    return;
  }
  const built = buildTokenMapMulti(
    ready.map((s) => ({ text: s.text, entities: s.entities })),
  );
  seen = built.seen;
  legend = built.legend;
  outcomeCoordinator.refreshLegend(legend);
}

function anonymizedTextFor(sourceId) {
  const s = sources.find((x) => x.id === sourceId);
  if (!s || s.status !== 'ready') return null;
  return applyTokens(s.text, s.entities, seen);
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function refreshAnonymizeButton() {
  const hasSelection = selector.getSelected().length > 0;
  const hasAnyText = sources.some((s) => (s.text ?? '').trim().length > 0);
  const blocked = !configuredOnce
    || isAnyClassifyInFlight()
    || isAnyFileImportInFlight()
    || isBlockingModelPredownloadInFlight();
  setDisabled(anonymizeBtns, blocked || !hasSelection || !hasAnyText);
  if (isAnyFileImportInFlight() && !isAnyClassifyInFlight()) {
    setText(anonymizeBtns, 'Wczytywanie pliku...');
  } else if (isBlockingModelPredownloadInFlight() && !isAnyClassifyInFlight()) {
    setText(anonymizeBtns, 'Pobieranie modeli...');
  } else if (!isAnyClassifyInFlight()) {
    const hasReclassify = sources.some((s) =>
      s.lastReadyText !== null && s.text !== s.lastReadyText && (s.text ?? '').trim().length > 0,
    );
    setText(anonymizeBtns, hasReclassify ? 'Anonimizuj ponownie' : 'Anonimizuj');
  }
  if (!hasSelection) setText(modelStatusEls, 'Wybierz przynajmniej jedną encję.');
  else if (!isAnyClassifyInFlight() && !isAnyFileImportInFlight() && !isBlockingModelPredownloadInFlight()) setText(modelStatusEls, resultStatus);
  refreshRunBar();
}

function hasAnyNonEmptyDocument() {
  return sources.some((s) => (s.text ?? '').trim().length > 0);
}

function currentNerPreloadSignature() {
  const enabledEntities = selector.getSelected();
  if (enabledEntities.length === 0) return null;
  const aliases = requiredSources(enabledEntities)
    .filter((alias) => SOURCES[alias]?.kind === 'hf')
    .sort();
  if (aliases.length === 0) return null;
  return JSON.stringify({ aliases, backend: requestedBackend() });
}

function markCurrentNerPreloadSatisfied() {
  const signature = currentNerPreloadSignature();
  if (signature) autoNerPreloadSatisfiedSignature = signature;
}

function maybeAutoPreloadNer() {
  if (!isNerPreloadEnabled()) return;
  if (!configuredOnce) return;
  if (!hasAnyNonEmptyDocument()) return;
  if (document.visibilityState === 'hidden') return;
  if (isAnyModelPredownloadInFlight() || isAnyClassifyInFlight() || isAnyFileImportInFlight()) return;

  const signature = currentNerPreloadSignature();
  if (!signature) return;
  if (signature === autoNerPreloadSatisfiedSignature) return;
  if (signature === autoNerPreloadInFlightSignature) return;

  autoNerPreloadInFlightSignature = signature;
  predownloadModels({ includeOcr: false, includeNer: true, auto: true })
    .then((ok) => {
      if (ok && currentNerPreloadSignature() === signature) {
        autoNerPreloadSatisfiedSignature = signature;
      }
    })
    .catch((err) => console.warn('[main] automatic NER preload failed:', err))
    .finally(() => {
      if (autoNerPreloadInFlightSignature === signature) autoNerPreloadInFlightSignature = null;
    });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeAutoPreloadNer();
});

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// The bottom run-bar meter/status are intentionally independent from the
// overlay progress UI and are used for background model preloads.
function ensureRunBarMeterSweep() {
  if (!runBarMeterEl) return null;
  let sweep = runBarMeterEl.querySelector('.meter-sweep');
  if (!sweep) {
    sweep = document.createElement('div');
    sweep.className = 'meter-sweep';
    sweep.setAttribute('aria-hidden', 'true');
    runBarMeterEl.appendChild(sweep);
  }
  return sweep;
}

function setRunBarMeterProgress(percent = 0, { visible = true } = {}) {
  const clamped = clampPercent(percent);
  const sweep = ensureRunBarMeterSweep();
  if (runBarMeterFillEl) runBarMeterFillEl.style.width = `${clamped}%`;
  if (runBarMeterEl) {
    runBarMeterEl.hidden = !visible;
    runBarMeterEl.classList.remove('meter-segment-indeterminate');
    runBarMeterEl.setAttribute('aria-valuenow', String(Math.round(clamped)));
    runBarMeterEl.setAttribute('aria-valuetext', `${Math.round(clamped)}%`);
  }
  if (sweep) sweep.hidden = true;
}

function setRunBarMeterSegmentProgress({ completed = 0, total = 0, status = 'loading', visible = true } = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCompleted = safeTotal > 0
    ? Math.min(safeTotal, Math.max(0, Number(completed) || 0))
    : 0;
  const percent = safeTotal > 0 ? (safeCompleted / safeTotal) * 100 : 100;
  const loading = status === 'loading' && safeCompleted < safeTotal;
  const sweep = ensureRunBarMeterSweep();

  if (runBarMeterFillEl) runBarMeterFillEl.style.width = `${clampPercent(percent)}%`;
  if (runBarMeterEl) {
    runBarMeterEl.hidden = !visible;
    runBarMeterEl.classList.toggle('meter-segment-indeterminate', loading);
    runBarMeterEl.setAttribute('aria-valuenow', String(Math.round(clampPercent(percent))));
    runBarMeterEl.setAttribute('aria-valuetext', safeTotal > 0 ? `${safeCompleted}/${safeTotal}` : '');
  }

  if (!sweep) return;
  sweep.hidden = !loading;
  if (!loading || safeTotal <= 0) return;

  const segmentStart = (safeCompleted / safeTotal) * 100;
  const segmentEnd = (Math.min(safeCompleted + 1, safeTotal) / safeTotal) * 100;
  const segmentWidth = Math.max(0, segmentEnd - segmentStart);
  const sweepWidth = segmentWidth * 0.45;
  const sweepTo = Math.max(segmentStart, segmentEnd - sweepWidth);
  sweep.style.setProperty('--sweep-from', `${segmentStart}%`);
  sweep.style.setProperty('--sweep-to', `${sweepTo}%`);
  sweep.style.setProperty('--sweep-width', `${sweepWidth}%`);
}

function setRunBarStatus(text = '', { title = text } = {}) {
  if (!runBarStatusEl) return;
  const value = String(text ?? '');
  runBarStatusEl.textContent = value;
  runBarStatusEl.title = value.length > 0 ? String(title ?? value) : '';
  runBarStatusEl.hidden = value.length === 0;
}

setRunBarMeterProgress(0, { visible: false });
setRunBarStatus('');

function clearPredownloadRunBarHideTimer() {
  if (predownloadRunBarHideTimer) {
    clearTimeout(predownloadRunBarHideTimer);
    predownloadRunBarHideTimer = null;
  }
}

function schedulePredownloadRunBarHide() {
  clearPredownloadRunBarHideTimer();
  predownloadRunBarHideTimer = setTimeout(() => {
    predownloadRunBarHideTimer = null;
    if (isAnyModelPredownloadInFlight()) return;
    setRunBarMeterProgress(0, { visible: false });
    setRunBarStatus('');
  }, 4500);
}

function stablePercent(value) {
  return `${String(Math.round(clampPercent(value))).padStart(3, '\u00A0')}%`;
}

function compactPredownloadStatus(label, progress, detail = '') {
  const text = `${label} — ${stablePercent(progress)}`;
  return { text, title: detail ? `${text} · ${detail}` : text };
}

function predownloadProgressText(phase, event, overallPct) {
  if (phase === 'ner') return nerPredownloadProgressText(event, overallPct);
  if (phase === 'ner-load') return nerLoadProgressText(event, overallPct);
  if (phase === 'ocr-load') return ocrLoadProgressText(event, overallPct);
  return ocrPredownloadProgressText(event, overallPct);
}

function nerPredownloadProgressText(event, overallPct) {
  const totalBytes = Number(event.totalBytes ?? 0);
  const loadedBytes = Number(event.loadedBytes ?? 0);
  const file = event.file ?? '';
  const bytes = totalBytes > 0 ? `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}` : '';
  const detail = [file, bytes].filter(Boolean).join(' · ');

  if (event.status === 'plan') return { text: 'Modele NER — cache', title: 'Sprawdzanie cache modeli NER' };
  if ((event.remainingFiles ?? 0) === 0 && totalBytes === 0) {
    return { text: 'Modele NER — gotowe', title: 'Modele NER są już w cache' };
  }
  return compactPredownloadStatus('Pobieranie NER', overallPct, detail);
}

function deviceLabel(device) {
  if (device === 'webnn-gpu') return 'WebNN GPU';
  if (device === 'wasm') return 'WASM';
  return device || '';
}

function nerLoadProgressText(event) {
  const total = Math.max(0, Number(event.total ?? 0));
  const completed = total > 0 ? Math.min(total, Math.max(0, Number(event.completed ?? 0))) : 0;
  const source = event.source ?? event.alias ?? '';
  const device = deviceLabel(event.device);
  const count = total > 0 ? `${completed}/${total}` : '';
  const countDetail = total > 0 ? `${completed}/${total} modeli` : '';
  const detail = [source, device, countDetail].filter(Boolean).join(' · ');

  if (event.status === 'plan') {
    return {
      text: count ? `Ładowanie NER — ${count}` : 'Modele NER — ładowanie',
      title: detail || 'Ładowanie sesji modeli NER do wybranego runtime',
    };
  }
  if (event.status === 'complete') {
    return {
      text: count ? `Modele NER — ${count}` : 'Modele NER — załadowane',
      title: detail || 'Modele NER są załadowane',
    };
  }
  return {
    text: count ? `Ładowanie NER — ${count}` : 'Ładowanie NER',
    title: detail || 'Ładowanie sesji modeli NER do wybranego runtime',
  };
}

function ocrPredownloadProgressText(event, overallPct) {
  const totalFiles = Number(event.totalFiles ?? 0);
  const completedFiles = Number(event.completedFiles ?? 0);
  const remainingFiles = Number(event.remainingFiles ?? 0);
  const file = event.file ?? '';
  const fileLoadedBytes = Number(event.fileLoadedBytes ?? 0);
  const fileTotalBytes = Number(event.fileTotalBytes ?? 0);
  const bytes = fileTotalBytes > 0 ? `${formatBytes(fileLoadedBytes)} / ${formatBytes(fileTotalBytes)}` : '';
  const files = totalFiles > 0 ? `${completedFiles}/${totalFiles} plików` : '';
  const detail = [file, bytes, files].filter(Boolean).join(' · ');

  if (event.status === 'plan') return { text: 'Modele OCR — cache', title: 'Sprawdzanie cache modeli OCR' };
  if (event.status === 'complete') return { text: 'Modele OCR — gotowe', title: 'Pobrano modele OCR' };
  if (event.status === 'cached' && (remainingFiles === 0 || completedFiles === totalFiles)) {
    return { text: 'Modele OCR — gotowe', title: 'Modele OCR są już w cache' };
  }
  if (event.status === 'cached') {
    return { text: 'Modele OCR — cache', title: detail ? `Model OCR z cache · ${detail}` : 'Model OCR z cache' };
  }
  return compactPredownloadStatus('Pobieranie OCR', overallPct, detail);
}

function ocrLoadProgressText(event, overallPct) {
  if (event.status === 'ready' || event.status === 'complete') {
    return { text: 'Modele OCR — załadowane', title: 'Modele OCR są załadowane w PaddleOCR' };
  }
  return compactPredownloadStatus('Ładowanie OCR', overallPct, 'PaddleOCR');
}

function updatePredownloadRunBar(phase, event = {}) {
  const pct = clampPercent(event.progress ?? 0);
  const status = predownloadProgressText(phase, event, pct);
  if (phase === 'ner-load') {
    setRunBarMeterSegmentProgress({
      completed: event.completed ?? 0,
      total: event.total ?? 0,
      status: event.status ?? 'loading',
      visible: true,
    });
  } else {
    setRunBarMeterProgress(pct, { visible: true });
  }
  setRunBarStatus(status.text, { title: status.title });
}

function waitForNerPredownload(requestId) {
  return new Promise((resolve, reject) => {
    predownloadWorkerRequest = { requestId, resolve, reject };
    worker.postMessage({
      type: 'predownload-models',
      requestId,
      enabledEntities: selector.getSelected(),
      backend: requestedBackend(),
    });
  });
}

async function predownloadOcrModels(requestId) {
  const { getWorkerBackedOcr } = await import('./ocr/index.js');
  const ocr = getWorkerBackedOcr();
  let sawLoadEvent = false;

  ocr.onProgress?.((event) => {
    if (requestId !== predownloadRequestId || !isAnyModelPredownloadInFlight()) return;
    if (event.stage === 'model-download') updatePredownloadRunBar('ocr', event);
  });

  ocr.onModelLoad?.((event) => {
    if (requestId !== predownloadRequestId || !isAnyModelPredownloadInFlight()) return;
    sawLoadEvent = true;
    const isDone = event.type === 'model:load:end';
    updatePredownloadRunBar('ocr-load', {
      status: isDone ? 'ready' : 'loading',
      progress: isDone ? 100 : 0,
      engine: event.engine,
    });
  });

  await ocr.init?.();
  if (!sawLoadEvent && requestId === predownloadRequestId && isAnyModelPredownloadInFlight()) {
    updatePredownloadRunBar('ocr-load', { status: 'ready', progress: 100 });
  }
}

async function predownloadModels({ includeOcr = true, includeNer = true, auto = false } = {}) {
  if (!configuredOnce || selector.getSelected().length === 0 || isAnyModelPredownloadInFlight() || isAnyClassifyInFlight() || isAnyFileImportInFlight()) {
    return false;
  }
  if (!includeOcr && !includeNer) return true;

  const requestId = predownloadRequestId + 1;
  predownloadRequestId = requestId;
  predownloadInFlight = true;
  predownloadBlocking = !auto;
  clearPredownloadRunBarHideTimer();
  setRunBarMeterProgress(0, { visible: true });
  setRunBarStatus(
    includeOcr ? 'Modele OCR — cache' : 'Modele NER — cache',
    { title: includeOcr ? 'Sprawdzanie cache modeli OCR' : 'Sprawdzanie cache modeli NER' },
  );
  refreshAnonymizeButton();

  const nerSignatureAtStart = includeNer ? currentNerPreloadSignature() : null;
  let errorMessage = '';
  try {
    if (includeOcr) {
      await predownloadOcrModels(requestId);
      if (requestId !== predownloadRequestId) return false;
    }
    if (includeNer) {
      setRunBarMeterProgress(0, { visible: true });
      setRunBarStatus('Modele NER — cache', { title: 'Sprawdzanie cache modeli NER' });
      await waitForNerPredownload(requestId);
      if (requestId !== predownloadRequestId) return false;
      if (nerSignatureAtStart && currentNerPreloadSignature() === nerSignatureAtStart) {
        autoNerPreloadSatisfiedSignature = nerSignatureAtStart;
      }
    }
    setRunBarMeterProgress(100, { visible: true });
    if (includeOcr && includeNer) {
      setRunBarStatus('Modele są pobrane i załadowane.', { title: 'Modele OCR i NER są pobrane, zapisane w cache i załadowane' });
    } else if (includeNer) {
      setRunBarStatus('Modele NER są pobrane i załadowane.', { title: 'Modele NER są pobrane, zapisane w cache i załadowane' });
    } else {
      setRunBarStatus('Modele OCR są pobrane i załadowane.', { title: 'Modele OCR są pobrane, zapisane w cache i załadowane' });
    }
    return true;
  } catch (err) {
    errorMessage = err?.message ?? String(err);
    console.error('[main] model pre-download/load failed:', err);
    setRunBarStatus('Błąd pobierania modeli', { title: errorMessage });
    return false;
  } finally {
    if (predownloadWorkerRequest?.requestId === requestId) predownloadWorkerRequest = null;
    if (requestId === predownloadRequestId) {
      predownloadInFlight = false;
      predownloadBlocking = false;
      refreshAnonymizeButton();
      if (errorMessage) setResultStatus(`Błąd pobierania modeli: ${errorMessage}`);
      else {
        schedulePredownloadRunBarHide();
        maybeAutoPreloadNer();
      }
    }
  }
}

function refreshRunBar() {
  if (runBarDocsEl) runBarDocsEl.textContent = String(sources.length);
  const totalEntities = sources.reduce(
    (acc, s) => acc + (s.status === 'ready' ? s.entities.length : 0),
    0,
  );
  if (runBarTokensEl) runBarTokensEl.textContent = String(totalEntities);

  // Copy-all is meaningful only when at least one source is ready.
  const anyReady = sources.some((s) => s.status === 'ready');
  setDisabled(copyAllBtns, !anyReady || isAnyClassifyInFlight());
}

// Single-flight queue: dispatch one classify at a time. The worker's
// model-eviction logic was designed assuming only one classify is in
// flight; concurrent classifies can dispose a session another classify
// is mid-inference on. The NER cache makes second-and-later classifies
// in a batch cheap, so the perceived overhead is small.
const pendingClassifies = [];

// Held for the whole classify batch so hidden-tab freezing (Edge sleeping
// tabs, Chrome tab freeze) and intensive timer throttling don't stall it.
let releaseClassifyLock = null;
let desktopClassifyActive = false;

function syncClassifyLock() {
  if (isAnyClassifyInFlight()) {
    releaseClassifyLock ??= holdBackgroundLock('pii-anonymize');
  } else if (releaseClassifyLock) {
    releaseClassifyLock();
    releaseClassifyLock = null;
  }
  if (!isAnyClassifyInFlight() && desktopClassifyActive) {
    desktopClassifyActive = false;
    void setDesktopActiveWork('pii-anonymize', false);
  }
}

function removePendingClassify(id) {
  const before = pendingClassifies.length;
  for (let i = pendingClassifies.length - 1; i >= 0; i -= 1) {
    if (pendingClassifies[i].id === id) pendingClassifies.splice(i, 1);
  }
  return pendingClassifies.length !== before;
}

function dispatchNextClassify() {
  let next = null;
  while (pendingClassifies.length > 0) {
    const candidate = pendingClassifies.shift();
    if (sources.some((s) => s.id === candidate.id)) {
      next = candidate;
      break;
    }
    inFlightSourceIds.delete(candidate.id);
  }
  syncClassifyLock();
  if (!next) return;
  inFlightClassifyTexts.set(next.id, next.text);
  clearProgressHideTimer();
  progressSourceIndex += 1;
  updateProgress({
    type: 'source-start',
    id: next.id,
    index: progressSourceIndex,
    total: progressBatchTotal || 1,
    t: performance.now(),
  });
  worker.postMessage({ type: 'classify', id: next.id, text: next.text });
}

worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'predownload-progress': {
      if (msg.requestId !== predownloadRequestId || !isAnyModelPredownloadInFlight()) break;
      updatePredownloadRunBar(msg.phase, msg);
      break;
    }
    case 'predownload-result': {
      if (predownloadWorkerRequest?.requestId === msg.requestId) {
        const { resolve } = predownloadWorkerRequest;
        predownloadWorkerRequest = null;
        resolve(msg);
      }
      break;
    }
    case 'predownload-error': {
      if (predownloadWorkerRequest?.requestId === msg.requestId) {
        const { reject } = predownloadWorkerRequest;
        predownloadWorkerRequest = null;
        reject(new Error(msg.message));
      }
      break;
    }
    case 'progress':
    case 'download-progress': {
      const pct = Math.round(msg.progress ?? 0);
      const loadedBytes = Number(msg.loadedBytes ?? 0);
      const totalBytes = Number(msg.totalBytes ?? 0);
      const cached = (msg.remainingFiles ?? 1) === 0 && totalBytes === 0;
      const bytes = totalBytes > 0 ? ` (${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)})` : '';
      setText(
        modelStatusEls,
        cached ? 'Modele są już pobrane.' : `Pobieranie modeli... ${pct}%${bytes}`,
      );
      updateProgress({
        ...msg,
        type: 'download-progress',
        progress: pct,
        t: performance.now(),
      });
      break;
    }
    case 'model-load-plan':
    case 'model-load-progress': {
      updateProgress({ ...msg, t: performance.now() });
      const total = Number(msg.total ?? msg.models ?? 0);
      const completed = Number(msg.completed ?? 0);
      if (total > 0) {
        const text = msg.status === 'loading'
          ? `Ładowanie modeli ${completed}/${total}…`
          : `Załadowano modele ${completed}/${total}…`;
        setText(modelStatusEls, text);
      } else {
        setText(modelStatusEls, 'Brak modeli do załadowania — używam cache lub reguł.');
      }
      break;
    }
    case 'ner-plan':
    case 'ner-progress': {
      updateProgress({ ...msg, t: performance.now() });
      if ((msg.total ?? 0) > 0) {
        setText(modelStatusEls, `Analizowanie segmentów ${msg.completed ?? 0}/${msg.total}…`);
      }
      break;
    }
    case 'backend-resolved': {
      if (!isCurrentConfigMessage(msg)) break;
      const detail = msg.requested === 'auto'
        ? (msg.webnnAvailable ? 'available — fp32 models will run on GPU' : 'unavailable — all models on WASM')
        : 'GPU disabled — all models on WASM';
      console.log(`[main] WebNN ${detail} (requested=${msg.requested})`);
      break;
    }
    case 'configured':
      if (!isCurrentConfigMessage(msg)) break;
      everConfigured = true;
      clearTimeout(handshakeTimer);
      configuredOnce = true;
      refreshAnonymizeButton();
      maybeAutoPreloadNer();
      break;
    case 'result': {
      console.log(`[bench-timing] result t=${performance.now().toFixed(2)}`);
      const id = msg.id;
      updateProgress({ type: 'result', id, t: performance.now() });
      const s = sources.find((x) => x.id === id);
      const dispatchedText = inFlightClassifyTexts.get(id);
      if (s && dispatchedText === s.text) {
        s.entities = msg.data;
        s.status = 'ready';
        s.error = null;
        s.lastReadyText = s.text;
        sourcesList.setSourceEntities(id, msg.data);
        sourcesList.setSourceStatus(id, 'ready');
      } else if (s) {
        s.entities = [];
        s.status = 'idle';
        s.error = null;
        s.lastReadyText = null;
        sourcesList.setSourceEntities(id, []);
        sourcesList.setSourceStatus(id, 'idle');
      }
      inFlightClassifyTexts.delete(id);
      inFlightSourceIds.delete(id);
      dispatchNextClassify();
      refreshLegend();
      if (isDebug && msg.debug) {
        renderDebugPanel(msg.debug, msg.anonymized, msg.legend);
        debugSection.hidden = false;
      }
      if (!isAnyClassifyInFlight()) {
        scheduleProgressHide();
        const allEmpty = sources.every((x) => x.entities.length === 0);
        if (allEmpty) {
          setResultStatus('Nie znaleziono żadnych danych osobowych w tekście.');
        } else {
          setResultStatus('');
        }
        lastRun = {
          texts: new Map(sources.map((x) => [x.id, x.text])),
          enabledEntities: [...selector.getSelected()].sort(),
        };
        markCurrentNerPreloadSatisfied();
        setText(anonymizeBtns, 'Anonimizuj');
      } else {
        setText(modelStatusEls, `Analizowanie ${sources.length - inFlightSourceIds.size}/${sources.length}…`);
      }
      refreshAnonymizeButton();
      break;
    }
    case 'timing':
      console.log(`[bench-timing] ${msg.mark}${msg.alias ? ' alias=' + msg.alias : ''} t=${msg.t.toFixed(2)}`);
      updateProgress({ type: 'timing', mark: msg.mark, t: msg.t });
      break;
    case 'error': {
      if (msg.configRequestId != null && !isCurrentConfigMessage(msg)) break;
      const id = msg.id;
      const s = id ? sources.find((x) => x.id === id) : null;
      if (s) {
        s.status = 'error';
        s.error = msg.message;
        sourcesList.setSourceStatus(id, 'error', msg.message);
      }
      if (id) {
        updateProgress({ type: 'error', id, t: performance.now() });
        inFlightSourceIds.delete(id);
        inFlightClassifyTexts.delete(id);
        dispatchNextClassify();
      }
      if (!isAnyClassifyInFlight()) {
        setText(anonymizeBtns, 'Anonimizuj');
        scheduleProgressHide();
      }
      setResultStatus(`Błąd: ${msg.message}`);
      refreshAnonymizeButton();
      break;
    }
  }
};

copyAllBtns.forEach(btn => btn.addEventListener('click', async () => {
  const ready = sources.filter((s) => s.status === 'ready');
  if (ready.length === 0) return;
  const joined = ready
    .map((s) => {
      const text = applyTokens(s.text, s.entities, seen);
      return ready.length === 1 ? text : `── ${s.mcpLabel} ──\n${text}`;
    })
    .join('\n\n');
  try {
    await navigator.clipboard.writeText(joined);
    const originalHtml = btn.innerHTML;
    btn.textContent = 'Skopiowano!';
    setTimeout(() => { btn.innerHTML = originalHtml; }, 1500);
  } catch (err) {
    console.error('[main] copy-all failed:', err);
  }
}));

anonymizeBtns.forEach(btn => btn.addEventListener('click', async () => {
  for (const s of sources) {
    if (sourcesList.getMode(s.id) === 'text') {
      const live = sourcesList.getText(s.id);
      sourcesList.commitTextMode(s.id, live);
      s.text = sourcesList.getText(s.id);
    }
  }
  const selectedEntities = [...selector.getSelected()].sort();
  const selectionChanged = !lastRun || !setsEqual(selectedEntities, lastRun.enabledEntities);
  const toClassify = sources.filter((s) =>
    (s.text ?? '').trim().length > 0
    && (selectionChanged || s.lastReadyText === null || s.text !== s.lastReadyText || s.status !== 'ready'),
  );
  if (toClassify.length === 0) return;

  clearProgressHideTimer();
  progressBatchTotal = toClassify.length;
  progressSourceIndex = 0;
  updateProgress({ type: 'batch-start', total: toClassify.length, t: performance.now() });
  pendingClassifies.length = 0;
  inFlightClassifyTexts.clear();
  for (const s of toClassify) {
    s.status = 'pending';
    s.error = null;
    sourcesList.setSourceStatus(s.id, 'pending');
    inFlightSourceIds.add(s.id);
    pendingClassifies.push({ id: s.id, text: s.text });
  }
  resultStatus = '';
  setText(modelStatusEls, `Analizowanie 0/${toClassify.length}…`);
  setText(anonymizeBtns, 'Analizowanie...');
  refreshAnonymizeButton();
  if (!desktopClassifyActive) {
    desktopClassifyActive = true;
    await setDesktopActiveWork('pii-anonymize', true);
  }
  dispatchNextClassify();
}));

function renderDebugPanel(debug, anonymized, legend) {
  debugPanel.innerHTML = '';

  for (const entry of debug) {
    const card = document.createElement('details');
    card.className = 'debug-step';

    const summary = document.createElement('summary');
    const c = entry.changes;
    const parts = [`<strong>${entry.step}</strong> <span class="debug-phase">${entry.phase}</span>`];

    if (c.segments) parts.push(`segmenty +${c.segments.added.length}`);
    if (c.entities) {
      const { added, removed, count } = c.entities;
      const bits = [];
      if (added.length) bits.push(`+${added.length}`);
      if (removed.length) bits.push(`-${removed.length}`);
      bits.push(`(${count.before}\u2192${count.after})`);
      parts.push(`encje ${bits.join(' ')}`);
    }
    if (c.anonymized) parts.push('tekst zanonimizowany zmieniony');
    if (c.legend) parts.push(`legenda +${Object.keys(c.legend.added).length}`);
    if (c.text) parts.push('tekst zmieniony');
    if (Object.keys(c).length === 0) parts.push('<em>brak zmian</em>');

    summary.innerHTML = parts.join(' &middot; ');
    card.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'debug-step-body';

    if (c.entities) {
      if (c.entities.added.length > 0) {
        body.appendChild(makeEntityTable('Dodane', c.entities.added));
      }
      if (c.entities.removed.length > 0) {
        body.appendChild(makeEntityTable('Usunięte', c.entities.removed));
      }
    }

    if (c.segments) {
      const h = document.createElement('h5');
      h.textContent = `Segmenty (${c.segments.count.after})`;
      body.appendChild(h);
      const ul = document.createElement('ul');
      for (const seg of c.segments.added) {
        const li = document.createElement('li');
        li.textContent = `offset ${seg.offset}, ${seg.length} znaków: "${seg.preview}..."`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    if (c.legend) {
      const h = document.createElement('h5');
      h.textContent = `Legenda (+${Object.keys(c.legend.added).length})`;
      body.appendChild(h);
      const table = document.createElement('table');
      table.className = 'debug-table';
      for (const [token, value] of Object.entries(c.legend.added)) {
        const row = document.createElement('tr');
        row.innerHTML = `<td><code>${escHtml(token)}</code></td><td>${escHtml(value)}</td>`;
        table.appendChild(row);
      }
      body.appendChild(table);
    }

    card.appendChild(body);
    debugPanel.appendChild(card);
  }

  let copyBtn = document.getElementById('copy-debug-json');
  if (!copyBtn) {
    copyBtn = document.createElement('button');
    copyBtn.id = 'copy-debug-json';
    copyBtn.className = 'btn btn-secondary';
    copyBtn.textContent = 'Kopiuj JSON debug';
    copyBtn.style.marginTop = '0.5rem';
    debugPanel.appendChild(copyBtn);
  }
  copyBtn.onclick = () => {
    const output = { anonymized, legend, debug };
    navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    copyBtn.textContent = 'Skopiowano!';
    setTimeout(() => { copyBtn.textContent = 'Kopiuj JSON debug'; }, 2000);
  };
}

function makeEntityTable(label, entities) {
  const h = document.createElement('h5');
  h.textContent = `${label} (${entities.length})`;
  const table = document.createElement('table');
  table.className = 'debug-table';
  const thead = document.createElement('tr');
  thead.innerHTML = '<th>Typ</th><th>Tekst</th><th>Zakres</th><th>Pewność</th><th>Źródło</th>';
  table.appendChild(thead);
  for (const e of entities) {
    const row = document.createElement('tr');
    const src = Array.isArray(e.source) ? e.source.join(', ') : (e.source ?? '');
    row.innerHTML = `<td>${escHtml(e.entity_group)}</td><td>${escHtml(e.text)}</td><td>${e.start}-${e.end}</td><td>${e.score?.toFixed(3) ?? ''}</td><td>${escHtml(src)}</td>`;
    table.appendChild(row);
  }
  const frag = document.createDocumentFragment();
  frag.appendChild(h);
  frag.appendChild(table);
  return frag;
}

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

refreshAnonymizeButton();

const WEBMCP_CLAUDE_COMMAND = 'npx -y @jason.today/webmcp@latest --config claude';
const WEBMCP_CLAUDE_TOKEN_PROMPT = 'Wygeneruj token WebMCP dla pii.tools';

const mcp = new WebMCP({ channelName: 'pii' });
mountWebMcpControl(mcp);

function mountWebMcpControl(instance) {
  if (!webmcpControlRoot || !instance?.elementId) return;
  const widget = document.getElementById(instance.elementId);
  if (!widget) return;

  widget.classList.add('webmcp-run-widget');
  webmcpControlRoot.appendChild(widget);

  Object.assign(widget.style, {
    position: 'relative',
    top: 'auto',
    right: 'auto',
    bottom: 'auto',
    left: 'auto',
    padding: '0',
    zIndex: '30',
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    fontFamily: 'inherit',
    fontSize: '13px',
  });

  const trigger = widget.querySelector('.webmcp-trigger');
  const panel = widget.querySelector('.webmcp-content');
  if (trigger) {
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
    trigger.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      trigger.click();
    });
  }
  if (panel) {
    Object.assign(panel.style, {
      bottom: 'calc(100% + 10px)',
      right: '0',
      marginBottom: '0',
      width: '420px',
    });
    const connectionForm = panel.children[1];
    connectionForm?.classList.add('webmcp-connection-form');
    insertClaudeDesktopGuide(widget, connectionForm);
    installRegisteredItemsDisclosure(widget);
  }

  const updateTrigger = (status = null) => {
    if (!trigger) return;
    const connected = Boolean(instance.isConnected);
    widget.dataset.mcpConnected = connected ? 'true' : 'false';
    if (status === 'connecting' || status === 'pending-auth') {
      trigger.textContent = 'Łączenie AI…';
    } else {
      trigger.textContent = connected ? 'AI podłączone' : 'Podłącz AI';
    }
    trigger.setAttribute('aria-label', trigger.textContent);
  };

  const originalUpdateStatus = instance._updateStatus?.bind(instance);
  if (originalUpdateStatus) {
    instance._updateStatus = (status, message) => {
      originalUpdateStatus(status, message);
      widget.dataset.mcpStatus = status;
      updateTrigger(status);
    };
  }

  const originalUpdateConnectionUI = instance._updateConnectionUI?.bind(instance);
  if (originalUpdateConnectionUI) {
    instance._updateConnectionUI = (isConnected) => {
      originalUpdateConnectionUI(isConnected);
      widget.dataset.mcpConnected = isConnected ? 'true' : 'false';
      setClaudeDesktopGuideOpen(widget, !isConnected);
      setRegisteredItemsDisclosureState(widget, isConnected);
      updateTrigger();
    };
  }

  updateTrigger();
  setClaudeDesktopGuideOpen(widget, !instance.isConnected);
  setRegisteredItemsDisclosureState(widget, instance.isConnected);
}

function installRegisteredItemsDisclosure(widget) {
  const registeredItems = widget.querySelector('.webmcp-registered-items');
  if (!registeredItems || registeredItems.closest('.webmcp-items-disclosure')) return;

  const disclosure = document.createElement('details');
  disclosure.className = 'webmcp-items-disclosure';
  disclosure.hidden = true;

  const summary = document.createElement('summary');
  summary.innerHTML = '<span>Dostępne w WebMCP</span><strong>Narzędzia, prompty i zasoby</strong>';

  registeredItems.parentElement.insertBefore(disclosure, registeredItems);
  disclosure.appendChild(summary);
  disclosure.appendChild(registeredItems);
}

function setRegisteredItemsDisclosureState(widget, isConnected) {
  const disclosure = widget.querySelector('.webmcp-items-disclosure');
  if (!disclosure) return;
  disclosure.hidden = !isConnected;
  if (isConnected) disclosure.open = false;
}

function insertClaudeDesktopGuide(widget, beforeEl = null) {
  const panel = widget.querySelector('.webmcp-content');
  if (!panel || panel.querySelector('[data-testid="webmcp-claude-guide"]')) return;

  const guide = document.createElement('details');
  guide.className = 'webmcp-guide';
  guide.dataset.testid = 'webmcp-claude-guide';
  guide.open = true;
  guide.innerHTML = `
    <summary>
      <span class="webmcp-guide-eyebrow">Claude Desktop</span>
      <strong>Jak połączyć agenta</strong>
    </summary>
    <div class="webmcp-guide-body">
      <p>Claude powinien pracować wyłącznie na tokenach. Konfigurację robisz raz, potem wklejasz tutaj token wygenerowany w Claude.</p>
      <ol>
        <li>
          <span>Otwórz Terminal (macOS) albo PowerShell/Windows Terminal (Windows), uruchom komendę i zrestartuj Claude Desktop:</span>
          <div class="webmcp-command-row">
            <code>${WEBMCP_CLAUDE_COMMAND}</code>
            <button type="button" data-webmcp-copy-command>Skopiuj</button>
          </div>
        </li>
        <li>Jeśli komenda <code>npx</code> nie działa, zainstaluj Node.js LTS z <a href="https://nodejs.org/" target="_blank" rel="noreferrer">nodejs.org</a>, otwórz nowy Terminal/PowerShell i spróbuj ponownie.</li>
        <li>W Claude poproś: <code>${WEBMCP_CLAUDE_TOKEN_PROMPT}</code>.</li>
        <li>Wklej token w pole poniżej i kliknij <strong>Połącz</strong>.</li>
        <li>Zrestartuj Claude Desktop jeszcze raz — często dopiero po tym widzi narzędzia tej strony.</li>
        <li>Po połączeniu Claude czyta zanonimizowane źródła i zapisuje wyniki przez WebMCP — bez dostępu do oryginałów ani legendy.</li>
      </ol>
      <p class="webmcp-guide-note">Nie wklejaj oryginalnego dokumentu ani legendy do czatu — PII zostaje w przeglądarce.</p>
    </div>
  `;

  const anchor = beforeEl?.parentElement === panel ? beforeEl : panel.children[1] ?? null;
  panel.insertBefore(guide, anchor);

  guide.querySelector('[data-webmcp-copy-command]')?.addEventListener('click', (ev) => {
    copyWebMcpCommand(ev.currentTarget);
  });
}

function setClaudeDesktopGuideOpen(widget, open) {
  const guide = widget.querySelector('[data-testid="webmcp-claude-guide"]');
  if (guide) guide.open = Boolean(open);
}

async function copyWebMcpCommand(button) {
  const original = button.textContent;
  try {
    await copyTextToClipboard(WEBMCP_CLAUDE_COMMAND);
    button.textContent = 'Skopiowano';
  } catch (err) {
    console.warn('Nie udało się skopiować komendy WebMCP', err);
    button.textContent = 'Kopiuj ręcznie';
  } finally {
    setTimeout(() => {
      button.textContent = original;
    }, 1800);
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('document.execCommand("copy") returned false');
}

function jsonContent(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function textContent(value) {
  return { content: [{ type: 'text', text: value }] };
}

mcp.registerTool(
  'list_sources',
  'Wypisz gotowe zanonimizowane dokumenty źródłowe. Zwraca id, label i char_count dla każdego dokumentu. label to nazwa syntetyczna (np. „Źródło 1") albo nazwa jawnie udostępniona przez użytkownika — nigdy surowa nazwa pliku. Źródła bez wykrytych encji nie są udostępniane przez MCP, bo nie można potwierdzić tokenizacji.',
  { type: 'object', properties: {} },
  () => jsonContent(buildSourceListing(sources, seen)),
);

mcp.registerTool(
  'read_source',
  'Odczytaj tokenizowaną treść pojedynczego dokumentu źródłowego po id. Źródła bez wykrytych encji zwracają błąd zamiast tekstu, bo nie można potwierdzić anonimizacji.',
  {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  ({ id }) => buildReadSourceContent(sources, seen, id),
);

mcp.registerTool(
  'list_outcomes',
  'Wypisz dokumenty wynikowe w formie tokenów. Zwraca id, label i char_count. label to nazwa syntetyczna (np. „Wynik 1") albo nazwa nadana przez asystenta — nigdy prywatna nazwa użytkownika. Wyniki bez tokenów anonimizacji nie są udostępniane przez MCP.',
  { type: 'object', properties: {} },
  () => jsonContent(buildOutcomeListing(outcomes)),
);

mcp.registerTool(
  'read_outcome',
  'Odczytaj tokenizowaną treść dokumentu wynikowego po id (wcześniejsza odpowiedź LLM). Wyniki bez tokenów anonimizacji zwracają błąd zamiast tekstu.',
  {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  ({ id }) => buildReadOutcomeContent(outcomes, id),
);

mcp.registerTool(
  'write_outcome',
  'Utwórz lub zaktualizuj dokument wynikowy. Podaj id, aby zaktualizować istniejący dokument; pomiń id, aby utworzyć nowy. text MUSI być w formie tokenów (np. [PERSON_NAME_1]); przeglądarka deanonimizuje go tylko dla użytkownika i nigdy nie zwraca PII.',
  {
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['label', 'text'],
  },
  ({ id, label, text }) => {
    if (typeof label !== 'string' || label.trim().length === 0) {
      return jsonContent({ error: 'label musi być niepustym ciągiem znaków' });
    }
    if (typeof text !== 'string') {
      return jsonContent({ error: 'text musi być ciągiem znaków' });
    }
    if (id) {
      if (!updateOutcomeFields(id, label, text, { mcpLabel: label })) {
        return jsonContent({ error: `Dokument wynikowy ${id} nie istnieje` });
      }
      return jsonContent({ id, success: true });
    }
    const newId = createOutcome(label, text, label);
    return jsonContent({ id: newId, success: true });
  },
);
