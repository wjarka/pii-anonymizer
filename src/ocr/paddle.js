import { OcrFailedError, OcrCancelledError } from './errors.js';
import {
  ENGINE,
  CACHE_KEY,
  OCR_MODEL_ASSETS,
  TEXT_DETECTION_MODEL_NAME,
  TEXT_DETECTION_MODEL_URL,
  TEXT_RECOGNITION_MODEL_NAME,
  TEXT_RECOGNITION_MODEL_URL,
} from './models.js';

// The official @paddleocr/paddleocr-js SDK owns its own worker (via
// `worker: true`) and ONNX Runtime Web setup, so we don't manage either.
// Pinning ORT WASM to jsDelivr keeps versions in sync between main thread and
// worker — the SDK's architecture doc explicitly recommends this.
const DEFAULT_WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.1/dist/';

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sizeFromHeaders(headers) {
  return positiveNumber(headers?.get?.('Content-Length') ?? headers?.get?.('content-length'));
}

function modelFileLabel(asset) {
  if (asset.label) return asset.label;
  try {
    return new URL(asset.url).pathname.split('/').filter(Boolean).pop() || asset.name;
  } catch {
    return asset.name || asset.url;
  }
}

function makeObjectUrl(blob, originalUrl) {
  const urlApi = globalThis.URL;
  if (!urlApi?.createObjectURL || !urlApi?.revokeObjectURL) {
    return { url: originalUrl, revoke: () => {} };
  }
  const url = urlApi.createObjectURL(blob);
  return { url, revoke: () => urlApi.revokeObjectURL(url) };
}

async function openCache(cacheStorage = globalThis.caches) {
  try {
    return cacheStorage ? await cacheStorage.open(CACHE_KEY) : null;
  } catch {
    return null;
  }
}

async function responseToBlobWithProgress(response, asset, onChunk, signal) {
  const total = sizeFromHeaders(response.headers);
  const type = response.headers?.get?.('content-type') || 'application/x-tar';
  const chunks = [];
  let loaded = 0;

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* swallow */ }
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loaded += value.byteLength ?? value.length ?? 0;
      onChunk({ loaded, total });
    }
  } else {
    const buffer = await response.arrayBuffer();
    chunks.push(buffer);
    loaded = buffer.byteLength;
    onChunk({ loaded, total: total || loaded });
  }

  if (loaded === 0 && total === 0) onChunk({ loaded: 0, total: 0 });
  return new Blob(chunks, { type });
}

function cacheHeadersFor(blob) {
  return {
    'content-type': blob.type || 'application/x-tar',
    'content-length': String(blob.size),
  };
}

export async function downloadOcrModelAssets({
  assets = OCR_MODEL_ASSETS,
  cacheStorage = globalThis.caches,
  fetchFn = globalThis.fetch?.bind(globalThis),
  onProgress = () => {},
  signal,
} = {}) {
  if (!fetchFn) {
    return {};
  }

  const cache = await openCache(cacheStorage);
  const entries = [];
  let cachedFiles = 0;

  for (const asset of assets) {
    const cached = cache ? await cache.match(asset.url).catch(() => null) : null;
    if (cached) cachedFiles += 1;
    entries.push({ asset, cached });
  }

  const totalFiles = entries.length;
  let completedFiles = 0;
  const objectUrls = [];
  const resolved = {};

  function emit(status, asset, extra = {}) {
    const fileFraction = extra.fileTotalBytes > 0
      ? Math.max(0, Math.min(1, (extra.fileLoadedBytes ?? 0) / extra.fileTotalBytes))
      : 0;
    const progress = totalFiles > 0
      ? ((completedFiles + fileFraction) / totalFiles) * 100
      : 100;
    onProgress({
      stage: 'model-download',
      status,
      engine: ENGINE,
      file: asset ? modelFileLabel(asset) : '',
      model: asset?.name ?? '',
      progress: Math.max(0, Math.min(100, extra.progress ?? progress)),
      completedFiles,
      cachedFiles,
      remainingFiles: Math.max(0, totalFiles - cachedFiles),
      totalFiles,
      ...extra,
    });
  }

  onProgress({
    stage: 'model-download',
    status: 'plan',
    engine: ENGINE,
    progress: totalFiles === 0 ? 100 : 0,
    completedFiles: 0,
    cachedFiles,
    remainingFiles: Math.max(0, totalFiles - cachedFiles),
    totalFiles,
  });

  try {
    for (const entry of entries) {
      const { asset } = entry;
      let blob;

      if (entry.cached) {
        blob = await entry.cached.blob();
        completedFiles += 1;
        emit('cached', asset, {
          progress: totalFiles > 0 ? (completedFiles / totalFiles) * 100 : 100,
          fileLoadedBytes: blob.size,
          fileTotalBytes: blob.size,
        });
      } else {
        emit('download', asset, { fileLoadedBytes: 0, fileTotalBytes: 0 });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const response = await fetchFn(asset.url, { signal });
        if (!response?.ok) {
          throw new Error(`Could not download OCR model ${asset.url}: ${response?.status ?? 'unknown'} ${response?.statusText ?? ''}`.trim());
        }
        blob = await responseToBlobWithProgress(response, asset, ({ loaded, total }) => {
          emit('progress', asset, {
            fileLoadedBytes: loaded,
            fileTotalBytes: total,
          });
        }, signal);
        if (cache) {
          try {
            await cache.put(asset.url, new Response(blob, {
              status: 200,
              statusText: 'OK',
              headers: cacheHeadersFor(blob),
            }));
          } catch (err) {
            console.warn('[ocr] unable to cache OCR model asset:', err);
          }
        }
        completedFiles += 1;
        emit('done', asset, {
          progress: totalFiles > 0 ? (completedFiles / totalFiles) * 100 : 100,
          fileLoadedBytes: blob.size,
          fileTotalBytes: blob.size,
        });
      }

      const objectUrl = makeObjectUrl(blob, asset.url);
      objectUrls.push(objectUrl);
      resolved[asset.key] = { url: objectUrl.url };
    }
  } catch (err) {
    for (const objectUrl of objectUrls) objectUrl.revoke();
    throw err;
  }

  onProgress({
    stage: 'model-download',
    status: 'complete',
    engine: ENGINE,
    progress: 100,
    completedFiles: totalFiles,
    cachedFiles,
    remainingFiles: Math.max(0, totalFiles - cachedFiles),
    totalFiles,
  });

  return {
    textDetectionModelAsset: resolved.det,
    textRecognitionModelAsset: resolved.rec,
    revoke() {
      for (const objectUrl of objectUrls) objectUrl.revoke();
    },
  };
}

async function defaultLoadSdk() {
  return await import('@paddleocr/paddleocr-js');
}

export function createPaddleEngine(deps = {}) {
  const loadSdk = deps.loadSdk ?? defaultLoadSdk;
  const downloadModelAssets = deps.downloadModelAssets ?? downloadOcrModelAssets;
  const ortOptions = deps.ortOptions ?? {
    backend: 'wasm',
    wasmPaths: DEFAULT_WASM_PATHS,
  };
  const createWorker = deps.createWorker;
  const sdkOptions = deps.sdkOptions;

  let instance = null;
  let initPromise = null;
  let cancelRequested = false;
  let runInFlight = false;
  let downloadAbort = null;
  let onModelLoadListener = null;
  let onProgressListener = null;
  let modelLoadAnnounced = false;
  let backend = ortOptions.backend ?? 'wasm';

  function emitProgress(event) {
    onProgressListener?.({ engine: ENGINE, ...event });
  }

  function emitLoadStart() {
    if (modelLoadAnnounced) return;
    modelLoadAnnounced = true;
    onModelLoadListener?.({ type: 'model:load:start', engine: ENGINE });
  }

  function emitLoadEnd() {
    if (!modelLoadAnnounced) return;
    onModelLoadListener?.({ type: 'model:load:end', engine: ENGINE });
  }

  async function ensureInit() {
    if (instance) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      let downloadedAssets = null;
      const sdk = await loadSdk();
      const PaddleOCR = sdk.PaddleOCR ?? sdk.default?.PaddleOCR;
      if (!PaddleOCR || typeof PaddleOCR.create !== 'function') {
        throw new OcrFailedError(new Error('PaddleOCR.create not exported by @paddleocr/paddleocr-js'));
      }
      try {
        downloadAbort = new AbortController();
        downloadedAssets = await downloadModelAssets({ onProgress: emitProgress, signal: downloadAbort.signal });
        if (cancelRequested) {
          initPromise = null;
          return;
        }
        emitLoadStart();
        const made = await PaddleOCR.create({
          worker: createWorker ? { createWorker } : true,
          ortOptions,
          textDetectionModelName: TEXT_DETECTION_MODEL_NAME,
          textDetectionModelAsset: downloadedAssets?.textDetectionModelAsset ?? { url: TEXT_DETECTION_MODEL_URL },
          textRecognitionModelName: TEXT_RECOGNITION_MODEL_NAME,
          textRecognitionModelAsset: downloadedAssets?.textRecognitionModelAsset ?? { url: TEXT_RECOGNITION_MODEL_URL },
          ...sdkOptions,
          initialize: true,
        });
        // Cancel arrived during init: discard the freshly-made instance.
        if (cancelRequested) {
          try { await made.dispose?.(); } catch { /* swallow */ }
          initPromise = null;
          modelLoadAnnounced = false;
          return;
        }
        instance = made;
        emitLoadEnd();
        initPromise = null;
      } catch (err) {
        initPromise = null;
        modelLoadAnnounced = false;
        throw new OcrFailedError(err);
      } finally {
        downloadedAssets?.revoke?.();
        downloadAbort = null;
      }
    })();
    return initPromise;
  }

  async function init() {
    if (cancelRequested) {
      cancelRequested = false;
      throw new OcrCancelledError();
    }
    try {
      await ensureInit();
      if (cancelRequested || !instance) {
        cancelRequested = false;
        throw new OcrCancelledError();
      }
    } catch (err) {
      if (cancelRequested) {
        cancelRequested = false;
        throw new OcrCancelledError();
      }
      if (err instanceof OcrCancelledError) throw err;
      if (err instanceof OcrFailedError) throw err;
      throw new OcrFailedError(err);
    }
  }

  async function run(input, options = {}) {
    runInFlight = true;
    try {
      await init();
      options.onRunStart?.();
      emitProgress({ stage: 'ocr-run', status: 'start' });
      const results = await instance.predict(input);
      emitProgress({ stage: 'ocr-run', status: 'done' });
      const result = Array.isArray(results) ? results[0] : results;
      const items = result?.items ?? [];
      const text = items.map((it) => it?.text ?? '').filter(Boolean).join('\n');
      const confidence = items.length === 0
        ? null
        : items.reduce((s, it) => s + (it?.score ?? 0), 0) / items.length;
      backend = result?.runtime?.requestedBackend ?? backend;
      return { text, confidence, backend };
    } catch (err) {
      if (cancelRequested) {
        cancelRequested = false;
        throw new OcrCancelledError();
      }
      if (err instanceof OcrCancelledError) throw err;
      if (err instanceof OcrFailedError) throw err;
      throw new OcrFailedError(err);
    } finally {
      runInFlight = false;
    }
  }

  function cancel() {
    if (initPromise || runInFlight) cancelRequested = true;
    downloadAbort?.abort();
    if (instance) {
      const i = instance;
      instance = null;
      initPromise = null;
      modelLoadAnnounced = false;
      try { i.dispose?.(); } catch { /* swallow */ }
    }
  }

  function onModelLoad(listener) {
    onModelLoadListener = listener;
  }

  function onProgress(listener) {
    onProgressListener = listener;
  }

  return {
    init,
    run,
    cancel,
    onModelLoad,
    onProgress,
    getBackend: () => backend,
  };
}
