// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BMC_SCRIPT_URL = 'https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js';
const ACCESSIBLE_LABEL = 'Buy me a coffee — otwiera się w nowej karcie';

function installFallbackSlot() {
  document.body.innerHTML = `
    <div data-bmc-button>
      <a class="bmc-fallback" href="https://buymeacoffee.com/piitools" target="_blank">
        Buy me a coffee
      </a>
    </div>
  `;
  return document.querySelector('.bmc-fallback');
}

async function loadBmcButton() {
  vi.resetModules();
  await import('./bmc-button.js');
}

describe('Buy Me a Coffee widget loading', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete window.piiDesktop;
    delete window.bmcBtnWidget;
  });

  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete window.piiDesktop;
    delete window.bmcBtnWidget;
    vi.resetModules();
  });

  it('keeps a secured fallback link without loading remote widget code in Electron', async () => {
    const fallback = installFallbackSlot();
    window.piiDesktop = { platform: 'darwin' };

    await loadBmcButton();

    expect(document.querySelector(`script[src="${BMC_SCRIPT_URL}"]`)).toBeNull();
    expect(fallback.isConnected).toBe(true);
    expect(fallback.rel).toBe('noopener');
    expect(fallback.getAttribute('aria-label')).toBe(ACCESSIBLE_LABEL);
  });

  it('loads the existing remote widget script in a browser', async () => {
    installFallbackSlot();

    await loadBmcButton();

    const script = document.querySelector('script[data-bmc-widget-loader]');
    expect(script).not.toBeNull();
    expect(script.src).toBe(BMC_SCRIPT_URL);
  });
});
