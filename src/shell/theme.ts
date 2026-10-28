import { isOneOf, loadPref, savePref } from './storage';

export type Theme = 'dark' | 'light';

const THEME_COLORS: Record<Theme, string> = {
  dark: '#1a1311',
  light: '#eceee9',
};

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Applique le thème et prévient les écrans qui dessinent eux-mêmes (partition) via « themechange ». */
export function applyTheme(theme: Theme): void {
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  savePref('theme', theme);
  if (changed) document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

/** Thème mémorisé (sombre par défaut), appliqué au démarrage. */
export function initTheme(): void {
  applyTheme(loadPref<Theme>('theme', 'dark', isOneOf<Theme>(['dark', 'light'])));
}
