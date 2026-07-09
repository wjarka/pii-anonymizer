import { resolveBasePath } from './vite.config.js';

describe('resolveBasePath', () => {
  it('defaults Cloudflare/custom-domain builds to root-absolute assets', () => {
    expect(resolveBasePath({})).toBe('/');
  });

  it('preserves an explicit GitHub Pages base path', () => {
    expect(resolveBasePath({ VITE_BASE_PATH: '/pii-anonymizer/' })).toBe('/pii-anonymizer/');
  });

  it('preserves a relative Electron base path', () => {
    expect(resolveBasePath({ VITE_BASE_PATH: './' })).toBe('./');
  });

  it('treats an empty base path as the root default', () => {
    expect(resolveBasePath({ VITE_BASE_PATH: '' })).toBe('/');
  });
});
