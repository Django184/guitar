const PREFIX = 'pg.';

/**
 * Préférences persistées dans localStorage (thème, tempo, accordage…).
 * Toute lecture est validée : une valeur corrompue retombe sur la valeur par défaut.
 * localStorage peut être indisponible (navigation privée) : on ignore alors silencieusement.
 */
export function loadPref<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Stockage plein ou interdit : la préférence ne sera simplement pas mémorisée.
  }
  // Les écrans concernés suivent (réglage changé dans la feuille « Réglages »).
  document.dispatchEvent(new CustomEvent('prefchange', { detail: { key, value } }));
}

/** Préférence changée ailleurs dans l'app (feuille « Réglages ») : `fn(valeur)`. */
export function onPrefChange(key: string, fn: (value: unknown) => void): void {
  document.addEventListener('prefchange', (e) => {
    const detail = (e as CustomEvent<{ key: string; value: unknown }>).detail;
    if (detail?.key === key) fn(detail.value);
  });
}

export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const isOneOf =
  <T extends string>(options: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (options as readonly string[]).includes(value);

/** Préférences réglées sur cet appareil, parmi `keys` (sauvegarde). Une valeur illisible est ignorée. */
export function readPrefs(keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw !== null) out[key] = JSON.parse(raw);
    } catch {
      // Valeur corrompue ou stockage indisponible : non exportée.
    }
  }
  return out;
}

/** Écrit des préférences reprises d'une sauvegarde (chaque lecture les revalide ensuite). */
export function writePrefs(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) savePref(key, value);
}
