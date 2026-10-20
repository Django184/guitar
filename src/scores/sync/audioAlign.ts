/**
 * Alignement d'un enregistrement sur les notes connues d'une tablature : à quel instant
 * chaque note (ou accord) est-elle jouée ?
 *
 * On connaît déjà les hauteurs, dans l'ordre : il reste à les retrouver dans le son.
 * 1. Attaques : pics du flux spectral (montée d'énergie, toutes les 12 ms) — une corde pincée
 *    en produit une nette, un accord une seule.
 * 2. Ce qui apparaît à chaque attaque : spectre juste après moins spectre juste avant (les
 *    notes qui résonnent encore s'annulent), réduit à ses 12 classes de hauteur (chroma).
 * 3. Appariement ordonné attaques ↔ notes (programmation dynamique, comme un alignement de
 *    séquences) : une attaque en trop (bruit, percussion) ou une note introuvable coûtent,
 *    une note dont les hauteurs apparaissent à l'attaque rapporte.
 * La transposition (enregistrement dans un autre ton) est cherchée parmi les plus probables.
 */
import { FFT, hann } from './fft';

export interface AlignEvent {
  /** Hauteurs MIDI réellement entendues (capodastre compris). */
  pitches: number[];
}

export interface AlignResult {
  /** Instant de chaque note dans l'enregistrement (s) ; null si elle n'a pas été trouvée. */
  times: Array<number | null>;
  /** Transposition (demi-tons) entre la tablature et l'enregistrement. */
  transpose: number;
  /** Part des notes retrouvées avec assurance (0 à 1). */
  matched: number;
}

const TARGET_RATE = 11025;
const CHROMA_FFT = 2048;
const FLUX_FFT = 512;
const FLUX_HOP = 128;
const F_MIN = 70;
const F_MAX = 4000;
/** Écart minimal entre deux attaques (s). */
const MIN_GAP = 0.045;

/** Coûts de l'appariement : une bonne ressemblance (> MATCH_PIVOT) rapporte, une mauvaise coûte. */
const MATCH_WEIGHT = 2;
const MATCH_PIVOT = 0.65;
const SKIP_ONSET = 0.35;
/** Apparier une attaque faible (moins de la moitié de la force médiane) coûte jusqu'à ceci. */
const WEAK_ONSET = 0.4;
const SKIP_EDGE_ONSET = 0.02;
const SKIP_EVENT = 0.8;
const SKIP_EDGE_EVENT = 0.6;

const HARMONICS: Array<[number, number]> = [
  [0, 1],
  [12, 0.5],
  [19, 0.35],
  [24, 0.25],
  [28, 0.2],
  [31, 0.15],
];

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function downsample(samples: Float32Array, sampleRate: number): { x: Float64Array; rate: number } {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const n = Math.floor(samples.length / factor);
  const x = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += samples[i * factor + j] as number;
    x[i] = s / factor;
    peak = Math.max(peak, Math.abs(x[i] as number));
  }
  if (peak > 0) for (let i = 0; i < n; i++) x[i] = (x[i] as number) / peak;
  return { x, rate: sampleRate / factor };
}

interface Onset {
  time: number;
  strength: number;
  /** Chroma de ce qui apparaît à l'attaque (normalisé). */
  chroma: Float64Array;
  /** Chroma de tout ce qui sonne juste après l'attaque. */
  sounding: Float64Array;
}

/** Ressemblance d'une attaque avec une note : ce qui apparaît, ou à défaut ce qui sonne. */
function similarity(o: Onset, tpl: Float64Array): number {
  return Math.max(cosine(o.chroma, tpl), 0.85 * cosine(o.sounding, tpl));
}

/** Pics du flux spectral : attaques. */
async function detectOnsets(x: Float64Array, rate: number, onProgress?: (f: number) => void): Promise<Array<{ time: number; strength: number }>> {
  const frames = Math.max(1, Math.floor((x.length - FLUX_FFT) / FLUX_HOP) + 1);
  const flux = new Float64Array(frames);
  const fft = new FFT(FLUX_FFT);
  const win = hann(FLUX_FFT);
  const re = new Float64Array(FLUX_FFT);
  const im = new Float64Array(FLUX_FFT);
  let prev = new Float64Array(FLUX_FFT / 2);
  let cur = new Float64Array(FLUX_FFT / 2);
  for (let f = 0; f < frames; f++) {
    const start = f * FLUX_HOP;
    for (let i = 0; i < FLUX_FFT; i++) {
      re[i] = (x[start + i] ?? 0) * (win[i] as number);
      im[i] = 0;
    }
    fft.transform(re, im);
    let sum = 0;
    for (let k = 2; k < FLUX_FFT / 2; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k] as number, im[k] as number));
      if (f > 0) sum += Math.max(0, (cur[k] as number) - (prev[k] as number));
    }
    flux[f] = sum;
    [prev, cur] = [cur, prev];
    if (f % 2000 === 1999) {
      onProgress?.((0.6 * f) / frames);
      await pause();
    }
  }
  // Seuil adaptatif : moyenne locale (± 0,25 s) + marge relative au niveau général.
  const sorted = Array.from(flux).sort((a, b) => a - b);
  const typical = (sorted[Math.floor(sorted.length * 0.9)] as number) || 1;
  const half = Math.max(3, Math.round((0.25 * rate) / FLUX_HOP));
  const near = Math.max(1, Math.round((0.03 * rate) / FLUX_HOP));
  const out: Array<{ time: number; strength: number }> = [];
  let sum = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) sum += flux[++hi] as number;
    while (lo < f - half) sum -= flux[lo++] as number;
    count = hi - lo + 1;
    const v = flux[f] as number;
    if (v < sum / count + 0.12 * typical || v < 1.3 * typical) continue;
    let peak = true;
    for (let g = Math.max(0, f - near); g <= Math.min(frames - 1, f + near) && peak; g++) {
      if ((flux[g] as number) > v || ((flux[g] as number) === v && g < f)) peak = false;
    }
    if (!peak) continue;
    // Instant : centre de la fenêtre où l'énergie monte.
    const time = (f * FLUX_HOP + FLUX_FFT / 2) / rate;
    const last = out[out.length - 1];
    if (last && time - last.time < MIN_GAP) {
      if (v / typical > last.strength) out[out.length - 1] = { time, strength: v / typical };
      continue;
    }
    out.push({ time, strength: v / typical });
  }
  return out;
}

/**
 * Chromas à chaque attaque : ce qui apparaît (spectre après moins spectre avant : les notes
 * qui résonnent encore s'annulent) et tout ce qui sonne juste après (utile quand la même note
 * est rejouée). Les fenêtres s'arrêtent aux attaques voisines : dans un passage rapide,
 * elles ne mélangent pas les notes suivantes.
 */
function onsetChromas(x: Float64Array, rate: number, onsets: Array<{ time: number; strength: number }>): Onset[] {
  const fft = new FFT(CHROMA_FFT);
  const re = new Float64Array(CHROMA_FFT);
  const im = new Float64Array(CHROMA_FFT);
  const kLo = Math.ceil((F_MIN * CHROMA_FFT) / rate);
  const kHi = Math.min(CHROMA_FFT / 2 - 1, Math.floor((F_MAX * CHROMA_FFT) / rate));
  const windows = new Map<number, Float64Array>();
  const minLength = Math.round(0.05 * rate);
  /** Spectre d'amplitude d'une fenêtre de Hann [start, start + length), complétée de zéros. */
  const spectrum = (start: number, length: number): Float64Array => {
    const len = Math.max(minLength, Math.min(CHROMA_FFT, Math.round(length)));
    let win = windows.get(len);
    if (!win) {
      win = hann(len);
      windows.set(len, win);
    }
    let wsum = 0;
    for (let i = 0; i < CHROMA_FFT; i++) {
      const w = i < len ? (win[i] as number) : 0;
      wsum += w;
      re[i] = (x[start + i] ?? 0) * w;
      im[i] = 0;
    }
    fft.transform(re, im);
    const mag = new Float64Array(kHi + 1);
    for (let k = kLo; k <= kHi; k++) mag[k] = Math.hypot(re[k] as number, im[k] as number) / wsum;
    return mag;
  };
  /**
   * Chroma par pics spectraux : seules les raies qui dominent leurs voisines (et 3 % du maximum)
   * comptent, à leur fréquence interpolée ; le bruit de fond, réparti partout, est ignoré.
   */
  const toChroma = (mag: Float64Array): Float64Array => {
    let max = 0;
    for (let k = kLo; k <= kHi; k++) max = Math.max(max, mag[k] as number);
    const chroma = new Float64Array(12);
    const floor = 0.03 * max;
    for (let k = kLo + 1; k < kHi; k++) {
      const m = mag[k] as number;
      const l = mag[k - 1] as number;
      const r = mag[k + 1] as number;
      if (m <= floor || m <= l || m < r) continue;
      const den = l - 2 * m + r;
      const bin = k + (den < 0 ? (0.5 * (l - r)) / den : 0);
      const midi = 69 + 12 * Math.log2((bin * rate) / CHROMA_FFT / 440);
      chroma[((Math.round(midi) % 12) + 12) % 12] += m;
    }
    let norm = 0;
    for (let p = 0; p < 12; p++) {
      chroma[p] = Math.sqrt(chroma[p] as number);
      norm += (chroma[p] as number) ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) chroma[p] = (chroma[p] as number) / norm;
    return chroma;
  };
  const gap = Math.round(0.01 * rate);
  return onsets.map((o, i) => {
    const at = Math.round(o.time * rate);
    const next = onsets[i + 1] ? Math.round((onsets[i + 1] as { time: number }).time * rate) : Infinity;
    const previous = i > 0 ? Math.round((onsets[i - 1] as { time: number }).time * rate) : -Infinity;
    const afterLength = Math.min(CHROMA_FFT, next - at - 2 * gap);
    const beforeLength = Math.min(CHROMA_FFT, at - previous - 2 * gap, at - gap);
    const after = spectrum(at + gap, afterLength);
    const before = spectrum(Math.max(0, at - gap - Math.max(minLength, beforeLength)), beforeLength);
    const diff = new Float64Array(after.length);
    for (let k = kLo; k <= kHi; k++) diff[k] = Math.max(0, (after[k] as number) - 1.2 * (before[k] as number));
    return { ...o, chroma: toChroma(diff), sounding: toChroma(after) };
  });
}

/** Chroma attendu des notes nouvelles de chaque événement (fondamentale et harmoniques). */
function templates(events: AlignEvent[], shift: number): Float64Array[] {
  return events.map((e) => {
    const v = new Float64Array(12);
    for (const p of e.pitches) for (const [offset, w] of HARMONICS) v[(((p + shift + offset) % 12) + 12) % 12] += w;
    // Même compression que les chromas mesurés (racine de l'amplitude).
    let norm = 0;
    for (let p = 0; p < 12; p++) {
      v[p] = Math.sqrt(v[p] as number);
      norm += (v[p] as number) ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) v[p] = (v[p] as number) / norm;
    return v;
  });
}

function cosine(a: Float64Array, b: Float64Array): number {
  let d = 0;
  for (let p = 0; p < 12; p++) d += (a[p] as number) * (b[p] as number);
  return d;
}

interface Match {
  cost: number;
  /** Attaque appariée à chaque note (−1 : aucune). */
  onsetOf: Int32Array;
  similarity: Float64Array;
}

/** Appariement ordonné notes ↔ attaques (programmation dynamique). */
function match(onsets: Onset[], tpl: Float64Array[]): Match {
  const n = tpl.length;
  const m = onsets.length;
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1 : apparié, 2 : attaque sautée, 3 : note sautée
  // Saillance d'une attaque : sa force rapportée à la force médiane des attaques. Laisser de côté
  // une attaque nette coûte cher ; une attaque faible (résonance, bruit) presque rien, et elle
  // rapporte moins si on l'apparie.
  const strengths = onsets.map((o) => o.strength).sort((a, b) => a - b);
  const typical = (strengths[Math.floor(strengths.length / 2)] as number | undefined) || 1;
  const salience = onsets.map((o) => Math.min(2, Math.max(0.1, o.strength / typical)));
  const skipOnset = (j: number): number => SKIP_ONSET * (salience[j] as number);
  const weak = (j: number): number => WEAK_ONSET * Math.max(0, 1 - (salience[j] as number) / 0.5);
  for (let j = 1; j <= m; j++) {
    cost[j] = (cost[j - 1] as number) + SKIP_EDGE_ONSET;
    move[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cost[i * W] = (cost[(i - 1) * W] as number) + SKIP_EDGE_EVENT;
    move[i * W] = 3;
    const t = tpl[i - 1] as Float64Array;
    for (let j = 1; j <= m; j++) {
      const sim = similarity(onsets[j - 1] as Onset, t);
      let best = (cost[(i - 1) * W + j - 1] as number) + MATCH_WEIGHT * (MATCH_PIVOT - sim) + weak(j - 1);
      let mv = 1;
      const so = (cost[i * W + j - 1] as number) + skipOnset(j - 1);
      if (so < best) {
        best = so;
        mv = 2;
      }
      const se = (cost[(i - 1) * W + j] as number) + SKIP_EVENT;
      if (se < best) {
        best = se;
        mv = 3;
      }
      cost[i * W + j] = best;
      move[i * W + j] = mv;
    }
  }
  // Fin : notes ou attaques restantes, à bas prix (enregistrement plus court ou plus long).
  let bi = n;
  let bj = m;
  let bestCost = Infinity;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = (cost[i * W + j] as number) + SKIP_EDGE_EVENT * (n - i) + SKIP_EDGE_ONSET * (m - j);
      if (c < bestCost) {
        bestCost = c;
        bi = i;
        bj = j;
      }
    }
  }
  const onsetOf = new Int32Array(n).fill(-1);
  const sims = new Float64Array(n);
  let i = bi;
  let j = bj;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j] as number;
    if (mv === 1) {
      onsetOf[i - 1] = j - 1;
      sims[i - 1] = similarity(onsets[j - 1] as Onset, tpl[i - 1] as Float64Array);
      i--;
      j--;
    } else if (mv === 2) j--;
    else i--;
  }
  return { cost: bestCost, onsetOf, similarity: sims };
}

/** Transpositions les plus probables : corrélation des chromas moyens des attaques et de la tablature. */
function likelyShifts(onsets: Onset[], events: AlignEvent[], count: number): number[] {
  const audio = new Float64Array(12);
  for (const o of onsets) for (let p = 0; p < 12; p++) audio[p] += o.chroma[p] as number;
  const tab = new Float64Array(12);
  for (const t of templates(events, 0)) for (let p = 0; p < 12; p++) tab[p] += t[p] as number;
  const corr = Array.from({ length: 12 }, (_, shift) => {
    let c = 0;
    for (let p = 0; p < 12; p++) c += (tab[p] as number) * (audio[(p + shift) % 12] as number);
    return { shift: shift > 6 ? shift - 12 : shift, c };
  });
  const top = corr
    .sort((a, b) => b.c - a.c)
    .slice(0, count)
    .map((x) => x.shift);
  // Toujours essayer la tonalité écrite : quartes et quintes trompent la corrélation.
  return top.includes(0) ? top : [0, ...top.slice(0, count - 1)];
}

export async function alignAudio(
  samples: Float32Array,
  sampleRate: number,
  events: AlignEvent[],
  onProgress?: (fraction: number) => void,
): Promise<AlignResult> {
  const n = events.length;
  if (!n || samples.length < sampleRate) return { times: events.map(() => null), transpose: 0, matched: 0 };
  const { x, rate } = downsample(samples, sampleRate);
  const found = await detectOnsets(x, rate, onProgress);
  const onsets = onsetChromas(x, rate, found);
  onProgress?.(0.8);
  await pause();
  let best: (Match & { shift: number }) | null = null;
  for (const shift of likelyShifts(onsets, events, 3)) {
    const result = match(onsets, templates(events, shift));
    if (!best || result.cost < best.cost) best = { ...result, shift };
  }
  onProgress?.(1);
  const result = best as Match & { shift: number };
  const times = Array.from(result.onsetOf, (j) => (j >= 0 ? (onsets[j] as Onset).time : null));
  const matched = Array.from(result.similarity).filter((s) => s > 0.6).length / n;
  return { times, transpose: result.shift, matched };
}
