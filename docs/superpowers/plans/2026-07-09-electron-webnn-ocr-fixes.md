# Electron WebNN and OCR Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make packaged Electron GPU opt-in use WebNN and make image/scanned-PDF OCR work without cross-origin detector-model failures.

**Architecture:** Configure Chromium WebNN features before Electron readiness while preserving the renderer’s existing opt-in backend selection. Serve both PaddleOCR model archives from the existing same-origin `public/ocr-models/` path, align ONNX Runtime JavaScript and WASM versions, and defend both paths with unit and real Electron import tests.

**Tech Stack:** Electron 43.1.0, Chromium 150, Vite 6, Vitest 3, Playwright 1.59, PaddleOCR JS 0.3.2, ONNX Runtime Web 1.25.1.

## Global Constraints

- Keep `BrowserWindow` sandboxing, context isolation, and `nodeIntegration: false` unchanged.
- Keep GPU inference opt-in through `#allow-gpu-checkbox`; do not default-check it.
- Enable `WebMachineLearningNeuralNetwork` on all Electron platforms and `WebNNOnnxRuntime` additionally on Windows.
- Apply Chromium feature switches before `app.whenReady()` and preserve user-supplied `enable-features` values.
- Keep browser WebNN guidance unchanged; Electron must never direct users to `chrome://flags`.
- Bundle `PP-OCRv5_mobile_det_onnx.tar` under `public/ocr-models/`.
- Pin direct `onnxruntime-web` to exact `1.25.1` and use matching jsDelivr `1.25.1` WASM assets.
- Do not disable CORS, web security, COOP/COEP, Electron sandboxing, or OCR error reporting.
- Do not modify Transformers.js’s nested ONNX Runtime dependency.

---

### Task 1: Establish red-capable regression coverage

**Files:**
- Create: `electron/webnn-features.test.js`
- Modify: `scripts/prepare-electron-app.test.js`
- Modify: `src/main.status.test.js`
- Modify: `src/ocr/models.test.js`
- Modify: `src/ocr/paddle.test.js`
- Modify: `e2e/electron-startup.spec.js`

**Interfaces:**
- Expects: `configureWebnnFeatures(commandLine, platform)` from `electron/webnn-features.js`.
- Exercises: Electron `navigator.ml`, WebNN hint copy, `OCR_MODEL_ASSETS`, PaddleOCR `ortOptions`, and a real image import.
- Produces: deterministic unit failures plus an Electron integration failure for each reported symptom.

- [ ] **Step 1: Add WebNN feature-merging tests**

Create `electron/webnn-features.test.js`:

```js
import { configureWebnnFeatures } from './webnn-features.js';

function fakeCommandLine(initial = '') {
  let value = initial;
  return {
    getSwitchValue: vi.fn(() => value),
    removeSwitch: vi.fn(() => { value = ''; }),
    appendSwitch: vi.fn((_name, next) => { value = next; }),
  };
}

it('enables WebNN while preserving existing Chromium features', () => {
  const commandLine = fakeCommandLine('ExistingFeature');
  expect(configureWebnnFeatures(commandLine, 'darwin')).toEqual([
    'ExistingFeature',
    'WebMachineLearningNeuralNetwork',
  ]);
  expect(commandLine.appendSwitch).toHaveBeenCalledWith(
    'enable-features',
    'ExistingFeature,WebMachineLearningNeuralNetwork',
  );
});

it('adds the Windows WebNN ORT backend without duplicates', () => {
  const commandLine = fakeCommandLine('WebMachineLearningNeuralNetwork');
  expect(configureWebnnFeatures(commandLine, 'win32')).toEqual([
    'WebMachineLearningNeuralNetwork',
    'WebNNOnnxRuntime',
  ]);
});
```

- [ ] **Step 2: Add a failing staging contract test**

In `scripts/prepare-electron-app.test.js`, create an `electron/webnn-features.js` fixture and assert that `prepareElectronApp()` copies it to `.electron-build/app/webnn-features.js`. The assertion must fail while `scripts/prepare-electron-app.js` still stages only `main.js`, `preload.cjs`, and `protocol.js`.

- [ ] **Step 3: Add Electron-aware hint tests**

In `src/main.status.test.js`, add browser and desktop WebNN copy blocks to the test DOM. In an Electron-mode test, set `window.piiDesktop`, enable the GPU checkbox while `navigator.ml` is absent, then assert:

```js
expect(document.querySelector('[data-webnn-copy="browser"]').hidden).toBe(true);
expect(document.querySelector('[data-webnn-copy="desktop"]').hidden).toBe(false);
expect(document.querySelector('#webnn-hint-panel').textContent).not.toContain('chrome://flags');
```

Retain a browser-mode case without `window.piiDesktop`:

```js
expect(document.querySelector('[data-webnn-copy="browser"]').hidden).toBe(false);
expect(document.querySelector('[data-webnn-copy="desktop"]').hidden).toBe(true);
```

- [ ] **Step 4: Add same-origin OCR model tests**

In `src/ocr/models.test.js`, assert both archive paths resolve under the application origin:

```js
const options = { base: './', documentBase: 'app://pii.tools/tool.html' };
expect(resolvePublicAssetUrl('ocr-models/PP-OCRv5_mobile_det_onnx.tar', options))
  .toBe('app://pii.tools/ocr-models/PP-OCRv5_mobile_det_onnx.tar');
expect(resolvePublicAssetUrl('ocr-models/latin_PP-OCRv5_mobile_rec.tar', options))
  .toBe('app://pii.tools/ocr-models/latin_PP-OCRv5_mobile_rec.tar');

for (const asset of OCR_MODEL_ASSETS) {
  expect(new URL(asset.url, 'app://pii.tools/tool.html').href)
    .toMatch(/^app:\/\/pii\.tools\/ocr-models\//);
}
```

The loop fails today because the detector uses the bcebos URL.

- [ ] **Step 5: Add ORT alignment tests through public behavior**

In `src/ocr/paddle.test.js`, use the existing fake SDK and inspect `calls.lastOptions.ortOptions.wasmPaths` after `engine.run()`. Assert it equals `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.1/dist/`. Read root `package.json` in the test and assert `dependencies['onnxruntime-web'] === '1.25.1'`.

- [ ] **Step 6: Extend Electron e2e with WebNN and OCR scenarios**

In the existing startup test, add:

```js
await expect.poll(() => page.evaluate(() => 'ml' in navigator)).toBe(true);
await page.locator('[data-testid="allow-gpu-checkbox"]').check();
await expect(page.locator('#webnn-hint')).toBeHidden();
```

On macOS, additionally verify:

```js
await expect.poll(() => page.evaluate(async () => {
  const context = await navigator.ml.createContext({ deviceType: 'gpu' });
  return Object.prototype.toString.call(context);
})).toBe('[object MLContext]');
```

Add a second test with a fresh user-data directory that uploads `e2e/fixtures/sample-photo.png`, waits for the source status to settle, and asserts:

```js
await expect(status).toHaveAttribute('data-status', 'idle', { timeout: 120_000 });
await expect(page.locator('.ann-editor-textarea')).toHaveValue(/Jan/i);
expect(assetConsoleErrors(diagnostics.consoleErrors)).toEqual([]);
expect(diagnostics.requestFailures).toEqual([]);
expect(diagnostics.badAssetResponses).toEqual([]);
```

- [ ] **Step 7: Verify RED**

Run:

```bash
npx vitest run electron/webnn-features.test.js scripts/prepare-electron-app.test.js src/main.status.test.js src/ocr/models.test.js src/ocr/paddle.test.js
npm run test:e2e:electron
```

Expected failures:

- unit import failure because `electron/webnn-features.js` does not exist;
- staging test fails because `webnn-features.js` is omitted from the staged runtime;
- Electron copy remains Chrome-specific;
- detector URL still points at bcebos;
- WASM path is 1.22.0 and the package dependency is a range;
- Electron e2e reports missing `navigator.ml` and OCR `Failed to fetch`/red status.

---

### Task 2: Enable WebNN and correct Electron guidance

**Files:**
- Create: `electron/webnn-features.js`
- Modify: `electron/main.js:1-25`
- Modify: `scripts/prepare-electron-app.js:25`
- Modify: `tool.html:15-31`
- Modify: `src/main.js:101-117,237-255`

**Interfaces:**
- Produces: `configureWebnnFeatures(commandLine, platform = process.platform): string[]`.
- Consumes: `window.piiDesktop` and renderer `navigator.ml` capability.

- [ ] **Step 1: Implement the feature merger**

Create `electron/webnn-features.js`:

```js
const WEBNN_FEATURE = 'WebMachineLearningNeuralNetwork';
const WINDOWS_WEBNN_FEATURE = 'WebNNOnnxRuntime';

export function configureWebnnFeatures(commandLine, platform = process.platform) {
  const features = new Set(
    commandLine.getSwitchValue('enable-features')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  features.add(WEBNN_FEATURE);
  if (platform === 'win32') features.add(WINDOWS_WEBNN_FEATURE);

  const configured = [...features];
  commandLine.removeSwitch('enable-features');
  commandLine.appendSwitch('enable-features', configured.join(','));
  return configured;
}
```

- [ ] **Step 2: Configure Electron before readiness**

At module top level in `electron/main.js`, after imports and before `protocol.registerSchemesAsPrivileged`, call:

```js
import { configureWebnnFeatures } from './webnn-features.js';

configureWebnnFeatures(app.commandLine);
```

Do not place this inside `startApp()`; that function runs after `app.whenReady()`.

- [ ] **Step 3: Stage the imported WebNN helper**

Add `webnn-features.js` to the explicit `electronFiles` array in `scripts/prepare-electron-app.js`:

```js
const electronFiles = ['main.js', 'preload.cjs', 'protocol.js', 'webnn-features.js'];
```

The Task 1 staging assertion must now pass.

- [ ] **Step 4: Add desktop-specific WebNN copy**

Wrap the current browser instructions in:

```html
<div data-webnn-copy="browser">
  <h3>Włącz WebNN dla szybszej anonimizacji</h3>
  <p>Anonimizacja może działać kilkukrotnie szybciej z WebNN — interfejsem do uruchamiania modeli na GPU. WebNN to funkcja eksperymentalna w Chrome i Edge.</p>
  <ol>
    <li>Otwórz Chrome (wersja 128+) lub Edge.</li>
    <li>Wklej w pasek adresu: <code>chrome://flags/#web-machine-learning-neural-network</code></li>
    <li>Ustaw flagę na <strong>Enabled</strong>.</li>
    <li>Zrestartuj przeglądarkę.</li>
  </ol>
  <p class="webnn-hint-note">Firefox i Safari nie wspierają WebNN. Wymagany komputer z GPU.</p>
</div>
<div data-webnn-copy="desktop" hidden>
  <h3>WebNN jest niedostępne na tym urządzeniu</h3>
  <p>Aplikacja użyje trybu WASM. Nie musisz zmieniać ustawień Chrome ani Edge.</p>
</div>
```

In `src/main.js`, cache both elements and set their `hidden` states from `Boolean(window.piiDesktop)` during initialization. Do not alter the capability predicate: supported Electron builds hide the entire hint because `navigator.ml` exists; unsupported desktop builds show only desktop copy.

- [ ] **Step 5: Verify WebNN GREEN**

Run:

```bash
npx vitest run electron/webnn-features.test.js electron/protocol.test.js scripts/prepare-electron-app.test.js src/main.status.test.js src/main.stale-classify.test.js
npm run test:e2e:electron -- --grep "boots through app protocol"
```

Expected: unit tests pass; Electron exposes `navigator.ml`; GPU context succeeds on macOS; Chrome-only hint stays hidden.

---

### Task 3: Make OCR assets same-origin and align ORT

**Files:**
- Create: `public/ocr-models/PP-OCRv5_mobile_det_onnx.tar`
- Modify: `src/ocr/models.js:8-69`
- Modify: `src/ocr/paddle.js:12-17`
- Modify: `package.json:44`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: same-origin `TEXT_DETECTION_MODEL_URL` and `TEXT_RECOGNITION_MODEL_URL`.
- Produces: PaddleOCR `ortOptions.wasmPaths` matching direct `onnxruntime-web` 1.25.1.

- [ ] **Step 1: Download and verify the detector archive**

Fetch the exact existing detector URL into `public/ocr-models/PP-OCRv5_mobile_det_onnx.tar` without transforming bytes:

`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx.tar`

Verify:

```bash
file public/ocr-models/PP-OCRv5_mobile_det_onnx.tar
shasum -a 256 public/ocr-models/PP-OCRv5_mobile_det_onnx.tar
```

The file must be approximately 4,830,208 bytes and recognized as a tar archive.

- [ ] **Step 2: Point the detector at the local archive**

Change `src/ocr/models.js` to:

```js
export const TEXT_DETECTION_MODEL_URL = resolvePublicAssetUrl(
  `ocr-models/${TEXT_DETECTION_MODEL_NAME}_onnx.tar`,
);
```

Keep the recognizer on its existing local `resolvePublicAssetUrl()` path.

- [ ] **Step 3: Align ORT JS and WASM**

Change the path in `src/ocr/paddle.js` to:

```js
const DEFAULT_WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.1/dist/';
```

Run:

```bash
npm install --save-exact onnxruntime-web@1.25.1
```

Confirm PaddleOCR resolves the root 1.25.1 installation while Transformers.js retains its nested ORT dependency.

- [ ] **Step 4: Verify OCR GREEN**

Run:

```bash
npx vitest run src/ocr/models.test.js src/ocr/paddle.test.js src/file-import/image.test.js src/file-import/pdf.test.js
npm run test:e2e:electron -- --grep "OCR"
```

Expected: both model URLs are same-origin, ORT versions align, image import yields text containing `Jan`, and source status is `idle`.

---

### Task 4: Verify and build final artifacts

**Files:**
- Verify generated, gitignored outputs under `release/desktop/`.
- Modify `docs/desktop.md` only if its runtime description is now inaccurate.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified macOS arm64 `.app`, `.dmg`, and `.zip`.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run electron/webnn-features.test.js electron/protocol.test.js scripts/prepare-electron-app.test.js src/ocr/models.test.js src/ocr/paddle.test.js src/file-import/image.test.js src/file-import/pdf.test.js src/main.status.test.js src/main.stale-classify.test.js
```

Expected: all selected files pass.

- [ ] **Step 2: Verify web behavior remains intact**

Run:

```bash
npm run build
npm run test:e2e:startup
```

Expected: build succeeds and all production-startup tests pass.

- [ ] **Step 3: Verify staged Electron behavior**

Run: `npm run test:e2e:electron`

Expected: WebNN and OCR Electron tests pass.

- [ ] **Step 4: Build final macOS artifacts**

Run: `npm run electron:dist:mac:arm64`

Expected outputs:

- `release/desktop/mac-arm64/pii.tools.app`
- `release/desktop/pii-tools-0.1.0-mac-arm64.dmg`
- `release/desktop/pii-tools-0.1.0-mac-arm64.zip`

- [ ] **Step 5: Smoke the final packaged app**

Launch the final `.app` with a clean `PII_ELECTRON_USER_DATA_DIR` and CDP port. Assert against the exact `app://pii.tools/tool.html` page target:

- `navigator.ml` exists;
- `navigator.ml.createContext({ deviceType: 'gpu' })` succeeds;
- GPU checkbox does not display Chrome-only instructions;
- uploading `e2e/fixtures/sample-photo.png` yields text containing `Jan`;
- source status is `idle`;
- detector and recognizer load from `app://pii.tools/ocr-models/`;
- no OCR model/worker request fails.

- [ ] **Step 6: Run final review**

Request a read-only reviewer focused on spec compliance, Electron security, cross-platform WebNN flags, OCR asset packaging, and regression coverage. Resolve every blocking finding before completion.
