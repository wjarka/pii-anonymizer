# Electron WebNN and OCR Fixes — Design

## Goal

Make the packaged Electron app use WebNN when the user enables GPU, avoid browser-only WebNN instructions in Electron, and restore OCR for images and scanned PDFs.

The normal web deployment must keep its current behavior.

## Confirmed failures

### WebNN

Electron 43.1.0 embeds Chromium 150 but starts without `WebMachineLearningNeuralNetwork`. Consequently, `navigator.ml` is absent in both the renderer and the NER worker. Selecting “Pozwól na użycie GPU” requests the automatic backend, but the worker selects WASM and the renderer shows Chrome/Edge `chrome://flags` instructions.

Launching the same packaged binary with `--enable-features=WebMachineLearningNeuralNetwork` exposes `navigator.ml` in both contexts. On the tested macOS arm64 host, `navigator.ml.createContext({ deviceType: 'gpu' })` succeeds.

### OCR

The PaddleOCR detector model is fetched from `paddle-model-ecology.bj.bcebos.com`. That host does not grant CORS access to `app://pii.tools`, so Electron throws `TypeError: Failed to fetch`. The error becomes `OcrFailedError`, producing an empty document and red source-status dot.

The recognition model already loads from `app://pii.tools/ocr-models/...`. The ORT WASM CDN is reachable, but the installed ORT JavaScript version and hard-coded WASM version are currently misaligned.

## Design

### Electron WebNN bootstrap

At Electron main-module initialization, before `app.whenReady()`, append Chromium features once:

- All desktop platforms: `WebMachineLearningNeuralNetwork`.
- Windows: also `WebNNOnnxRuntime`.

Merge these with any existing `enable-features` switch rather than replacing user-provided features.

The existing GPU checkbox remains opt-in. Enabling the Chromium API does not by itself move inference to GPU; renderer configuration still sends `backend: 'auto'` only after the user checks the box. Existing model-level WebNN-to-WASM fallback remains intact.

### WebNN guidance

Browser builds retain the Chrome/Edge guidance when `navigator.ml` is absent.

Electron detects `window.piiDesktop` and never directs users to `chrome://flags`. Normally the Electron feature flag makes the hint unnecessary because `navigator.ml` exists. If WebNN is unavailable on a future desktop platform, the panel shows desktop-specific fallback text explaining that the app will use WASM on that device.

### Same-origin OCR assets

Store `PP-OCRv5_mobile_det_onnx.tar` under `public/ocr-models/`, alongside the existing Latin recognition tar. Resolve both detector and recognition URLs through `resolvePublicAssetUrl()`.

This adds approximately 4.8 MB to the source/build artifact and removes the detector model’s runtime CORS dependency. First OCR use may still initialize ORT and models; subsequent use continues to benefit from application and browser caches.

### ONNX Runtime alignment

Pin the direct `onnxruntime-web` dependency to `1.25.1` and change `DEFAULT_WASM_PATHS` to the matching jsDelivr `1.25.1` directory. Do not let semver hoisting pair one ORT JavaScript version with another version’s WASM binary.

This change is restricted to PaddleOCR. Transformers.js continues using its own nested ORT dependency.

### Error behavior

Do not relax web security, disable CORS, inject response headers globally, or hide OCR failures.

Failed model initialization continues to surface as an OCR error and red source-status dot. Tests must preserve the actual failure message so asset regressions remain diagnosable.

## Verification design

### Focused tests

- Electron bootstrap test: WebNN feature list is appended before readiness, preserves existing features, and includes `WebNNOnnxRuntime` only on Windows.
- Renderer UI test: Electron does not show Chrome-only instructions; browser behavior remains unchanged.
- OCR model URL test: both detector and recognizer resolve under the application origin for relative Electron builds.
- OCR runtime test: ORT JavaScript and WASM versions are aligned.

### Electron integration

Extend the Electron Playwright suite to:

1. assert `navigator.ml` exists in the renderer;
2. assert the worker reports WebNN available after GPU is enabled;
3. assert the Chrome/Edge hint stays hidden in Electron;
4. upload `e2e/fixtures/sample-photo.png`;
5. wait for import completion;
6. assert non-empty OCR text and non-error source status;
7. fail on OCR model/worker request errors.

### Packaged smoke

Rebuild the macOS arm64 app, DMG, and ZIP. Launch the final `.app`, repeat the direct WebNN capability probe and real OCR image import, and verify that the packaged—not merely staged—artifact succeeds.

## Non-goals

- Default-checking the GPU checkbox.
- Removing WASM fallback.
- Enabling WebNN in browsers that do not expose it.
- Disabling Electron sandboxing or web security.
- Reworking OCR recognition quality or NER model selection.
