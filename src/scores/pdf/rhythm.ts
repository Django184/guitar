/**
 * Rythme : événements (accords, silences), n-olets, voix et positions dans la mesure,
 * et durées déduites de l'espacement quand la partition ne les écrit pas (tablature simple).
 */
import { beamTopAt, type Beam } from './geometry';
import { emit, nearestStaff, type PageContext } from './context';
import { staffBottom, staffTop, type Staff } from './layout';
import { dottedQuarters, typeFromQuarters, type NoteType, type RecNote } from './model';
import type { HeadSym, RestSym } from './symbols';
import type { VSeg } from './geometry';

export const EPS = 1e-6;

export interface Stem extends VSeg {
  up: boolean;
  heads: HeadSym[];
  beams: number;
  /** Ligatures traversant la hampe (pour regrouper les n-olets). */
  beamRefs: Beam[];
}

/** Accord ou silence avant l'attribution des voix. */
export interface Ev {
  kind: 'chord' | 'rest';
  /** Abscisse de la colonne (bord gauche de la tête « normale », du silence, ou centre d'une case de tablature). */
  x: number;
  x1: number;
  /** Ordonnée de référence (tête la plus haute, silence). */
  y: number;
  type: NoteType;
  dots: number;
  /** Durée réelle en noires (n-olets compris). */
  duration: number;
  tuplet?: { actual: number; normal: number };
  voice: number;
  onset: number;
  measureRest: boolean;
  notes: RecNote[];
  stemDir?: 'up' | 'down';
  /** Durée non écrite (tablature sans rythme) : à déduire de l'espacement. */
  unknown?: boolean;
  heads: HeadSym[];
  stem?: Stem;
  rest?: RestSym;
}

export function newEvent(kind: Ev['kind'], x: number, x1: number, y: number, type: NoteType): Ev {
  return { kind, x, x1, y, type, dots: 0, duration: 0, voice: 1, onset: 0, measureRest: false, notes: [], heads: [] };
}

export function measureLength(time: { beats: number; beatType: number }): number {
  return (time.beats * 4) / time.beatType;
}

/* ------------------------------------------------------------------ */
/* N-olets                                                             */
/* ------------------------------------------------------------------ */

/** Repère les chiffres de n-olets d'une portée et marque les événements concernés. */
export function applyTuplets(ctx: PageContext, staff: Staff, events: Ev[], stems: Stem[]): void {
  const sp = staff.spacing;
  // Chiffres proches de la portée (au-dessus ou au-dessous) ; c'est le groupe de notes trouvé qui tranche.
  const digits = ctx.symbols.tupletDigits.filter((d) => {
    if (d.x < staff.x0 || d.x > staff.x1) return false;
    const dist = d.y < staffTop(staff) ? staffTop(staff) - d.y : d.y - staffBottom(staff);
    return dist < 7 * sp && (nearestStaff(ctx.staves, d.x, d.y, 9) === staff || dist < 5 * sp);
  });
  // Nombres de plusieurs chiffres.
  const numbers: Array<{ x: number; x1: number; y: number; size: number; value: number }> = [];
  for (const d of [...digits].sort((a, b) => a.x - b.x)) {
    const last = numbers[numbers.length - 1];
    if (last && Math.abs(last.y - d.y) < 0.3 * sp && d.x - last.x1 < 0.3 * sp) {
      last.value = last.value * 10 + d.digit;
      last.x1 = d.x1;
    } else numbers.push({ x: d.x, x1: d.x1, y: d.y, size: d.size, value: d.digit });
  }
  for (const n of numbers) {
    if (n.value < 2 || n.value > 16) continue;
    const cx = (n.x + n.x1) / 2;
    // Centre du chiffre : ses glyphes reposent sur la ligne de base (SMuFL : centrés dessus).
    const smufl = (digits.find((d) => d.x === n.x)?.glyph.cp ?? 0) >= 0xe000;
    const midY = smufl ? n.y - 0.25 * sp : n.y - 0.35 * n.size;
    // Crochet : segments horizontaux de part et d'autre du chiffre.
    // Traits fins seulement : une ligature horizontale voisine n'est pas un crochet.
    const near = (h: { y: number; thickness: number }): boolean => Math.abs(h.y - midY) < 1.4 * sp && h.thickness < 0.3 * sp;
    const leftSeg = ctx.hsegs.find((h) => near(h) && h.x1 <= n.x + 0.2 * sp && n.x - h.x1 < 1.5 * sp && h.x1 - h.x0 > 0.3 * sp);
    const rightSeg = ctx.hsegs.find((h) => near(h) && h.x0 >= n.x1 - 0.2 * sp && h.x0 - n.x1 < 1.5 * sp && h.x1 - h.x0 > 0.3 * sp);
    let members: Ev[] = [];
    if (leftSeg && rightSeg) {
      const x0 = leftSeg.x0 - 0.6 * sp;
      const x1 = rightSeg.x1 + 0.3 * sp;
      const above = midY < staffTop(staff);
      // Le crochet appartient à cette portée si l'une de ses notes le touche (tête ou bout de hampe) :
      // un crochet entre deux portées n'est pas pris par la voisine.
      const reach = (e: Ev): boolean => {
        const ys = [e.y, ...e.heads.map((h) => h.y), ...(e.stem ? [e.stem.y0, e.stem.y1] : [])];
        return ys.some((y) => Math.abs(y - midY) < 2.5 * sp);
      };
      const inRange = events.filter((e) => e.x >= x0 && e.x <= x1);
      members = inRange.some(reach) ? inRange : [];
      // Deux voix : le crochet au-dessus concerne la voix haute.
      if (members.some((e) => e.stemDir === 'up') && members.some((e) => e.stemDir === 'down')) {
        members = members.filter((e) => !e.stemDir || e.stemDir === (above ? 'up' : 'down'));
      }
    } else {
      // Sans crochet : groupe de notes liées par la ligature la plus proche du chiffre.
      const beam = ctx.beams
        .filter((b) => b.x0 - sp < cx && b.x1 + sp > cx)
        .map((b) => ({ b, d: Math.abs(beamTopAt(b, Math.min(Math.max(cx, b.x0), b.x1)) - midY) }))
        .filter((e) => e.d < 3.2 * sp)
        .sort((a, b) => a.d - b.d)[0]?.b;
      if (beam) {
        const group = stems.filter((s) => s.beamRefs.includes(beam));
        members = events.filter((e) => e.stem && group.includes(e.stem));
        // Un silence pris dans le groupe (souvent en tête : « soupir + deux notes ») en fait partie.
        if (members.length >= 2) {
          const xs = members.map((e) => e.x).sort((a, b) => a - b);
          const step = ((xs[xs.length - 1] as number) - (xs[0] as number)) / (xs.length - 1);
          const from = (xs[0] as number) - step * 1.3;
          const to = xs[xs.length - 1] as number;
          for (const e of events) if (e.kind === 'rest' && !e.tuplet && e.x > from && e.x < to) members.push(e);
        }
      }
    }
    // Un chiffre de texte posé dans la portée, sans crochet, est un doigté (ou une case), pas un n-olet.
    const inside = midY > staffTop(staff) + 0.5 * sp && midY < staffBottom(staff) - 0.5 * sp;
    if (inside && !smufl && !(leftSeg && rightSeg)) continue;
    if (members.length < 2) continue;
    emit({ page: ctx.page.index, kind: 'tuplet', x0: Math.min(...members.map((e) => e.x)), y0: midY, x1: Math.max(...members.map((e) => e.x1)), y1: midY, label: `${n.value}@${Math.round(staffTop(staff))}${leftSeg && rightSeg ? 'b' : 'l'}` });
    for (const e of members) if (!e.tuplet) e.tuplet = { actual: n.value, normal: 0 };
  }
}

function normalFor(actual: number, beatType: number): number {
  if (actual === 2) return 3;
  if (actual === 4 && beatType === 8) return 3;
  let p = 1;
  while (p * 2 < actual) p *= 2;
  return p;
}

export function finalizeDurations(events: Ev[], time: { beats: number; beatType: number }): void {
  for (const e of events) {
    if (e.unknown) continue;
    e.duration = dottedQuarters(e.type, e.dots);
    if (e.tuplet) {
      if (!e.tuplet.normal) e.tuplet.normal = normalFor(e.tuplet.actual, time.beatType);
      e.duration = (e.duration * e.tuplet.normal) / e.tuplet.actual;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Durées déduites de l'espacement                                     */
/* ------------------------------------------------------------------ */

const SPACING_VALUES: Array<{ type: NoteType; dots: number; q: number }> = [
  { type: '16th', dots: 0, q: 0.25 },
  { type: 'eighth', dots: 0, q: 0.5 },
  { type: 'eighth', dots: 1, q: 0.75 },
  { type: 'quarter', dots: 0, q: 1 },
  { type: 'quarter', dots: 1, q: 1.5 },
  { type: 'half', dots: 0, q: 2 },
  { type: 'half', dots: 1, q: 3 },
  { type: 'whole', dots: 0, q: 4 },
];

/**
 * Durées d'une suite de colonnes d'après leur espacement : l'espace après une note croît
 * avec sa durée (≈ durée^0,6 chez les logiciels de gravure). On cherche les valeurs dont la
 * somme fait la mesure et dont l'espacement prévu colle le mieux à celui observé.
 */
export function inferDurations(events: Ev[], end: number, length: number): void {
  const list = [...events].sort((a, b) => a.x - b.x);
  if (!list.length) return;
  if (list.length === 1) {
    const only = list[0] as Ev;
    const v = SPACING_VALUES.find((s) => Math.abs(s.q - length) < EPS);
    only.duration = length;
    only.type = v?.type ?? 'whole';
    only.dots = v?.dots ?? 0;
    if (!v) only.measureRest = only.kind === 'rest';
    return;
  }
  const gaps = list.map((e, i) => Math.max(0.5, ((list[i + 1]?.x ?? end) - e.x) * (i === list.length - 1 ? 1.15 : 1)));
  const unit = 0.25;
  const target = Math.round(length / unit);
  const ALPHA = 0.6;
  let best: { cost: number; choice: number[] } | null = null;
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const ref = sortedGaps[Math.floor(sortedGaps.length / 2)] as number;
  for (const anchor of SPACING_VALUES) {
    const c = ref / anchor.q ** ALPHA;
    // Programmation dynamique : somme en doubles croches → coût minimal.
    const n = list.length;
    const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(target + 1).fill(Infinity));
    const from: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(target + 1).fill(-1));
    (cost[0] as number[])[0] = 0;
    for (let i = 0; i < n; i++) {
      const g = gaps[i] as number;
      for (let s = 0; s <= target; s++) {
        const base = (cost[i] as number[])[s] as number;
        if (base === Infinity) continue;
        SPACING_VALUES.forEach((v, vi) => {
          const units = Math.round(v.q / unit);
          if (s + units > target) return;
          const err = Math.log(g / (c * v.q ** ALPHA));
          const total = base + err * err + (v.dots ? 0.15 : 0);
          if (total < ((cost[i + 1] as number[])[s + units] as number)) {
            (cost[i + 1] as number[])[s + units] = total;
            (from[i + 1] as number[])[s + units] = vi;
          }
        });
      }
    }
    const finalCost = (cost[n] as number[])[target] as number;
    if (finalCost === Infinity) continue;
    if (!best || finalCost < best.cost) {
      const choice: number[] = [];
      let s = target;
      for (let i = n; i > 0; i--) {
        const vi = (from[i] as number[])[s] as number;
        choice.unshift(vi);
        s -= Math.round((SPACING_VALUES[vi] as { q: number }).q / unit);
      }
      best = { cost: finalCost, choice };
    }
  }
  list.forEach((e, i) => {
    const v = best ? SPACING_VALUES[best.choice[i] as number] : null;
    const q = v?.q ?? length / list.length;
    e.duration = q;
    e.type = v?.type ?? typeFromQuarters(q) ?? 'quarter';
    e.dots = v?.dots ?? 0;
  });
}

/**
 * Tablature à hampes : noires et blanches ont souvent le même dessin. Si la mesure est trop
 * courte, on allonge en blanches les noires suivies du plus grand espace.
 */
export function repairStemDurations(events: Ev[], end: number, length: number): void {
  const list = [...events].sort((a, b) => a.x - b.x);
  let total = list.reduce((s, e) => s + e.duration, 0);
  if (total >= length - EPS) return;
  const gaps = new Map(list.map((e, i) => [e, (list[i + 1]?.x ?? end) - e.x]));
  const candidates = list.filter((e) => e.kind === 'chord' && e.type === 'quarter' && !e.tuplet).sort((a, b) => (gaps.get(b) ?? 0) - (gaps.get(a) ?? 0));
  const changed: Ev[] = [];
  for (const e of candidates) {
    if (total >= length - EPS) break;
    const extra = e.duration;
    if (total + extra > length + EPS) continue;
    e.type = 'half';
    e.duration *= 2;
    total += extra;
    changed.push(e);
  }
  if (Math.abs(total - length) > EPS) {
    for (const e of changed) {
      e.type = 'quarter';
      e.duration /= 2;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Voix et positions                                                   */
/* ------------------------------------------------------------------ */

const fullRest = (e: Ev): boolean => e.kind === 'rest' && (e.type === 'whole' || e.type === 'breve') && e.dots === 0;

/**
 * N-olets non chiffrés (le graveur n'écrit souvent le « 3 » ou le « 6 » que sur les premiers
 * groupes) : si une voix déborde de la mesure, on cherche des groupes ligaturés de 3 ou 6 valeurs
 * égales dont le passage en triolets la remet exactement à la bonne durée.
 */
export function repairImplicitTuplets(voice: Ev[], length: number): void {
  const total = voice.reduce((s, e) => s + e.duration, 0);
  let excess = total - length;
  if (excess <= EPS) return;
  // Groupes : événements reliés par une même ligature.
  const groups: Ev[][] = [];
  for (const e of voice) {
    if (!e.stem?.beamRefs.length || e.tuplet) continue;
    const g = groups.find((list) => list.some((o) => o.stem?.beamRefs.some((b) => e.stem?.beamRefs.includes(b))));
    if (g) g.push(e);
    else groups.push([e]);
  }
  // Un silence de même valeur juste avant ou après le groupe peut en faire partie (« soupir + 5 notes »).
  const ordered = [...voice].sort((a, b) => a.x - b.x);
  for (const g of groups) {
    if (g.length % 3 === 0) continue;
    const first = ordered.indexOf(g.reduce((a, b) => (a.x < b.x ? a : b)));
    const last = ordered.indexOf(g.reduce((a, b) => (a.x > b.x ? a : b)));
    for (const i of [first - 1, last + 1]) {
      const r = ordered[i];
      if (r && r.kind === 'rest' && !r.tuplet && Math.abs(r.duration - (g[0] as Ev).duration) < EPS && (g.length + 1) % 3 === 0) {
        g.push(r);
        break;
      }
    }
  }
  const candidates = groups.filter((g) => g.length % 3 === 0 && g.every((e) => Math.abs(e.duration - (g[0] as Ev).duration) < EPS && e.duration <= 0.5));
  // Réduction d'un groupe en triolets : un tiers de sa durée.
  const chosen: Ev[][] = [];
  for (const g of candidates) {
    const cut = g.reduce((s, e) => s + e.duration, 0) / 3;
    if (cut <= excess + EPS) {
      chosen.push(g);
      excess -= cut;
    }
    if (Math.abs(excess) < EPS) break;
  }
  if (Math.abs(excess) > EPS) return;
  for (const g of chosen) {
    for (const e of g) {
      e.tuplet = { actual: 3, normal: 2 };
      e.duration = (e.duration * 2) / 3;
    }
  }
}

function sequential(list: Ev[], voice: number): void {
  let t = 0;
  for (const e of list) {
    e.voice = voice;
    e.onset = t;
    t += e.duration;
  }
}

/**
 * Attribue voix et débuts aux événements d'une mesure (une portée).
 * `col` : tolérance horizontale pour deux événements simultanés.
 */
export function assignVoices(events: Ev[], length: number, col: number, middle: number): void {
  if (!events.length) return;
  const sorted = [...events].sort((a, b) => a.x - b.x);
  const overlapping = sorted.some((a, i) => sorted.slice(i + 1).some((b) => Math.abs(b.x - a.x) < col));

  if (!overlapping) {
    if (sorted.length === 1 && fullRest(sorted[0] as Ev)) {
      const e = sorted[0] as Ev;
      e.measureRest = true;
      e.duration = length;
    }
    repairImplicitTuplets(sorted, length);
    sequential(sorted, 1);
    return;
  }

  // Deux voix : hampes vers le haut (et silences hauts) = voix 1, vers le bas = voix 2.
  for (const e of sorted) e.voice = e.stemDir === 'up' ? 1 : e.stemDir === 'down' ? 2 : 0;
  for (const e of sorted) {
    if (e.voice !== 0) continue;
    const partner = sorted.find((o) => o !== e && Math.abs(o.x - e.x) < col && o.voice !== 0);
    if (partner) e.voice = e.y < partner.y ? 1 : 2;
    else if (e.kind === 'rest') e.voice = e.y < middle - 0.1 ? 1 : e.y > middle + 0.1 ? 2 : 0;
  }
  const total = (v: number): number => sorted.filter((e) => e.voice === v).reduce((s, e) => s + e.duration, 0);
  for (const e of sorted) if (e.voice === 0) e.voice = total(1) <= total(2) ? 1 : 2;

  let v1 = sorted.filter((e) => e.voice === 1);
  let v2 = sorted.filter((e) => e.voice === 2);
  if (!v1.length || !v2.length) {
    sequential(sorted, 1);
    return;
  }
  for (const voice of [v1, v2]) {
    if (voice.length === 1 && fullRest(voice[0] as Ev)) {
      (voice[0] as Ev).measureRest = true;
      (voice[0] as Ev).duration = length;
    }
  }
  repairImplicitTuplets(v1, length);
  repairImplicitTuplets(v2, length);
  // La voix la plus complète sert de référence ; l'autre se cale sur ses colonnes.
  if (total(2) > total(1) + EPS) [v1, v2] = [v2, v1];
  const main = v1;
  const other = v2;
  let t = 0;
  for (const e of main) {
    e.onset = t;
    t += e.duration;
  }
  let cursor = 0;
  for (const e of other) {
    const partner = main.find((o) => Math.abs(o.x - e.x) < col);
    if (partner && partner.onset >= cursor - EPS) cursor = partner.onset;
    else if (!partner) {
      // Entre deux colonnes de la voix principale : après la dernière qui précède.
      const before = main.filter((o) => o.x < e.x - col).pop();
      if (before && before.onset + before.duration > cursor + EPS && other[0] === e) cursor = before.onset + before.duration;
    }
    e.onset = cursor;
    cursor += e.duration;
  }
}
