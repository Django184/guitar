/**
 * Rythme d'une tablature retrouvé à partir des instants où chaque note est entendue
 * (tapés pendant la vidéo, ou détectés dans l'enregistrement).
 *
 * Programmation dynamique sur (position dans la mesure, tempo) : chaque écart entre deux notes
 * devient un nombre entier de doubles croches au tempo courant, qui peut varier doucement.
 * Quand la tablature a des barres de mesure fiables, chaque note reste dans sa mesure (ce qui
 * fixe aussi le tempo) et les positions sur les temps, puis sur les croches, sont préférées.
 * Sans barres, seul un tempo vraisemblable départage les lectures doublées ou divisées par deux.
 */

export interface FitEvent {
  /** Mesure actuelle de la note (index). */
  bar: number;
  /** Position actuelle dans la mesure, en noires (déduite de l'espacement). */
  onset: number;
  /** Instant entendu, en secondes ; null si inconnu. */
  time: number | null;
}

export interface FitOptions {
  /** Longueur d'une mesure, en noires. */
  barLength: number;
  /** Les mesures de la tablature sont fiables (barres écrites) : chaque note y reste. */
  barsKnown: boolean;
}

export interface FitResult {
  /** Position de chaque note depuis le début de la partition, en noires. */
  positions: number[];
  /** Tempo moyen, en noires par minute. */
  tempo: number;
  /** Écart moyen entre les instants mesurés et le rythme trouvé, en secondes. */
  error: number;
  /** Nombre de notes datées utilisées. */
  timed: number;
}

/** Cases par noire : la double croche. */
const GRID = 4;
/** Durées de double croche envisagées (secondes) : de 375 à 30 noires par minute. */
const TAU_MIN = 0.04;
const TAU_MAX = 0.5;
const TEMPI = 64;
const TAU = Array.from({ length: TEMPI }, (_, j) => TAU_MIN * (TAU_MAX / TAU_MIN) ** (j / (TEMPI - 1)));
/** Tempo « typique » (100 à la noire) : départage seulement les lectures équivalentes. */
const TAU_REF = 60 / 100 / GRID;
/** Imprécision d'un instant (s) et part proportionnelle à la durée. */
const SIGMA_ABS = 0.03;
const SIGMA_REL = 0.08;
/** Coût d'un changement de tempo d'un cran (≈ 4 %) entre deux notes. */
const TEMPO_STEP_COST = 1.5;
const TEMPO_PRIOR = 3;
const HINT_COST = 0.25;

/** Préférence métrique : temps, puis croches, puis doubles croches. */
function metric(g: number): number {
  if (g % GRID === 0) return 0;
  if (g % (GRID / 2) === 0) return 0.2;
  return 0.5;
}

/** Préférence pour les durées simples (en doubles croches) : croche, noire, blanche… puis pointées. */
function durationPrior(k: number): number {
  if (k === 2 || k === 4 || k === 8 || k === 16) return 0;
  if (k === 1) return 0.1;
  if (k === 3 || k === 6 || k === 12) return 0.3;
  return 0.6;
}

function tempoPrior(t: number): number {
  return TEMPO_PRIOR * Math.log((TAU[t] as number) / TAU_REF) ** 2;
}

function observation(d: number, k: number, tau: number): number {
  const expected = k * tau;
  const e = (d - expected) / (SIGMA_ABS + SIGMA_REL * expected);
  return e * e;
}

/** Instants manquants à l'intérieur de la plage datée : interpolés selon les positions actuelles. */
function fillTimes(events: FitEvent[], orig: number[], a: number, b: number): number[] {
  const times = events.map((e) => e.time ?? NaN);
  for (let i = a + 1; i < b; i++) {
    if (!Number.isNaN(times[i] as number)) continue;
    let j = i + 1;
    while (j < b && Number.isNaN(times[j] as number)) j++;
    const p = i - 1;
    const span = (orig[j] as number) - (orig[p] as number);
    for (let m = i; m < j; m++) {
      const f = span > 0 ? ((orig[m] as number) - (orig[p] as number)) / span : (m - p) / (j - p);
      times[m] = (times[p] as number) + f * ((times[j] as number) - (times[p] as number));
    }
    i = j;
  }
  return times;
}

export function fitRhythm(events: FitEvent[], options: FitOptions): FitResult {
  const L = options.barLength;
  const G = Math.max(1, Math.round(L * GRID));
  const orig = events.map((e) => e.bar * L + e.onset);
  const a = events.findIndex((e) => e.time !== null);
  let b = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.time !== null) {
      b = i;
      break;
    }
  }
  if (a < 0 || b - a < 1) return { positions: orig, tempo: 0, error: 0, timed: Math.max(0, b - a + 1) };

  const times = fillTimes(events, orig, a, b);
  let barsKnown = options.barsKnown;
  for (let i = a; i < b && barsKnown; i++) if ((events[i + 1] as FitEvent).bar < (events[i] as FitEvent).bar) barsKnown = false;

  const S = G * TEMPI;
  const n = b - a + 1;
  // Coûts et retours arrière : état = g × TEMPI + t.
  let cost = new Float64Array(S).fill(Infinity);
  const back = new Int32Array(n * S).fill(-1);
  const steps = new Int16Array(n * S);
  const hint = (i: number, g: number): number =>
    barsKnown ? HINT_COST * Math.min(3, Math.abs(g - Math.round((events[i] as FitEvent).onset * GRID))) : 0;

  const g0 = (((Math.round((orig[a] as number) * GRID) % G) + G) % G) as number;
  for (let g = 0; g < G; g++) {
    if (!barsKnown && g !== g0) continue;
    for (let t = 0; t < TEMPI; t++) cost[g * TEMPI + t] = (barsKnown ? metric(g) : 0) + hint(a, g) + tempoPrior(t);
  }

  const kMax = 2 * G;
  for (let i = a; i < b; i++) {
    const next = new Float64Array(S).fill(Infinity);
    const row = (i + 1 - a) * S;
    const d = Math.max(0.001, (times[i + 1] as number) - (times[i] as number));
    const barStep = barsKnown ? ((events[i + 1] as FitEvent).bar - (events[i] as FitEvent).bar) * G : 0;
    for (let g = 0; g < G; g++) {
      for (let t = 0; t < TEMPI; t++) {
        const c = cost[g * TEMPI + t] as number;
        if (c === Infinity) continue;
        for (let dt = -2; dt <= 2; dt++) {
          const t2 = t + dt;
          if (t2 < 0 || t2 >= TEMPI) continue;
          const tau = TAU[t2] as number;
          const base = c + TEMPO_STEP_COST * dt * dt + tempoPrior(t2);
          if (barsKnown) {
            for (let g2 = 0; g2 < G; g2++) {
              const k = barStep + g2 - g;
              if (k < 1) continue;
              const total = base + observation(d, k, tau) + durationPrior(k) + metric(g2) + hint(i + 1, g2);
              const s2 = g2 * TEMPI + t2;
              if (total < (next[s2] as number)) {
                next[s2] = total;
                back[row + s2] = g * TEMPI + t;
                steps[row + s2] = k;
              }
            }
          } else {
            for (let k = 1; k <= kMax; k++) {
              const g2 = (g + k) % G;
              // Sans barres, la place du premier temps est inconnue : pas de préférence métrique
              // (elle « expliquerait » les syncopes en décalant toute la suite).
              const total = base + observation(d, k, tau) + durationPrior(k);
              const s2 = g2 * TEMPI + t2;
              if (total < (next[s2] as number)) {
                next[s2] = total;
                back[row + s2] = g * TEMPI + t;
                steps[row + s2] = k;
              }
            }
          }
        }
      }
    }
    cost = next;
  }

  // Meilleur état final, puis remontée.
  let best = 0;
  for (let s = 1; s < S; s++) if ((cost[s] as number) < (cost[best] as number)) best = s;
  const ks = new Array<number>(n).fill(0);
  const taus = new Array<number>(n).fill(TAU_REF);
  const gs = new Array<number>(n).fill(0);
  let s = best;
  for (let r = n - 1; r >= 0; r--) {
    gs[r] = Math.floor(s / TEMPI);
    taus[r] = TAU[s % TEMPI] as number;
    if (r > 0) {
      ks[r] = steps[r * S + s] as number;
      s = back[r * S + s] as number;
    }
  }

  const positions = [...orig];
  if (barsKnown) {
    for (let r = 0; r < n; r++) positions[a + r] = (events[a + r] as FitEvent).bar * L + (gs[r] as number) / GRID;
  } else {
    let grid = Math.round((orig[a] as number) * GRID);
    positions[a] = grid / GRID;
    for (let r = 1; r < n; r++) {
      grid += ks[r] as number;
      positions[a + r] = grid / GRID;
    }
  }
  // Notes non datées : avant, inchangées ; après, décalées comme la dernière note datée.
  const shift = (positions[b] as number) - (orig[b] as number);
  for (let i = b + 1; i < events.length; i++) positions[i] = (orig[i] as number) + shift;

  let err = 0;
  for (let r = 1; r < n; r++) {
    const d = (times[a + r] as number) - (times[a + r - 1] as number);
    err += Math.abs(d - (ks[r] as number) * (taus[r] as number));
  }
  // Tempo moyen : noires parcourues sur le temps écoulé (plus juste que les crans de la recherche).
  const span = (times[b] as number) - (times[a] as number);
  const tempo = span > 0 ? (60 * ((positions[b] as number) - (positions[a] as number))) / span : 0;
  return {
    positions,
    tempo,
    error: n > 1 ? err / (n - 1) : 0,
    timed: n,
  };
}

/** Valeurs doublées (×2) ou divisées par deux (÷2) : la lecture « à l'octave » de tempo. */
export function scalePositions(positions: number[], factor: number): number[] {
  if (!positions.length) return positions;
  const first = positions[0] as number;
  return positions.map((p) => first + Math.round((p - first) * factor * GRID) / GRID);
}

/** Point de synchronisation alphaTab : début de mesure ↔ instant dans l'enregistrement. */
export interface SyncPoint {
  barIndex: number;
  barOccurence: number;
  barPosition: number;
  millisecondOffset: number;
}

/**
 * Instants des débuts de mesure, interpolés entre les notes datées (positions en noires),
 * et prolongés au tempo local avant la première et après la dernière.
 */
export function barSyncPoints(positions: number[], times: Array<number | null>, barStarts: number[]): SyncPoint[] {
  const pts = positions
    .map((p, i) => ({ p, t: times[i] }))
    .filter((x): x is { p: number; t: number } => typeof x.t === 'number' && Number.isFinite(x.t))
    .sort((x, y) => x.p - y.p);
  // Une seule date par position (accords tapés deux fois…).
  const uniq: Array<{ p: number; t: number }> = [];
  for (const x of pts) {
    const last = uniq[uniq.length - 1];
    if (last && Math.abs(last.p - x.p) < 1e-9) continue;
    if (last && x.t <= last.t) continue;
    uniq.push(x);
  }
  if (uniq.length < 2) return [];
  const slope = (from: number, to: number): number => {
    const p0 = uniq[from] as { p: number; t: number };
    const p1 = uniq[to] as { p: number; t: number };
    return (p1.t - p0.t) / Math.max(1e-6, p1.p - p0.p);
  };
  const head = slope(0, Math.min(uniq.length - 1, 4));
  const tail = slope(Math.max(0, uniq.length - 5), uniq.length - 1);
  const timeAt = (p: number): number => {
    const first = uniq[0] as { p: number; t: number };
    const last = uniq[uniq.length - 1] as { p: number; t: number };
    if (p <= first.p) return first.t - (first.p - p) * head;
    if (p >= last.p) return last.t + (p - last.p) * tail;
    let lo = 0;
    let hi = uniq.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((uniq[mid] as { p: number }).p <= p) lo = mid;
      else hi = mid;
    }
    const x0 = uniq[lo] as { p: number; t: number };
    const x1 = uniq[hi] as { p: number; t: number };
    return x0.t + ((p - x0.p) / (x1.p - x0.p)) * (x1.t - x0.t);
  };
  const out: SyncPoint[] = [];
  let previous = -Infinity;
  barStarts.forEach((start, barIndex) => {
    const ms = Math.round(timeAt(start) * 1000);
    if (ms <= previous) return;
    previous = ms;
    out.push({ barIndex, barOccurence: 0, barPosition: 0, millisecondOffset: ms });
  });
  return out;
}
