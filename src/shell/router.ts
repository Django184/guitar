export type RouteId = 'accordeur' | 'metronome' | 'partitions';

export const ROUTES: readonly RouteId[] = ['accordeur', 'metronome', 'partitions'];

export const DEFAULT_ROUTE: RouteId = 'accordeur';

export interface Location {
  route: RouteId;
  /** Sous-chemin éventuel, ex. l'identifiant d'une partition : « #/partitions/abc » → « abc ». */
  param: string | null;
}

/** « #/partitions/abc » → { route: 'partitions', param: 'abc' }. Toute route inconnue renvoie vers l'accordeur. */
export function parseLocation(hash: string): Location {
  const [id = '', param] = hash.replace(/^#\/?/, '').split('?')[0]?.split('/') ?? [];
  if (!(ROUTES as readonly string[]).includes(id)) return { route: DEFAULT_ROUTE, param: null };
  let decoded: string | null = null;
  if (param) {
    try {
      decoded = decodeURIComponent(param);
    } catch {
      decoded = null;
    }
  }
  return { route: id as RouteId, param: decoded };
}

/** Compatibilité : la route seule. */
export function parseRoute(hash: string): RouteId {
  return parseLocation(hash).route;
}

/**
 * Routage par hash : fonctionne hors-ligne et sans configuration serveur.
 * `onChange` reçoit l'emplacement et un booléen indiquant si c'est le chargement initial.
 */
export function startRouter(onChange: (location: Location, initial: boolean) => void): void {
  window.addEventListener('hashchange', () => onChange(parseLocation(location.hash), false));
  onChange(parseLocation(location.hash), true);
}

export function navigate(route: RouteId, param: string | null = null, replace = false): void {
  const hash = `#/${route}${param ? `/${encodeURIComponent(param)}` : ''}`;
  if (location.hash === hash) return;
  if (replace) {
    history.replaceState(history.state, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}
