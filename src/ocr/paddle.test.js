import { readFile } from 'node:fs/promises';

import { createPaddleEngine } from './paddle.js';
import { OcrFailedError, OcrCancelledError } from './errors.js';
import {
  TEXT_DETECTION_MODEL_NAME,
  TEXT_DETECTION_MODEL_URL,
  TEXT_RECOGNITION_MODEL_NAME,
  TEXT_RECOGNITION_MODEL_URL,
} from './models.js';

const noDownload = async () => ({});

function createTestEngine(options) {
  return createPaddleEngine({ downloadModelAssets: noDownload, ...options });
}

function fakeSdkFactory(predictImpl, opts = {}) {
  const calls = { create: 0, dispose: 0, lastOptions: null };
  const sdk = {
    PaddleOCR: {
      async create(options) {
        calls.create++;
        calls.lastOptions = options;
        if (opts.throwOnCreate) throw opts.throwOnCreate;
        return {
          predict: predictImpl,
          dispose: async () => { calls.dispose++; },
        };
      },
    },
  };
  return { sdk, calls };
}

function okResult(items, runtime = {}) {
  return [{
    image: { width: 100, height: 100 },
    items,
    metrics: { detMs: 1, recMs: 1, totalMs: 2, detectedBoxes: items.length, recognizedCount: items.length },
    runtime: { requestedBackend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false, ...runtime },
  }];
}

describe('createPaddleEngine', () => {
  it('lazy-initializes on first run and caches the instance', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    await engine.run({ kind: 'fake' });
    await engine.run({ kind: 'fake' });
    expect(calls.create).toBe(1);
  });

  it('init() creates sessions without running prediction and caches the instance', async () => {
    let predictCalls = 0;
    const { sdk, calls } = fakeSdkFactory(async () => { predictCalls++; return okResult([]); });
    const engine = createTestEngine({ loadSdk: async () => sdk });
    await engine.init();
    await engine.init();
    expect(calls.create).toBe(1);
    expect(predictCalls).toBe(0);
  });

  it('passes worker:true and the provided ortOptions to PaddleOCR.create', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({
      loadSdk: async () => sdk,
      ortOptions: { backend: 'wasm', wasmPaths: '/local/' },
    });
    await engine.run({ kind: 'fake' });
    expect(calls.lastOptions.worker).toBe(true);
    expect(calls.lastOptions.ortOptions).toEqual({ backend: 'wasm', wasmPaths: '/local/' });
  });

  it('loads ORT WASM assets from the same release as the JS runtime', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });

    await engine.run({ kind: 'fake' });

    expect(calls.lastOptions.ortOptions.wasmPaths)
      .toBe('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.1/dist/');
  });

  it('pins the ORT JS dependency to the exact WASM asset release', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    );

    expect(packageJson.dependencies['onnxruntime-web']).toBe('1.25.1');
  });

  it('overrides the rec model with the Latin PP-OCRv5 build by default', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    await engine.run({ kind: 'fake' });
    expect(calls.lastOptions.textDetectionModelName).toBe(TEXT_DETECTION_MODEL_NAME);
    expect(calls.lastOptions.textDetectionModelAsset).toEqual({ url: TEXT_DETECTION_MODEL_URL });
    expect(calls.lastOptions.textRecognitionModelName).toBe(TEXT_RECOGNITION_MODEL_NAME);
    expect(calls.lastOptions.textRecognitionModelAsset).toEqual({ url: TEXT_RECOGNITION_MODEL_URL });
  });

  it('lets sdkOptions override the default rec model wiring', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({
      loadSdk: async () => sdk,
      sdkOptions: {
        textRecognitionModelName: 'custom_rec',
        textRecognitionModelAsset: { url: '/custom.tar' },
      },
    });
    await engine.run({ kind: 'fake' });
    expect(calls.lastOptions.textRecognitionModelName).toBe('custom_rec');
    expect(calls.lastOptions.textRecognitionModelAsset).toEqual({ url: '/custom.tar' });
  });

  it('passes a custom createWorker when provided', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const fakeCreateWorker = () => ({ postMessage: () => {}, terminate: () => {} });
    const engine = createTestEngine({
      loadSdk: async () => sdk,
      createWorker: fakeCreateWorker,
    });
    await engine.run({ kind: 'fake' });
    expect(calls.lastOptions.worker).toEqual({ createWorker: fakeCreateWorker });
  });

  it('joins items[].text with newlines and averages score for confidence', async () => {
    const { sdk } = fakeSdkFactory(async () => okResult([
      { poly: [], text: 'Jan Kowalski', score: 0.9 },
      { poly: [], text: 'PESEL 80010112345', score: 0.8 },
    ]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    const out = await engine.run({ kind: 'fake' });
    expect(out.text).toBe('Jan Kowalski\nPESEL 80010112345');
    expect(out.confidence).toBeCloseTo(0.85, 5);
    expect(out.backend).toBe('wasm');
  });

  it('returns null confidence and empty text when no items detected', async () => {
    const { sdk } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    const out = await engine.run({ kind: 'fake' });
    expect(out.text).toBe('');
    expect(out.confidence).toBeNull();
  });

  it('reports the backend from runtime.requestedBackend', async () => {
    const { sdk } = fakeSdkFactory(async () => okResult([{ poly: [], text: 'x', score: 0.7 }], { requestedBackend: 'webgpu' }));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    const out = await engine.run({ kind: 'fake' });
    expect(out.backend).toBe('webgpu');
  });

  it('emits model:load:start and model:load:end exactly once per init', async () => {
    const events = [];
    const { sdk } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    engine.onModelLoad((e) => events.push(e.type));
    await engine.run({ kind: 'fake' });
    await engine.run({ kind: 'fake' });
    expect(events).toEqual(['model:load:start', 'model:load:end']);
  });

  it('downloads OCR model assets before session loading and forwards progress', async () => {
    const events = [];
    let revoked = false;
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createPaddleEngine({
      loadSdk: async () => sdk,
      downloadModelAssets: async ({ onProgress }) => {
        onProgress({ stage: 'model-download', status: 'plan', progress: 0, totalFiles: 2 });
        onProgress({ stage: 'model-download', status: 'progress', progress: 50, file: 'detekcja tekstu' });
        return {
          textDetectionModelAsset: { url: 'blob:det' },
          textRecognitionModelAsset: { url: 'blob:rec' },
          revoke: () => { revoked = true; },
        };
      },
    });
    engine.onProgress((event) => events.push(event));

    await engine.run({ kind: 'fake' });

    expect(events.map((event) => event.status)).toEqual(['plan', 'progress', 'start', 'done']);
    expect(calls.lastOptions.textDetectionModelAsset).toEqual({ url: 'blob:det' });
    expect(calls.lastOptions.textRecognitionModelAsset).toEqual({ url: 'blob:rec' });
    expect(revoked).toBe(true);
  });

  it('wraps predict failures in OcrFailedError', async () => {
    const { sdk } = fakeSdkFactory(async () => { throw new Error('boom'); });
    const engine = createTestEngine({ loadSdk: async () => sdk });
    await expect(engine.run({ kind: 'fake' })).rejects.toBeInstanceOf(OcrFailedError);
  });

  it('wraps create failures in OcrFailedError', async () => {
    const { sdk } = fakeSdkFactory(async () => okResult([]), { throwOnCreate: new Error('cdn down') });
    const engine = createTestEngine({ loadSdk: async () => sdk });
    await expect(engine.run({ kind: 'fake' })).rejects.toBeInstanceOf(OcrFailedError);
  });

  it('cancel() during init rejects with OcrCancelledError and avoids creating sessions if cancellation is noticed early', async () => {
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    const p = engine.run({ kind: 'fake' });
    engine.cancel();
    await expect(p).rejects.toBeInstanceOf(OcrCancelledError);
    expect(calls.create).toBe(0);
    expect(calls.dispose).toBe(0);
  });

  it('cancel() aborts an in-flight model download and rejects with OcrCancelledError', async () => {
    let downloadStarted;
    const started = new Promise((resolve) => { downloadStarted = resolve; });
    const download = ({ signal }) => new Promise((_, reject) => {
      downloadStarted();
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    const { sdk, calls } = fakeSdkFactory(async () => okResult([]));
    const engine = createPaddleEngine({ loadSdk: async () => sdk, downloadModelAssets: download });
    const p = engine.run({ kind: 'fake' });
    await started;
    engine.cancel();
    await expect(p).rejects.toBeInstanceOf(OcrCancelledError);
    expect(calls.create).toBe(0);
  });

  it('cancel() while idle does not poison the next run', async () => {
    const { sdk } = fakeSdkFactory(async () => okResult([]));
    const engine = createTestEngine({ loadSdk: async () => sdk });
    await engine.run({ kind: 'fake' });
    engine.cancel();
    const out = await engine.run({ kind: 'fake' });
    expect(out.text).toBe('');
    expect(out.confidence).toBeNull();
  });

  it('cancel() during an in-flight run() rejects that run with OcrCancelledError', async () => {
    let startedPredict;
    const started = new Promise((resolve) => { startedPredict = resolve; });
    let rejectPredict;
    const stuck = new Promise((_, reject) => { rejectPredict = reject; });
    const { sdk } = fakeSdkFactory(() => { startedPredict(); return stuck; });
    const engine = createTestEngine({ loadSdk: async () => sdk });
    const p = engine.run({ kind: 'fake' });
    await started;
    engine.cancel();
    rejectPredict(new Error('instance disposed'));
    await expect(p).rejects.toBeInstanceOf(OcrCancelledError);
  });
});
