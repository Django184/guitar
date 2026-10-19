export type RouteId = 'accordeur' | 'metronome' | 'partitions';

export const ROUTES: readonly RouteId[] = ['accordeur', 'metronome', 'partitions'];

export const DEFAULT_ROUTE: RouteId = 'accordeur';

/** « #/metronome » → « metronome ». Toute valeur inconnue renvoie vers l'accordeur. */
export function parseRoute(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (ROUTES as readonly string[]).includes(id) ? (id as RouteId) : DEFAULT_ROUTE;
}

/**
 * Routage par hash : fonctionne hors-ligne et sans configuration serveur.
 * `onChange` reçoit la route et un booléen indiquant si c'est la route initiale.
 */
export function startRouter(onChange: (route: RouteId, initial: boolean) => void): void {
  window.addEventListener('hashchange', () => onChange(parseRoute(location.hash), false));
  onChange(parseRoute(location.hash), true);
}
