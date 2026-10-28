/**
 * Vote des transcriptions : chaque source qui a retrouvé deux attaques consécutives de la
 * tablature « vote » pour l'écart entre elles (en noires). L'écart le plus soutenu l'emporte ;
 * les mesures où les sources se contredisent, ou qu'aucune ne couvre, sont signalées.
 *
 * Les sources n'écrivent pas toujours à la même échelle (croches d'une version = doubles croches
 * d'une autre) : chacune est ramenée à l'échelle de la référence (une version pour guitare, sinon
 * la plus fiable), par puissance de deux.
 */
import type { SourceBar } from './sources';

export interface SourceTiming {
  label: string;
  /** Fiabilité de l'alignement (0 à 1). */
  weight: number;
  /** Transcription pour guitare : sa notation (mesure, valeurs) sert de référence avant les autres. */
  guitar?: boolean;
  /** Position (noires) de chaque attaque de la tablature dans la source ; NaN si non retrouvée. */
  at: Float64Array;
  /** Ressemblance de chaque paire : 0 pour une « fausse note » (place retenue, poids réduit). */
  similarity: Float32Array;
  bars: SourceBar[];
  tempos: Array<{ start: number; bpm: number }>;
}

/**
 * État de la place d'une attaque (l'écart qui la sépare de la précédente) :
 * - sure : au moins deux sources d'accord, et majorité nette (poids) ;
 * - single : une seule source ;
 * - disputed : les sources se contredisent (sans majorité de deux sources au moins) ;
 * - missing : aucune source, place déduite.
 */
export type OnsetStatus = 'sure' | 'single' | 'disputed' | 'missing';

export interface Consensus {
  /** Position de chaque attaque, en noires depuis le début de la nouvelle partition. */
  positions: number[];
  status: OnsetStatus[];
  time: { beats: number; beatType: number };
  tempo: number;
  /** Mesures (index dans la nouvelle partition) à vérifier. */
  doubtfulBars: number[];
  /** Sources retenues (les plus fiables d'abord). */
  sources: string[];
  counts: Record<OnsetStatus, number>;
}

/** Grille du vote : 1/48 de noire (quadruples croches et triolets). */
const GRID = 48;
/** Majorité nette : part du poids des votants. */
const MAJORITY = 0.6;

const q = (d: number): number => Math.round(d * GRID);
const known = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Facteur (puissance de deux) qui ramène la source `other` à l'échelle de `ref`. */
function scaleFactor(ref: SourceTiming, other: SourceTiming): number {
  const logs: number[] = [];
  let last = -1;
  for (let i = 0; i < ref.at.length; i++) {
    if (!known(ref.at[i]) || !known(other.at[i])) continue;
    if (last >= 0) {
      const dr = (ref.at[i] as number) - (ref.at[last] as number);
      const doth = (other.at[i] as number) - (other.at[last] as number);
      if (dr > 0 && doth > 0) logs.push(Math.log2(doth / dr));
    }
    last = i;
  }
  if (!logs.length) return 1;
  const r = Math.max(-2, Math.min(2, Math.round(median(logs))));
  return 2 ** -r;
}

/** Vote pondéré : valeur gagnante (en cases de la grille), sa part, votants et votants d'accord. */
function tally(votes: Array<{ value: number; weight: number }>): { value: number; share: number; voters: number; agree: number } | null {
  if (!votes.length) return null;
  const sums = new Map<number, number>();
  let total = 0;
  for (const v of votes) {
    sums.set(v.value, (sums.get(v.value) ?? 0) + v.weight);
    total += v.weight;
  }
  let value = 0;
  let best = -1;
  for (const [k, w] of sums) {
    if (w > best || (w === best && k < value)) {
      value = k;
      best = w;
    }
  }
  return { value, share: total > 0 ? best / total : 0, voters: votes.length, agree: votes.filter((v) => v.value === value).length };
}

function barAt(bars: SourceBar[], position: number): SourceBar | null {
  let found: SourceBar | null = null;
  for (const b of bars) {
    if (b.start <= position + 1e-9) found = b;
    else break;
  }
  return found;
}

function tempoAt(tempos: Array<{ start: number; bpm: number }>, position: number): number {
  let bpm = tempos[0]?.bpm ?? 120;
  for (const t of tempos) if (t.start <= position + 1e-9) bpm = t.bpm;
  return bpm;
}

/**
 * Rythme de la tablature d'après les sources. `original` : positions actuelles des attaques
 * (noires), utilisées seulement là où aucune source ne dit rien.
 */
export function consensus(timings: SourceTiming[], original: number[]): Consensus | null {
  const n = original.length;
  // Référence : une transcription pour guitare d'abord, puis la plus fiable.
  const sources = timings
    .filter((t) => t.at.length === n && t.at.some(known))
    .sort((a, b) => Number(!!b.guitar) - Number(!!a.guitar) || b.weight - a.weight);
  const ref = sources[0];
  if (!ref || n === 0) return null;
  // Toutes les sources à l'échelle de la plus fiable.
  const at = sources.map((s) => {
    const f = s === ref ? 1 : scaleFactor(ref, s);
    return Float64Array.from(s.at, (x) => x * f);
  });

  // Écarts entre attaques consécutives : vote.
  const gaps = new Array<number>(Math.max(0, n - 1)).fill(NaN);
  const status: OnsetStatus[] = new Array<OnsetStatus>(n).fill('missing');
  for (let i = 0; i + 1 < n; i++) {
    const votes: Array<{ value: number; weight: number }> = [];
    sources.forEach((s, k) => {
      const a = at[k] as Float64Array;
      if (!known(a[i]) || !known(a[i + 1])) return;
      const d = (a[i + 1] as number) - (a[i] as number);
      if (d <= 0) return;
      const exact = (s.similarity[i] as number) > 0 && (s.similarity[i + 1] as number) > 0;
      votes.push({ value: q(d), weight: s.weight * (exact ? 1 : 0.5) });
    });
    const t = tally(votes);
    if (!t || t.value <= 0) continue;
    gaps[i] = t.value / GRID;
    // Une source plus fiable l'emporte, mais une contradiction reste signalée.
    status[i + 1] = t.voters < 2 ? 'single' : t.agree >= 2 && t.share >= MAJORITY ? 'sure' : 'disputed';
  }

  // Écarts sans vote : par plages, d'après la durée totale donnée par les sources qui
  // encadrent la plage, répartie comme dans la tablature actuelle.
  const originalGap = (i: number): number => Math.max(1e-6, (original[i + 1] as number) - (original[i] as number));
  // Échelle de la tablature actuelle par rapport aux sources (puissance de deux).
  const ratios: number[] = [];
  for (let i = 0; i + 1 < n; i++) if (known(gaps[i])) ratios.push(Math.log2((gaps[i] as number) / originalGap(i)));
  const scale = ratios.length ? 2 ** Math.round(median(ratios)) : 1;
  for (let a = 0; a + 1 < n; ) {
    if (known(gaps[a])) {
      a++;
      continue;
    }
    let b = a;
    while (b + 1 < n && !known(gaps[b])) b++;
    // Plage d'écarts a..b-1 : des attaques a à b.
    const votes: Array<{ value: number; weight: number }> = [];
    sources.forEach((s, k) => {
      const arr = at[k] as Float64Array;
      if (known(arr[a]) && known(arr[b]) && (arr[b] as number) > (arr[a] as number)) votes.push({ value: q((arr[b] as number) - (arr[a] as number)), weight: s.weight });
    });
    const span = tally(votes);
    let sum = 0;
    for (let i = a; i < b; i++) sum += originalGap(i);
    const total = span ? span.value / GRID : sum * scale;
    // Répartition à la double croche, le reste sur le dernier écart.
    let used = 0;
    for (let i = a; i < b; i++) {
      const last = i === b - 1;
      const g = last ? Math.max(0.25, total - used) : Math.max(0.25, Math.round(((originalGap(i) / sum) * total) * 4) / 4);
      gaps[i] = g;
      used += g;
    }
    a = b;
  }

  // Positions : la première attaque retrouvée par la source de référence garde sa place
  // dans la mesure ; la mesure (et le tempo) sont ceux de cette source à cet endroit.
  const rel: number[] = [0];
  for (let i = 0; i + 1 < n; i++) rel.push((rel[i] as number) + (gaps[i] as number));
  const refAt = at[0] as Float64Array;
  const anchor = refAt.findIndex(known);
  const refPos = refAt[anchor] as number;
  const bar = barAt(ref.bars, refPos) ?? { start: 0, beats: 4, beatType: 4 };
  const length = (bar.beats * 4) / bar.beatType;
  const inBar = refPos - bar.start;
  const offset = (((inBar - (rel[anchor] as number)) % length) + length) % length;
  const positions = rel.map((p) => p + offset);

  // Première attaque : sûre si elle est retrouvée par plusieurs sources.
  const firstFound = sources.filter((_, k) => known((at[k] as Float64Array)[0])).length;
  status[0] = firstFound >= 2 ? 'sure' : firstFound === 1 ? 'single' : 'missing';

  const doubtful = new Set<number>();
  positions.forEach((p, i) => {
    if (status[i] === 'disputed' || status[i] === 'missing') doubtful.add(Math.floor(p / length + 1e-9));
  });
  const counts: Record<OnsetStatus, number> = { sure: 0, single: 0, disputed: 0, missing: 0 };
  for (const s of status) counts[s]++;
  return {
    positions,
    status,
    time: { beats: bar.beats, beatType: bar.beatType },
    tempo: Math.round(tempoAt(ref.tempos, refPos)),
    doubtfulBars: [...doubtful].sort((x, y) => x - y),
    sources: sources.map((s) => s.label),
    counts,
  };
}
