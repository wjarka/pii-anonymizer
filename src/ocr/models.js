// OCR engine identity used by file-import meta.
export const ENGINE = 'paddleocr-v5';
export const CACHE_KEY = `ocr-${ENGINE}`;

// PaddleOCR's default detector is still the PP-OCRv5 mobile detector. We make
// the URL explicit so the app can pre-download/cache it with progress before
// the SDK's worker initializes the model sessions.
export const TEXT_DETECTION_MODEL_NAME = 'PP-OCRv5_mobile_det';
export const TEXT_DETECTION_MODEL_URL = resolvePublicAssetUrl(
  `ocr-models/${TEXT_DETECTION_MODEL_NAME}_onnx.tar`,
);

// PaddleOCR's default rec model is Chinese+English. We override it with the
// Latin PP-OCRv5 mobile recognizer (ONNX-converted from
// PaddlePaddle/latin_PP-OCRv5_mobile_rec) so Polish diacritics work. The tar
// is served from public/ocr-models/ — see vite.config.js's no-fallback list.
export const TEXT_RECOGNITION_MODEL_NAME = 'latin_PP-OCRv5_mobile_rec';

function withTrailingSlash(base) {
  return base.endsWith('/') ? base : `${base}/`;
}

function pageOrWorkerBaseHref(locationHref) {
  if (!locationHref) return null;
  const url = new URL(locationHref);
  const assetsIndex = url.pathname.lastIndexOf('/assets/');
  if (assetsIndex >= 0) {
    url.pathname = url.pathname.slice(0, assetsIndex + 1);
    url.search = '';
    url.hash = '';
  }
  return url.href;
}

export function resolvePublicAssetUrl(path, options = {}) {
  const base = options.base ?? import.meta.env?.BASE_URL ?? '/';
  if (base && base !== './') return `${withTrailingSlash(base)}${path}`;

  // With Vite `base: './'`, public assets compile to relative URLs. That works
  // from the page, but PaddleOCR fetches this model inside its own worker; a
  // relative `./ocr-models/...` would resolve under `/assets/` there and fetch
  // a 404/HTML page instead of the tar. Resolve once against the page URL and
  // pass an absolute URL into the SDK.
  const documentBase = options.documentBase
    ?? (typeof document !== 'undefined' ? document.baseURI : null);
  if (documentBase) return new URL(path, documentBase).href;

  const locationHref = options.locationHref
    ?? (typeof location !== 'undefined' ? location.href : null);
  const runtimeBase = pageOrWorkerBaseHref(locationHref);
  return runtimeBase ? new URL(path, runtimeBase).href : path;
}

export const TEXT_RECOGNITION_MODEL_URL = resolvePublicAssetUrl(
  `ocr-models/${TEXT_RECOGNITION_MODEL_NAME}.tar`
);

export const OCR_MODEL_ASSETS = [
  {
    key: 'det',
    name: TEXT_DETECTION_MODEL_NAME,
    label: 'detekcja tekstu',
    url: TEXT_DETECTION_MODEL_URL,
  },
  {
    key: 'rec',
    name: TEXT_RECOGNITION_MODEL_NAME,
    label: 'rozpoznawanie tekstu',
    url: TEXT_RECOGNITION_MODEL_URL,
  },
];
