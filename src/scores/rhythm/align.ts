/**
 * Alignement symbolique : les attaques de la tablature (hauteurs seulement, rythme incertain)
 * retrouvées dans une piste d'une transcription (hauteurs et positions).
 *
 * La transposition (octaves comprises) est d'abord estimée sur l'ensemble des notes ; puis une
 * programmation dynamique (alignement semi-global) suit toute la tablature dans la piste, en
 * sautant librement l'introduction, la fin et l'accompagnement. Une note retrouvée à l'octave
 * près compte à moitié : une partition de piano ou une autre tessiture conviennent aussi.
 *
 * Contrôle : la même recherche avec la tablature lue à l'envers. Une transcription d'un autre
 * morceau, dans la même tonalité, y ressemble presque autant ; la bonne, beaucoup moins.
 */

/** Attaque de la tablature : hauteurs MIDI jouées ensemble. */
export interface Onset {
  pitches: number[];
}

/** Attaque d'une transcription, datée (en noires depuis le début). */
export interface TimedOnset extends Onset {
  start: number;
}

export interface Alignment {
  /** Demi-tons ajoutés aux notes de la transcription pour retrouver celles de la tablature. */
  shift: number;
  /** Pour chaque attaque de la tablature : indice de l'attaque retrouvée, ou -1. */
  match: Int32Array;
  /** Ressemblance de chaque paire (0 à 1) ; 0 si l'attaque n'est pas retrouvée (ou fausse note). */
  similarity: Float32Array;
  /** Part de la tablature retrouvée, pondérée par la ressemblance (0 à 1). */
  quality: number;
  /** Vraisemblance moyenne par attaque (rapport à une piste quelconque) : le critère de choix. */
  score: number;
}

const MISMATCH = -1.2;
const SKIP_TAB = -1.5;
/** Coût d'une attaque de la piste sautée : fixe, plus selon sa durée. */
const SKIP_SOURCE = 0.1;
const SKIP_SOURCE_TIME = 0.3;
/** Une paire compte si la moitié des notes de la tablature est dans l'attaque de la piste. */
const PAIR_MIN = 0.5;
/** Au-delà, l'alignement serait trop long (et trop gourmand en mémoire) : piste ignorée. */
export const MAX_CELLS = 40_000_000;

const pc = (p: number): number => ((p % 12) + 12) % 12;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Histogramme des hauteurs exactes (0 à 127). */
export function pitchHistogram(onsets: readonly Onset[]): Float64Array {
  const h = new Float64Array(128);
  for (const o of onsets) {
    for (const p of o.pitches) if (p >= 0 && p < 128) h[p] = (h[p] as number) + 1;
  }
  return h;
}

/**
 * Décalages (en demi-tons, octaves comprises) les plus vraisemblables : corrélation des
 * histogrammes de hauteurs. Du meilleur au moins bon, avec leur ressemblance (cosinus).
 */
export function shifts(tab: Float64Array, source: Float64Array, range = 36): Array<{ shift: number; score: number }> {
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 128; i++) {
    na += (tab[i] as number) ** 2;
    nb += (source[i] as number) ** 2;
  }
  const norm = Math.sqrt(na * nb) || 1;
  const out: Array<{ shift: number; score: number }> = [];
  for (let shift = -range; shift <= range; shift++) {
    let s = 0;
    for (let p = Math.max(0, -shift); p < 128 && p + shift < 128; p++) s += (tab[p + shift] as number) * (source[p] as number);
    out.push({ shift, score: s / norm });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Notes d'une attaque de la piste, décalées : hauteurs exactes (128 bits) et classes (12 bits). */
interface SourceSet {
  bits: Uint32Array;
  pcs: number;
}

function sourceSets(source: readonly Onset[], shift: number): SourceSet[] {
  return source.map((o) => {
    const bits = new Uint32Array(4);
    let pcs = 0;
    for (const raw of o.pitches) {
      const p = raw + shift;
      if (p >= 0 && p < 128) bits[p >> 5] = (bits[p >> 5] as number) | (1 << (p & 31));
      pcs |= 1 << pc(p);
    }
    return { bits, pcs };
  });
}

/** Ressemblance d'une attaque de la tablature et d'une attaque de la piste (0 à 1). */
function similarity(pitches: readonly number[], set: SourceSet): number {
  if (!pitches.length) return 0;
  let score = 0;
  for (const p of pitches) {
    if (p >= 0 && p < 128 && ((set.bits[p >> 5] as number) >>> (p & 31)) & 1) score += 1;
    else if ((set.pcs >> pc(p)) & 1) score += 0.5;
  }
  return score / pitches.length;
}

/**
 * Aligne la tablature sur une piste, pour un décalage donné. Chaque attaque de la tablature est
 * retrouvée (dans l'ordre) ou laissée de côté ; les attaques de la piste absentes de la
 * tablature (accompagnement, autres passages) sont sautées.
 */
export function alignOnsets(tab: readonly Onset[], source: readonly TimedOnset[], shift: number): Alignment | null {
  const n = tab.length;
  const m = source.length;
  if (!n || !m || (n + 1) * (m + 1) > MAX_CELLS) return null;
  const sets = sourceSets(source, shift);
  const notes = tab.map((o) => [...new Set(o.pitches)]);
  // Chance qu'une note quelconque de la tablature tombe dans chaque attaque de la piste :
  // une paire dans un accord épais prouve moins qu'une paire sur une note seule.
  const hist = pitchHistogram(tab);
  let total = 0;
  for (const v of hist) total += v;
  const pcHist = new Float64Array(12);
  hist.forEach((v, p) => (pcHist[p % 12] = (pcHist[p % 12] as number) + v / (total || 1)));
  const chance = sets.map((set) => {
    let exact = 0;
    for (let p = 0; p < 128; p++) if (((set.bits[p >> 5] as number) >>> (p & 31)) & 1) exact += (hist[p] as number) / (total || 1);
    let pcs = 0;
    for (let c = 0; c < 12; c++) if ((set.pcs >> c) & 1) pcs += pcHist[c] as number;
    return exact + 0.5 * Math.max(0, pcs - exact);
  });
  // Sauter une attaque de la piste coûte selon sa durée (rapportée à l'écart habituel) :
  // entre deux notes consécutives de la tablature, la bonne piste n'a presque rien d'autre.
  const gaps = source.map((o, j) => Math.max(0, ((source[j + 1] as TimedOnset | undefined)?.start ?? o.start) - o.start));
  const usual = median(gaps.filter((g) => g > 0)) || 1;
  const skipCost = Float32Array.from(gaps, (g) => SKIP_SOURCE + SKIP_SOURCE_TIME * Math.min(4, g / usual));
  // back : 1 = paire, 2 = attaque de la tablature sautée, 3 = attaque de la piste sautée.
  const back = new Uint8Array((n + 1) * (m + 1));
  let prev = new Float32Array(m + 1);
  let cur = new Float32Array(m + 1);
  // Début de la piste sauté librement.
  for (let j = 1; j <= m; j++) back[j] = 3;
  const reward = new Float32Array(m);
  const sim = new Float32Array(m);
  for (let i = 1; i <= n; i++) {
    const pitches = notes[i - 1] as number[];
    for (let j = 0; j < m; j++) {
      const s = similarity(pitches, sets[j] as SourceSet);
      sim[j] = s;
      reward[j] = s >= PAIR_MIN ? Math.log((0.05 + s) / (0.05 + (chance[j] as number))) : MISMATCH;
    }
    // Fin de la piste sautée librement.
    const last = i === n;
    const base = i * (m + 1);
    cur[0] = (prev[0] as number) + SKIP_TAB;
    back[base] = 2;
    for (let j = 1; j <= m; j++) {
      const pair = (prev[j - 1] as number) + (reward[j - 1] as number);
      const skipTab = (prev[j] as number) + SKIP_TAB;
      const skipSrc = (cur[j - 1] as number) - (last ? 0 : (skipCost[j - 1] as number));
      if (pair >= skipTab && pair >= skipSrc) {
        cur[j] = pair;
        back[base + j] = 1;
      } else if (skipTab >= skipSrc) {
        cur[j] = skipTab;
        back[base + j] = 2;
      } else {
        cur[j] = skipSrc;
        back[base + j] = 3;
      }
    }
    [prev, cur] = [cur, prev];
  }
  const score = (prev[m] as number) / n;

  const match = new Int32Array(n).fill(-1);
  const sims = new Float32Array(n);
  let i = n;
  let j = m;
  while (i > 0) {
    const step = j === 0 ? 2 : back[i * (m + 1) + j];
    if (step === 1) {
      const s = similarity(notes[i - 1] as number[], sets[j - 1] as SourceSet);
      // Paire « fausse note » : la place est retenue, sans ressemblance.
      match[i - 1] = j - 1;
      sims[i - 1] = s >= PAIR_MIN ? s : 0;
      i--;
      j--;
    } else if (step === 2) {
      i--;
    } else {
      j--;
    }
  }
  let found = 0;
  for (let k = 0; k < n; k++) found += sims[k] as number;
  return { shift, match, similarity: sims, quality: found / n, score };
}

/** Piste candidate d'une transcription. */
export interface CandidateTrack {
  onsets: TimedOnset[];
  /** Piste de guitare : départage les ex aequo. */
  guitar?: boolean;
}

export interface TrackAlignment extends Alignment {
  track: number;
  /** Vraisemblance de la même recherche avec la tablature à l'envers (contrôle). */
  control: number;
}

/**
 * La transcription contient-elle vraiment la tablature ? Vraisemblance suffisante, et nettement
 * meilleure qu'avec la tablature à l'envers. Calibré sur le corpus music21 : la bonne pièce
 * (même réduite au piano, transposée, valeurs doublées) obtient au moins 0,8 et 0,45 d'écart ;
 * une autre pièce du même style, au plus 0,4 et 0,15.
 */
export const MIN_SCORE = 0.6;
export const MIN_MARGIN = 0.3;
export const credible = (a: TrackAlignment): boolean => a.score >= MIN_SCORE && a.score - a.control >= MIN_MARGIN;

/**
 * Meilleur alignement de la tablature dans une transcription : les pistes les plus
 * ressemblantes (hauteurs), puis les deux décalages les plus probables pour chacune.
 * `yieldNow` : rend la main au navigateur entre deux calculs.
 */
export async function bestAlignment(
  tab: readonly Onset[],
  tracks: readonly CandidateTrack[],
  options: { maxTracks?: number; yieldNow?: () => Promise<void> } = {},
): Promise<TrackAlignment | null> {
  const hist = pitchHistogram(tab);
  const ranked = tracks
    .map((track, index) => {
      const best = shifts(hist, pitchHistogram(track.onsets));
      return { index, track, best, score: (best[0]?.score ?? 0) * (track.guitar ? 1.05 : 1) };
    })
    // Une piste bien plus courte que la tablature ne peut pas la contenir.
    .filter((c) => c.track.onsets.length >= tab.length * 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxTracks ?? 4);
  let best: (Alignment & { track: number }) | null = null;
  let bestScore = -Infinity;
  for (const c of ranked) {
    // Deux décalages distincts (hors octave voisine du premier, déjà couverte à moitié).
    const tried: number[] = [];
    for (const { shift } of c.best) {
      if (tried.length >= 2) break;
      if (tried.some((s) => s === shift)) continue;
      tried.push(shift);
      await options.yieldNow?.();
      const a = alignOnsets(tab, c.track.onsets, shift);
      if (!a) continue;
      const score = a.score + (c.track.guitar ? 0.05 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { ...a, track: c.index };
      }
    }
  }
  if (!best) return null;
  await options.yieldNow?.();
  const reversed = [...tab].reverse();
  const control = alignOnsets(reversed, (tracks[best.track] as CandidateTrack).onsets, best.shift)?.score ?? 0;
  return { ...best, control };
}
