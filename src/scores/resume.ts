// « Reprendre où j'en étais » (ECOSYSTEME.md §4, N6) : dernière position jouée de chaque partition, gardée
// sur l'appareil (localStorage « pg.reprise ») pour rouvrir la partition à cette mesure quand aucun passage
// n'est choisi. Ce n'est pas une préférence : la sauvegarde .zip ne l'emporte pas, et la bibliothèque n'en dépend pas.

import type { ScoreEntry } from './library';

const KEY = 'pg.reprise';
const MAX = 30;

export interface ResumePoint {
  /** Position du curseur, en ticks d'alphaTab. */
  tick: number;
  /** Mesure correspondante (0 = mesure 1). */
  bar: number;
  /** Date de l'enregistrement (ms). */
  at: number;
}

export type ResumeMap = Record<string, ResumePoint>;

const isPoint = (v: unknown): v is ResumePoint =>
  !!v &&
  typeof v === 'object' &&
  [(v as ResumePoint).tick, (v as ResumePoint).bar, (v as ResumePoint).at].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

/** Relu du stockage : seules les entrées valides sont gardées. */
export function parseResume(raw: unknown): ResumeMap {
  const out: ResumeMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, point] of Object.entries(raw as Record<string, unknown>)) if (isPoint(point)) out[id] = point;
  return out;
}

/** Ajoute ou remplace une position ; au-delà de `max`, les plus anciennes sont oubliées. */
export function withPoint(map: ResumeMap, id: string, point: ResumePoint, max = MAX): ResumeMap {
  const next: ResumeMap = { ...map, [id]: point };
  const ids = Object.keys(next).sort((a, b) => (next[b] as ResumePoint).at - (next[a] as ResumePoint).at);
  for (const old of ids.slice(max)) delete next[old];
  return next;
}

/** Mesure (0 = première) qui contient `tick`, d'après le début de chaque mesure, en ticks croissants. */
export function barAt(starts: readonly number[], tick: number): number {
  let bar = 0;
  for (let i = 0; i < starts.length; i++) {
    if ((starts[i] as number) <= tick) bar = i;
    else break;
  }
  return bar;
}

/**
 * Mesure visée par ← ou → : la suivante ou la précédente ; ← ramène d'abord au début de la mesure en cours
 * quand le curseur en est loin (au-delà de `slack` ticks), comme un lecteur de musique.
 */
export function stepTarget(starts: readonly number[], tick: number, delta: number, slack: number): number {
  if (!starts.length) return 0;
  const bar = barAt(starts, tick);
  let target = bar + delta;
  if (delta < 0 && tick - (starts[bar] as number) > slack) target = bar;
  return Math.max(0, Math.min(starts.length - 1, target));
}

/** Ligne « Reprendre » de la bibliothèque : passage choisi et vitesse, sinon mesure de la dernière position. */
export function resumeLabel(entry: ScoreEntry, point: ResumePoint | undefined): string | null {
  const parts: string[] = [];
  const sel = entry.settings.selection;
  if (sel) parts.push(sel.startBar === sel.endBar ? `mesure ${sel.startBar + 1}` : `mesures ${sel.startBar + 1}–${sel.endBar + 1}`);
  else if (point && point.bar > 0) parts.push(`mesure ${point.bar + 1}`);
  if (entry.settings.speed < 1) parts.push(`${Math.round(entry.settings.speed * 100)}\u00a0%`);
  return parts.length ? `Reprendre\u00a0: ${parts.join(', ')}` : null;
}

export function loadResume(): ResumeMap {
  try {
    return parseResume(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return {};
  }
}

export function saveResume(id: string, tick: number, bar: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(withPoint(loadResume(), id, { tick: Math.max(0, Math.round(tick)), bar, at: Date.now() })));
  } catch {
    // Stockage plein ou interdit : la position ne sera simplement pas gardée.
  }
}
