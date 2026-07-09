import { OCR_MODEL_ASSETS, resolvePublicAssetUrl } from './models.js';

describe('resolvePublicAssetUrl', () => {
  it('uses absolute Vite base paths as-is', () => {
    expect(resolvePublicAssetUrl('ocr-models/model.tar', { base: '/pii-anonymizer/' }))
      .toBe('/pii-anonymizer/ocr-models/model.tar');
  });

  it('resolves relative builds against the Cloudflare Pages document URL', () => {
    expect(resolvePublicAssetUrl('ocr-models/model.tar', {
      base: './',
      documentBase: 'https://pii-anonymizer.pages.dev/tool.html',
    })).toBe('https://pii-anonymizer.pages.dev/ocr-models/model.tar');
  });

  it('resolves relative builds against the GitHub Pages document URL', () => {
    expect(resolvePublicAssetUrl('ocr-models/model.tar', {
      base: './',
      documentBase: 'https://wjarka.github.io/pii-anonymizer/tool.html',
    })).toBe('https://wjarka.github.io/pii-anonymizer/ocr-models/model.tar');
  });

  it('resolves both OCR archives under the Electron application origin', () => {
    const options = { base: './', documentBase: 'app://pii.tools/tool.html' };
    expect(resolvePublicAssetUrl('ocr-models/PP-OCRv5_mobile_det_onnx.tar', options))
      .toBe('app://pii.tools/ocr-models/PP-OCRv5_mobile_det_onnx.tar');
    expect(resolvePublicAssetUrl('ocr-models/latin_PP-OCRv5_mobile_rec.tar', options))
      .toBe('app://pii.tools/ocr-models/latin_PP-OCRv5_mobile_rec.tar');
  });

  it('can infer the app root from a bundled worker URL', () => {
    expect(resolvePublicAssetUrl('ocr-models/model.tar', {
      base: './',
      locationHref: 'https://wjarka.github.io/pii-anonymizer/assets/worker-entry.js',
    })).toBe('https://wjarka.github.io/pii-anonymizer/ocr-models/model.tar');
  });
});

describe('OCR_MODEL_ASSETS', () => {
  it('keeps every downloadable model under the Electron application origin', () => {
    for (const asset of OCR_MODEL_ASSETS) {
      expect(new URL(asset.url, 'app://pii.tools/tool.html').href)
        .toMatch(/^app:\/\/pii\.tools\/ocr-models\//);
    }
  });
});
