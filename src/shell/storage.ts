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
}

export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const isOneOf =
  <T extends string>(options: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (options as readonly string[]).includes(value);
