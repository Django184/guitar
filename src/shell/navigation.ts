// Navigation et reprise (ECOSYSTEME.md §4, motifs N1 à N8) :
// - chaque écran retrouve sa position au retour (bouton ou geste « retour »), la bibliothèque aussi quand on y
//   revient par l'onglet ; un autre écran s'ouvre en haut ;
// - en revenant d'une partition, son lien dans la bibliothèque est remis en vue, signalé deux secondes et reçoit
//   le focus ;
// - le bouton « Retour à la bibliothèque » et l'onglet de l'écran d'où l'on vient reviennent en arrière dans
//   l'historique au lieu d'y ajouter une page ; l'onglet de l'écran affiché remonte en haut.
// Positions : sessionStorage de l'onglet (effacées à sa fermeture), jamais exportées.

import { type Location, type RouteId, navigate, parseLocation } from './router';

const STORE = 'pg.positions';
const MAX = 40;
const LISTS = new Set(['#/partitions']); // position gardée aussi en y revenant par l'onglet
const ITEMS = /^#\/partitions\/./; // lien retrouvé dans l'écran où l'on revient
const SIGNAL_MS = 2000;

interface Mark {
  vu: boolean;
  depuis: string | null;
}

interface Visit {
  key: string;
  revisit: boolean;
  from: string | null;
  arrived: boolean;
  found: HTMLElement | null;
  start: number;
}

/** Clé d'un écran : « #/partitions/<id> », « #/accordeur »… */
export function keyOf(loc: Location): string {
  return `#/${loc.route}${loc.param ? `/${encodeURIComponent(loc.param)}` : ''}`;
}

/** Marque d'une entrée d'historique, lue avec tolérance. */
export function readMark(state: unknown): Mark {
  const s = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  return { vu: s.vu === true, depuis: typeof s.depuis === 'string' ? s.depuis : null };
}

/** État à écrire sur une entrée affichée pour la première fois : champs gardés, écran d'origine gardé s'il existe. */
export function markedState(state: unknown, previous: string | null): Record<string, unknown> {
  const s = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  return { ...s, vu: true, depuis: readMark(state).depuis ?? previous };
}

/** Positions par écran : la dernière retenue en dernier, les plus anciennes oubliées au-delà de `max`. */
export function rememberPosition(positions: Record<string, number>, key: string, y: number, max = MAX): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(positions)) if (k !== key && typeof v === 'number') next[k] = v;
  next[key] = Math.max(0, Math.round(y));
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete next[k];
  return next;
}

function loadPositions(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(STORE) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

let positions: Record<string, number> = typeof sessionStorage === 'undefined' ? {} : loadPositions();
let current: string | null = null;
let visit: Visit | null = null;

const scroller = (): HTMLElement | null => document.getElementById('main');

function save(): void {
  const main = scroller();
  if (!current || !main) return;
  positions = rememberPosition(positions, current, main.scrollTop);
  try {
    sessionStorage.setItem(STORE, JSON.stringify(positions));
  } catch {
    // stockage indisponible : positions gardées en mémoire
  }
}

/** Début d'un changement d'écran (routeur) : position de l'écran quitté, marque de l'entrée d'historique. */
export function enterScreen(key: string): void {
  save();
  const mark = readMark(history.state);
  if (key === current) {
    visit = { key, revisit: true, from: null, arrived: false, found: null, start: 0 };
    return;
  }
  if (!mark.vu) history.replaceState(markedState(history.state, current), '');
  visit = { key, revisit: mark.vu, from: current, arrived: false, found: null, start: 0 };
  current = key;
}

// Position rétablie ; contenu encore incomplet (liste en chargement) : nouvel essai, sauf si l'on fait défiler soi-même.
function scrollToY(main: HTMLElement, y: number): void {
  main.scrollTop = y;
  if (!y || main.scrollTop >= y - 2) return;
  const key = current;
  let tries = 0;
  let touched = false;
  const kinds = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  const stop = (): void => {
    touched = true;
  };
  kinds.forEach((k) => window.addEventListener(k, stop, { passive: true }));
  const again = (): void => {
    if (!touched && current === key && tries++ < 10) {
      main.scrollTop = y;
      if (main.scrollTop < y - 2) {
        window.setTimeout(again, 150);
        return;
      }
    }
    kinds.forEach((k) => window.removeEventListener(k, stop));
  };
  window.setTimeout(again, 100);
}

function inView(el: Element, main: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const box = main.getBoundingClientRect();
  const nav = document.querySelector('.nav');
  // Barre d'onglets en bas sur téléphone : ce qu'elle couvre n'est pas visible.
  const navTop = nav && nav.getBoundingClientRect().top > box.top ? nav.getBoundingClientRect().top : box.bottom;
  return r.top >= box.top && r.bottom <= Math.min(box.bottom, navTop);
}

function linkTo(key: string, main: HTMLElement): HTMLElement | null {
  const links = Array.from(main.querySelectorAll<HTMLAnchorElement>('a[href^="#/"]'));
  return links.find((a) => a.getAttribute('href') === key && a.getClientRects().length > 0) ?? null;
}

function find(v: Visit, key: string, first: boolean): HTMLElement | null {
  const main = scroller();
  const el = main ? linkTo(key, main) : null;
  if (!el || !main) return null;
  // Aussi quand la liste a été redessinée : la partition ouverte remonte en tête (ordre des dernières ouvertes).
  if (!inView(el, main)) el.scrollIntoView({ block: 'center' });
  if (first) v.start = performance.now();
  const elapsed = performance.now() - v.start;
  if (elapsed >= SIGNAL_MS) return el;
  // liste redessinée entre-temps : le signal continue là où il en était
  el.style.animationDelay = first ? '' : `${-Math.round(elapsed)}ms`;
  el.classList.add('is-found');
  window.setTimeout(() => {
    el.classList.remove('is-found');
    el.style.animationDelay = '';
  }, SIGNAL_MS - elapsed);
  const active = document.activeElement;
  if (first || !active || active === document.body) el.focus({ preventScroll: true });
  return el;
}

/**
 * Écran affiché : position rétablie (retour, ou bibliothèque revue par son onglet) ou haut de page, puis lien
 * de l'écran quitté retrouvé. Appelée après chaque changement d'écran et quand la bibliothèque est redessinée :
 * seul le premier appel fait défiler. Renvoie vrai si le focus a été placé.
 */
export function arriveScreen(): boolean {
  const key = keyOf(parseLocation(location.hash));
  if (!visit || visit.key !== key) enterScreen(key);
  const v = visit as Visit;
  const main = scroller();
  if (!v.arrived && main) {
    v.arrived = true;
    const y = positions[key];
    scrollToY(main, (v.revisit || LISTS.has(key)) && y !== undefined ? y : 0);
  }
  const look = v.from && ITEMS.test(v.from) && (v.revisit || LISTS.has(key)) ? v.from : null;
  if (!look) return false;
  if (!v.found && !v.start) v.found = find(v, look, true);
  else if (v.found && !v.found.isConnected) v.found = find(v, look, false);
  return !!v.found;
}

/** Retour vers un écran : en arrière dans l'historique si l'on en vient, sinon nouvel écran. */
export function backTo(route: RouteId, param: string | null = null): void {
  if (readMark(history.state).depuis === keyOf({ route, param })) history.back();
  else navigate(route, param);
}

/** Onglet touché : celui de l'écran affiché remonte en haut ; celui de l'écran d'où l'on vient revient en arrière. */
export function onTabClick(event: MouseEvent, route: RouteId): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = keyOf({ route, param: null });
  if (target === keyOf(parseLocation(location.hash))) {
    event.preventDefault();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller()?.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  } else if (readMark(history.state).depuis === target) {
    event.preventDefault();
    history.back();
  }
}

/** À l'ouverture : défilement géré par l'app, position gardée à la sortie. */
export function setupNavigation(): void {
  history.scrollRestoration = 'manual';
  window.addEventListener('pagehide', save);
}
