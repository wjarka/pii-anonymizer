const BMC_SCRIPT_URL = 'https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js';

const BUTTON = {
  text: 'Buy me a coffee',
  slug: 'piitools',
  color: '#228466',
  emoji: '☕',
  font: 'Inter',
  fontColor: '#ffffff',
  outlineColor: '#ffffff',
  coffeeColor: '#FFDD00',
};

const slots = [...document.querySelectorAll('[data-bmc-button]')];

if (slots.length) {
  if (Boolean(window.piiDesktop)) {
    decorateFallbackLinks();
  } else {
    loadBmcWidget()
      .then(renderButtons)
      .catch(decorateFallbackLinks);
  }
}

function loadBmcWidget() {
  if (typeof window.bmcBtnWidget === 'function') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-bmc-widget-loader]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = BMC_SCRIPT_URL;
    script.async = true;
    script.dataset.bmcWidgetLoader = 'true';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.appendChild(script);
  });
}

function renderButtons() {
  if (typeof window.bmcBtnWidget !== 'function') return;

  slots.forEach((slot) => {
    slot.innerHTML = window.bmcBtnWidget(
      BUTTON.text,
      BUTTON.slug,
      BUTTON.color,
      BUTTON.emoji,
      BUTTON.font,
      BUTTON.fontColor,
      BUTTON.outlineColor,
      BUTTON.coffeeColor,
    );
    slot.dataset.bmcLoaded = 'true';
    decorateLink(slot.querySelector('a.bmc-btn'));
  });
}

function decorateFallbackLinks() {
  slots.forEach((slot) => decorateLink(slot.querySelector('a')));
}

function decorateLink(link) {
  if (!link) return;
  link.rel = 'noopener';
  link.setAttribute('aria-label', 'Buy me a coffee — otwiera się w nowej karcie');
}
