/**
 * Feuille « Réglages » (roue dentée de la barre du haut) : ce qui se règle une fois pour toutes,
 * hors des écrans de travail. Thème, diapason, proxy des partitions, clé YouTube, installation.
 */
import { proxyUrl, normalizeProxy, saveProxyUrl, testProxy } from '../scores/rhythm/search';
import { saveYoutubeKey, youtubeKey } from '../scores/sync/youtube';
import { A4_DEFAULT, clampA4 } from '../tuner/notes';
import { h } from '../ui/dom';
import { bindHoldRepeat } from '../ui/hold';
import { Sheet, fieldRow, group } from '../ui/sheet';
import { isNumber, loadPref, onPrefChange, savePref } from './storage';
import { type Theme, applyTheme, currentTheme } from './theme';

const NB = ' ';
const fr = (text: string): string => text.replace(/ ([:;!?»])/g, `${NB}$1`).replace(/« /g, `«${NB}`);

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let sheet: Sheet | null = null;
const sections = new Map<string, HTMLElement>();

/** Ouvre les réglages ; `section` : la fait défiler à l'écran (« proxy »…). */
export function openSettings(section?: string): void {
  sheet ??= build();
  sheet.open();
  if (section) sections.get(section)?.scrollIntoView({ block: 'center' });
  if (section) sections.get(section)?.querySelector('input')?.focus();
}

/** Bouton de la barre du haut. */
export function setupSettingsButton(button: HTMLButtonElement): void {
  button.addEventListener('click', () => openSettings());
}

function build(): Sheet {
  const s = new Sheet('Réglages', { testId: 'settings' });

  // --- Thème ---
  const themes: Array<[Theme, string]> = [
    ['dark', 'Sombre'],
    ['light', 'Clair'],
  ];
  const themeButtons = themes.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'radio', 'data-theme-id': id }, label);
    b.addEventListener('click', () => {
      applyTheme(id);
      sync();
    });
    return b;
  });
  const sync = (): void => {
    for (const b of themeButtons) b.setAttribute('aria-checked', String(b.dataset.themeId === currentTheme()));
  };
  sync();
  const themeSeg = h('div', { class: 'seg seg--compact', role: 'radiogroup', 'aria-label': 'Thème' }, ...themeButtons);

  // --- Diapason ---
  let a4 = clampA4(loadPref('a4', A4_DEFAULT, isNumber));
  const a4Value = h('output', { class: 'stepper__value', 'aria-live': 'polite', 'data-testid': 'a4' });
  const minus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Baisser le diapason de 1 Hz' }, '−');
  const plus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Monter le diapason de 1 Hz' }, '+');
  const renderA4 = (): void => {
    a4Value.textContent = `${a4}${NB}Hz`;
    minus.disabled = a4 <= 430;
    plus.disabled = a4 >= 450;
  };
  const setA4 = (value: number): void => {
    const next = clampA4(value);
    if (next === a4) return;
    a4 = next;
    savePref('a4', a4);
    renderA4();
  };
  bindHoldRepeat(minus, () => setA4(a4 - 1));
  bindHoldRepeat(plus, () => setA4(a4 + 1));
  onPrefChange('a4', (v) => {
    if (isNumber(v)) {
      a4 = clampA4(v);
      renderA4();
    }
  });
  renderA4();

  // --- Proxy des partitions ---
  const proxyInput = h('input', {
    type: 'url',
    class: 'field',
    placeholder: 'https://…workers.dev',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: 'url',
    'aria-label': 'Adresse du proxy',
    'data-testid': 'rhythm-proxy',
  });
  const proxyState = h('p', { class: 'row__hint', 'data-testid': 'rhythm-proxy-state' });
  const renderProxy = (): void => {
    const url = proxyUrl();
    proxyInput.value = url ?? '';
    proxyState.textContent = fr(url ? 'Proxy enregistré.' : 'Sans proxy, seuls BitMidi et vos fichiers servent de sources.');
  };
  const proxyForm = h('form', { class: 'field-line', novalidate: true }, proxyInput, h('button', { type: 'submit', class: 'btn btn--small' }, 'Enregistrer'));
  proxyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const text = proxyInput.value;
      if (!text.trim()) {
        saveProxyUrl(null);
        renderProxy();
        return;
      }
      const url = normalizeProxy(text);
      if (!url) {
        proxyState.textContent = fr('Adresse invalide : elle commence par https://');
        return;
      }
      proxyState.textContent = 'Test du proxy…';
      if (!(await testProxy(url))) {
        proxyState.textContent = fr('Ce proxy ne répond pas : vérifiez l’adresse.');
        return;
      }
      saveProxyUrl(url);
      renderProxy();
      proxyState.textContent = 'Proxy prêt.';
    })();
  });
  renderProxy();
  const proxy = h(
    'div',
    { class: 'row row--stacked' },
    h(
      'span',
      { class: 'row__text' },
      h('span', { class: 'row__label' }, 'Proxy des partitions'),
      h(
        'span',
        { class: 'row__hint' },
        fr('Télécharge les liens trouvés par Claude. Gratuit, sur votre compte Cloudflare : '),
        h('a', { href: 'https://github.com/Django184/guitar/tree/main/proxy#readme', target: '_blank', rel: 'noopener noreferrer' }, 'l’installer'),
        '.',
      ),
    ),
    proxyForm,
    proxyState,
  );
  sections.set('proxy', proxy);

  // --- Clé YouTube ---
  const keyInput = h('input', { type: 'text', class: 'field', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Clé API YouTube', value: youtubeKey() });
  const keyState = h('p', { class: 'row__hint' });
  const keyForm = h('form', { class: 'field-line' }, keyInput, h('button', { type: 'submit', class: 'btn btn--small' }, 'Enregistrer'));
  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveYoutubeKey(keyInput.value);
    keyState.textContent = keyInput.value.trim() ? 'Clé enregistrée.' : 'Clé du site utilisée.';
  });
  const youtube = h(
    'div',
    { class: 'row row--stacked' },
    h(
      'span',
      { class: 'row__text' },
      h('span', { class: 'row__label' }, 'Clé YouTube'),
      h('span', { class: 'row__hint' }, fr('Pour chercher des vidéos dans l’app : clé « YouTube Data API v3 », gratuite. Elle reste sur cet appareil.')),
    ),
    keyForm,
    keyState,
  );

  sections.set('youtube', youtube);

  // --- Installation ---
  const install = h('button', { type: 'button', class: 'btn btn--small', hidden: true }, 'Installer l’app');
  let deferred: BeforeInstallPromptEvent | null = pendingInstall;
  install.hidden = !deferred;
  installListeners.push((event) => {
    deferred = event;
    install.hidden = !event;
  });
  install.addEventListener('click', () => {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null;
    install.hidden = true;
    void prompt.prompt();
  });
  const version = document.querySelector('meta[name="app-version"]')?.getAttribute('content') ?? '';

  s.body.append(
    group(fieldRow('Thème', themeSeg), fieldRow('Diapason', h('div', { class: 'stepper__controls' }, minus, a4Value, plus), { hint: 'Fréquence du La 4 pour l’accordeur.' })),
    group(proxy, youtube),
    group(
      fieldRow('Application', install, { hint: fr(version && version !== 'dev' && !version.startsWith('%') ? `Version ${version.slice(0, 7)}. Fonctionne hors-ligne.` : 'Fonctionne hors-ligne.') }),
    ),
  );
  return s;
}

// Proposition d'installation (Chrome, Edge, Android) : retenue jusqu'à l'ouverture des réglages.
let pendingInstall: BeforeInstallPromptEvent | null = null;
const installListeners: Array<(event: BeforeInstallPromptEvent | null) => void> = [];
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  pendingInstall = event as BeforeInstallPromptEvent;
  for (const fn of installListeners) fn(pendingInstall);
});
window.addEventListener('appinstalled', () => {
  pendingInstall = null;
  for (const fn of installListeners) fn(null);
});
