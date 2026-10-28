/**
 * Doigtés de la main gauche, optimisés sur toute la pièce (programmation dynamique, Viterbi).
 *
 * Chaque instant où au moins une note frettée commence est un « événement ». Ses états possibles
 * sont les affectations de doigts (1 index … 4 auriculaire, pouce) aux notes frettées qui
 * sonnent alors : celles qui commencent, et celles qui sonnent encore (gardées sous le même
 * doigt, ou lâchées moyennant un coût). Chaque état a un coût propre (écartement, barré,
 * auriculaire, pouce) et un coût de passage depuis l'état précédent (déplacement de la main,
 * pondéré par le temps disponible ; doigt qui change pour une même case ; doigt qui saute d'une
 * note à l'autre ; liaisons et glissés). Le chemin de coût minimal donne les doigts : la main
 * anticipe ainsi la suite, au lieu de choisir note par note.
 *
 * Les cordes à vide n'ont pas de doigt. Un doigt imposé (correction de l'utilisateur) restreint
 * les états de sa note : le reste de la pièce se réorganise autour.
 */

/** 0 : aucun doigt (corde à vide) ; 1 index, 2 majeur, 3 annulaire, 4 auriculaire ; 5 pouce. */
export type Finger = 0 | 1 | 2 | 3 | 4 | 5;
export const THUMB: Finger = 5;

export interface FingerNote {
  id: string;
  /** Corde : 0 = la plus grave. */
  string: number;
  /** Case comptée depuis le sillet (ou le capodastre) ; 0 = corde à vide. */
  fret: number;
  /** Début et fin du son, en noires. */
  start: number;
  end: number;
  /** Hammer-on ou pull-off depuis la note précédente de la même corde (doigts différents). */
  legato?: boolean;
  /** Glissé depuis la note précédente de la même corde (même doigt, de préférence). */
  slide?: boolean;
}

export interface FingeringOptions {
  /** Doigts imposés, par identifiant de note. */
  overrides?: ReadonlyMap<string, Finger>;
  /** Nombre de cordes (pour le pouce : deux cordes graves). */
  strings?: number;
}

/** Poids des coûts (en « efforts » arbitraires, comparables entre eux). */
const W = {
  /** Doigt plus haut que sa case naturelle (écartement) : coût progressif, d × stretch + d² × stretch2. */
  stretch: 0.5,
  stretch2: 0.35,
  /** Doigt plus bas que sa case naturelle (doigts serrés, comme pour l'accord de La), par case. */
  cramp: 0.35,
  pinky: 0.15,
  barre: 0.8,
  barreNote: 0.2,
  /**
   * Index et autre doigt sur la même case, par corde intermédiaire non jouée à cette case
   * (un barré est alors plus naturel).
   */
  sameFretSpread: 0.35,
  partialBarre: 1.6,
  thumb: 3,
  sameFretOrder: 0.4,
  releaseBase: 0.3,
  release: 0.8,
  /** Déplacer la main coûte surtout par le fait de bouger, un peu par la distance. */
  shiftBase: 1,
  shiftPerFret: 0.1,
  /** Accord étalé sur plusieurs cases sans l'index : la main est moins stable. */
  noIndex: 0.25,
  repeatOtherFinger: 0.6,
  fingerHop: 0.8,
  /** Même doigt, même case, autre corde : il roule ou glisse d'une corde à l'autre. */
  fingerRoll: 0.15,
  fingerRollPerString: 0.05,
  legatoSameFinger: 6,
  slideOtherFinger: 2,
  /** Forme répétée jouée autrement que d'habitude (second passage). */
  inconsistent: 0.4,
  /** Mode large (une case de plus) et libre. */
  wide: 1.5,
  relaxed: 20,
};
/** Notes encore tenues prises en compte (les plus récentes). */
const MAX_HELD = 3;
/** États gardés par événement (les moins coûteux). */
const MAX_STATES = 36;
const EPS = 1e-6;

interface Placed {
  note: FingerNote;
  finger: Finger;
}

interface State {
  placed: Placed[];
  /** Case de l'index (position de la main). */
  anchor: number;
  cost: number;
  /** Tables de recherche (calculées une fois, pour les coûts de passage). */
  index?: StateIndex;
}

interface StateIndex {
  fingerOf: Map<string, Finger>;
  byKey: Map<string, Placed>;
  byString: Map<number, Placed>;
  byFinger: Map<number, Placed>;
}

interface Event {
  time: number;
  fresh: FingerNote[];
  freshIds: Set<string>;
  held: FingerNote[];
  states: State[];
}

function indexOf(state: State): StateIndex {
  if (!state.index) {
    state.index = {
      fingerOf: new Map(state.placed.map((p) => [p.note.id, p.finger])),
      byKey: new Map(state.placed.map((p) => [key(p.note), p])),
      byString: new Map(state.placed.map((p) => [p.note.string, p])),
      byFinger: new Map(state.placed.map((p) => [p.finger, p])),
    };
  }
  return state.index;
}

const key = (n: FingerNote): string => `${n.string}:${n.fret}`;

/**
 * Degré de tolérance d'une affectation : 0 normal ; 1 large (accord impossible autrement : une
 * case de plus) ; 2 libre (dernier recours, sans limite d'écart).
 */
type Reach = 0 | 1 | 2;

/**
 * Écart permis entre deux doigts a < b (en cases) : un de plus que leur distance (deux en
 * position haute, où les cases sont serrées), une case de plus en mode large.
 */
const maxGap = (a: number, b: number, low: number, reach: Reach): number => b - a + (low >= 7 ? 2 : 1) + (reach >= 1 ? 1 : 0);
/** Écart total permis entre la case la plus basse et la plus haute : 4 cases (5 en position haute), une de plus en mode large. */
const maxSpan = (low: number, reach: Reach): number => (low >= 7 ? 5 : 4) + (reach >= 1 ? 1 : 0);

/** Positions de main possibles pour une affectation, avec leur coût propre ; vide si elle n'est pas jouable. */
function evaluate(placed: Placed[], strings: number, reach: Reach): Array<{ anchor: number; cost: number }> {
  const none: Array<{ anchor: number; cost: number }> = [];
  const fingers = placed.filter((p) => p.finger >= 1 && p.finger <= 4);
  const thumbs = placed.filter((p) => p.finger === THUMB);
  if (!fingers.length && !thumbs.length) return none;
  let cost = 0;

  // Un doigt sur plusieurs notes : barré (même case, cordes voisines ; les notes entre ses
  // extrémités sont jouées plus haut par d'autres doigts).
  const byFinger = new Map<number, Placed[]>();
  for (const p of fingers) byFinger.set(p.finger, [...(byFinger.get(p.finger) ?? []), p]);
  const fretOf = new Map<number, number>();
  for (const [finger, group] of byFinger) {
    const fret = (group[0] as Placed).note.fret;
    fretOf.set(finger, fret);
    if (group.length === 1) continue;
    if (finger !== 1 && finger !== 3) return none;
    if (group.some((p) => p.note.fret !== fret)) return none;
    const lo = Math.min(...group.map((p) => p.note.string));
    const hi = Math.max(...group.map((p) => p.note.string));
    if (placed.some((p) => p.finger !== finger && p.note.string > lo && p.note.string < hi && p.note.fret <= fret)) return none;
    cost += (finger === 1 ? W.barre : W.partialBarre) + W.barreNote * group.length;
  }

  const used = [...fretOf.keys()].sort((a, b) => a - b);
  const frets = fingers.map((p) => p.note.fret);
  const low = frets.length ? Math.min(...frets) : 0;
  if (reach < 2 && frets.length && Math.max(...frets) - low > maxSpan(low, reach)) return none;
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = used[i] as number;
      const b = used[j] as number;
      const diff = (fretOf.get(b) as number) - (fretOf.get(a) as number);
      if (diff < 0) return none;
      if (reach < 2 && diff > maxGap(a, b, low, reach)) return none;
    }
  }

  cost += W.pinky * fingers.filter((p) => p.finger === 4).length;
  if (!fretOf.has(1) && new Set(fingers.map((p) => p.note.fret)).size > 1) cost += W.noIndex;

  // Deux doigts sur la même case : le plus petit doigt sur la corde la plus grave, d'habitude.
  for (const p of fingers) {
    for (const q of fingers) {
      if (p.finger < q.finger && p.note.fret === q.note.fret) {
        if (p.note.string > q.note.string) cost += W.sameFretOrder;
        if (p.finger === 1) {
          const lo = Math.min(p.note.string, q.note.string);
          const hi = Math.max(p.note.string, q.note.string);
          for (let s = lo + 1; s < hi; s++) {
            if (!fingers.some((r) => r.note.string === s && r.note.fret === p.note.fret)) cost += W.sameFretSpread;
          }
        }
      }
    }
  }

  if (thumbs.length > 1) return none;
  cost += reach === 2 ? W.relaxed : reach === 1 ? W.wide : 0;

  // Position de la main (case de l'index) : celle de l'index s'il est posé ; sinon, chacune des
  // positions compatibles avec les autres doigts (la suite de la phrase choisira).
  const implied = fingers.map((p) => p.note.fret - (p.finger - 1));
  const anchors = fretOf.has(1)
    ? [fretOf.get(1) as number]
    : implied.length
      ? Array.from({ length: Math.max(...implied) - Math.min(...implied) + 1 }, (_, i) => Math.min(...implied) + i)
      : [(thumbs[0] as Placed).note.fret];
  const out: Array<{ anchor: number; cost: number }> = [];
  for (const raw of new Set(anchors.map((a) => Math.max(1, a)))) {
    let c = cost;
    // Écart de chaque doigt à sa case naturelle (index sur la case de la main, puis une case par doigt).
    for (const a of implied) c += a > raw ? W.stretch * (a - raw) + W.stretch2 * (a - raw) ** 2 : W.cramp * (raw - a);
    // Pouce : par-dessus le manche, sur l'une des deux cordes graves, près de la position.
    const t = thumbs[0];
    if (t) {
      if (t.note.string > Math.min(1, strings - 1)) return none;
      if (placed.some((p) => p !== t && p.note.string <= t.note.string)) return none;
      if (fingers.length && (t.note.fret < raw - 1 || t.note.fret > raw + 1)) continue;
      c += W.thumb;
    }
    out.push({ anchor: raw, cost: c });
  }
  return out;
}

/** Toutes les affectations jouables des notes (doigts possibles par note), triées par coût. */
function assignments(notes: FingerNote[], allowed: Finger[][], strings: number, reach: Reach): State[] {
  const out: State[] = [];
  const order = notes.map((_, i) => i).sort((a, b) => (notes[a] as FingerNote).fret - (notes[b] as FingerNote).fret || (notes[a] as FingerNote).string - (notes[b] as FingerNote).string);
  const chosen: Finger[] = notes.map(() => 0);
  const walk = (k: number): void => {
    if (k === order.length) {
      const placed = notes.map((note, i) => ({ note, finger: chosen[i] as Finger }));
      for (const r of evaluate(placed, strings, reach)) out.push({ placed, anchor: r.anchor, cost: r.cost });
      return;
    }
    const i = order[k] as number;
    for (const f of allowed[i] as Finger[]) {
      // Doigt déjà pris : seulement pour un barré (même case).
      const taken = order.slice(0, k).find((j) => chosen[j] === f);
      if (taken !== undefined && (f === THUMB || (notes[taken] as FingerNote).fret !== (notes[i] as FingerNote).fret)) continue;
      chosen[i] = f;
      walk(k + 1);
    }
    chosen[i] = 0;
  };
  walk(0);
  return out.sort((a, b) => a.cost - b.cost);
}

/** Coût de passage d'un état au suivant ; Infinity si une note tenue changerait de doigt. */
function transition(prev: State, next: State, event: Event, gap: number): number {
  const before = indexOf(prev);
  let cost = 0;
  for (const p of next.placed) {
    if (event.freshIds.has(p.note.id)) continue;
    // Note tenue : même doigt qu'avant.
    if (before.fingerOf.get(p.note.id) !== p.finger) return Infinity;
  }
  const slideShift = next.placed.some((p) => p.note.slide && event.freshIds.has(p.note.id));
  const shift = Math.abs(next.anchor - prev.anchor);
  if (shift) {
    const hurry = 1 + 1 / (1 + 4 * Math.max(0, gap));
    cost += (W.shiftBase + W.shiftPerFret * shift) * hurry * (slideShift ? 0.3 : 1);
  }
  for (const p of next.placed) {
    if (!event.freshIds.has(p.note.id)) continue;
    const same = before.byKey.get(key(p.note));
    if (same && same.finger !== p.finger) cost += W.repeatOtherFinger;
    const origin = before.byString.get(p.note.string);
    if (origin && p.note.legato && origin.finger === p.finger) cost += W.legatoSameFinger;
    if (origin && p.note.slide && origin.finger !== p.finger) cost += W.slideOtherFinger;
    // Le même doigt passe d'une note à une autre (hors glissé) : il faut le soulever et le déplacer.
    const last = before.byFinger.get(p.finger);
    if (last && !shift && key(last.note) !== key(p.note) && !(p.note.slide && last.note.string === p.note.string)) {
      cost +=
        last.note.fret === p.note.fret ? W.fingerRoll + W.fingerRollPerString * Math.abs(last.note.string - p.note.string) : W.fingerHop;
    }
  }
  return cost;
}

/** Doigts possibles pour une note (1 à 4, pouce sur les cordes graves), ou le doigt imposé. */
function fingersFor(note: FingerNote, options: FingeringOptions, strings: number): Finger[] {
  const forced = options.overrides?.get(note.id);
  if (forced !== undefined && forced >= 1 && forced <= 5) return [forced];
  return note.string <= Math.min(1, strings - 1) ? [1, 2, 3, 4, THUMB] : [1, 2, 3, 4];
}

/** États d'un événement : notes nouvelles, plus chaque sous-ensemble de notes tenues gardées. */
function eventStates(event: Event, options: FingeringOptions, strings: number): State[] {
  const held = event.held.slice(-MAX_HELD);
  const states: State[] = [];
  for (let mask = 0; mask < 1 << held.length; mask++) {
    const kept = held.filter((_, i) => mask & (1 << i));
    const released = held.filter((_, i) => !(mask & (1 << i)));
    const notes = [...event.fresh, ...kept];
    const allowed = notes.map((n) => fingersFor(n, options, strings));
    let found = assignments(notes, allowed, strings, 0);
    if (!found.length) found = assignments(notes, allowed, strings, 1);
    if (!found.length && !kept.length) found = assignments(notes, allowed, strings, 2);
    const releaseCost = released.reduce((sum, n) => sum + W.releaseBase + W.release * Math.min(1, (n.end - event.time) / 1), 0);
    for (const s of found) states.push({ ...s, cost: s.cost + releaseCost });
  }
  if (!states.length) states.push(fallback(event.fresh));
  states.sort((a, b) => a.cost - b.cost);
  return states.slice(0, MAX_STATES);
}

/** Accord injouable tel quel (trop de notes, doigts imposés contradictoires) : doigts dans l'ordre des cases. */
function fallback(notes: FingerNote[]): State {
  const sorted = [...notes].sort((a, b) => a.fret - b.fret || a.string - b.string);
  const placed = sorted.map((note, i) => ({ note, finger: Math.min(4, i + 1) as Finger }));
  return { placed, anchor: Math.max(1, (sorted[0] as FingerNote).fret), cost: W.relaxed * 2 };
}

/** Forme jouée à un événement : ses notes nouvelles (corde et case). */
const shapeKey = (e: Event): string =>
  e.fresh
    .map(key)
    .sort()
    .join(' ');

/** Doigts d'un état pour les notes nouvelles de l'événement, dans l'ordre de la forme. */
function shapeFingers(e: Event, s: State): string {
  const byKey = new Map(s.placed.filter((p) => e.freshIds.has(p.note.id)).map((p) => [key(p.note), p.finger]));
  return e.fresh
    .map(key)
    .sort()
    .map((k) => byKey.get(k) ?? 0)
    .join(',');
}

/**
 * Doigté le plus fréquent de chaque forme qui revient (au premier passage) : un même accord ou
 * motif répété dans la pièce se joue de préférence toujours de la même façon.
 */
function habits(events: Event[], path: number[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  events.forEach((e, k) => {
    const state = e.states[path[k] ?? -1];
    if (!state) return;
    const shape = shapeKey(e);
    const fingers = shapeFingers(e, state);
    const byFingers = counts.get(shape) ?? new Map<string, number>();
    byFingers.set(fingers, (byFingers.get(fingers) ?? 0) + 1);
    counts.set(shape, byFingers);
  });
  const out = new Map<string, string>();
  for (const [shape, byFingers] of counts) {
    const total = [...byFingers.values()].reduce((a, b) => a + b, 0);
    if (total < 2) continue;
    // Le plus fréquent ; à égalité, le premier rencontré (ordre d'insertion).
    let best = '';
    let most = 0;
    for (const [fingers, n] of byFingers) {
      if (n > most) {
        best = fingers;
        most = n;
      }
    }
    out.set(shape, best);
  }
  return out;
}

/** Chemin de coût minimal (indice de l'état choisi à chaque événement). */
function viterbi(events: Event[]): number[] {
  const cost: number[][] = [];
  const back: number[][] = [];
  events.forEach((e, k) => {
    if (k === 0) {
      cost.push(e.states.map((s) => s.cost));
      back.push(e.states.map(() => -1));
      return;
    }
    const prev = events[k - 1] as Event;
    const prevCost = cost[k - 1] as number[];
    const gap = e.time - prev.time;
    const row: number[] = [];
    const from: number[] = [];
    e.states.forEach((s) => {
      let best = Infinity;
      let arg = -1;
      prev.states.forEach((p, i) => {
        const c = (prevCost[i] as number) + transition(p, s, e, gap);
        if (c < best) {
          best = c;
          arg = i;
        }
      });
      row.push(best + s.cost);
      from.push(arg);
    });
    // Aucune suite possible (notes tenues incompatibles) : on repart du meilleur état précédent.
    if (row.every((c) => !Number.isFinite(c))) {
      const bestPrev = prevCost.indexOf(Math.min(...prevCost));
      e.states.forEach((s, j) => {
        row[j] = (prevCost[bestPrev] as number) + s.cost + W.relaxed;
        from[j] = bestPrev;
      });
    }
    cost.push(row);
    back.push(from);
  });
  const path: number[] = events.map(() => -1);
  let j = (cost[cost.length - 1] ?? []).reduce((bi, c, i, arr) => (c < (arr[bi] as number) ? i : bi), 0);
  for (let k = events.length - 1; k >= 0; k--) {
    path[k] = j;
    j = (back[k] as number[])[j] ?? -1;
    if (j < 0 && k > 0) j = 0;
  }
  return path;
}

/** Doigt de chaque note (0 pour une corde à vide), optimisé sur toute la séquence. */
export function fingerNotes(notes: readonly FingerNote[], options: FingeringOptions = {}): Map<string, Finger> {
  const strings = options.strings ?? 6;
  const result = new Map<string, Finger>();
  for (const n of notes) if (n.fret <= 0) result.set(n.id, 0);
  const fretted = notes.filter((n) => n.fret > 0).sort((a, b) => a.start - b.start || a.string - b.string);
  if (!fretted.length) return result;

  // Fin effective de chaque note : la note suivante sur la même corde l'arrête.
  const endOf = new Map<string, number>();
  const byString = new Map<number, FingerNote[]>();
  for (const n of notes) {
    const list = byString.get(n.string);
    if (list) list.push(n);
    else byString.set(n.string, [n]);
  }
  for (const list of byString.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0, next = 0; i < list.length; i++) {
      const n = list[i] as FingerNote;
      if (next <= i) next = i + 1;
      while (next < list.length && (list[next] as FingerNote).start <= n.start + EPS) next++;
      endOf.set(n.id, Math.min(n.end, next < list.length ? (list[next] as FingerNote).start : Infinity));
    }
  }

  const events: Event[] = [];
  for (const n of fretted) {
    const last = events[events.length - 1];
    if (last && Math.abs(last.time - n.start) < EPS) {
      last.fresh.push(n);
      last.freshIds.add(n.id);
    } else events.push({ time: n.start, fresh: [n], freshIds: new Set([n.id]), held: [], states: [] });
  }
  // Notes encore tenues à chaque événement : balayage dans l'ordre du temps.
  let active: FingerNote[] = [];
  let pointer = 0;
  for (const e of events) {
    while (pointer < fretted.length && (fretted[pointer] as FingerNote).start < e.time - EPS) active.push(fretted[pointer++] as FingerNote);
    active = active.filter((n) => (endOf.get(n.id) as number) > e.time + EPS);
    e.held = active.filter((n) => !e.fresh.some((f) => f.string === n.string));
    e.states = eventStates(e, options, strings);
  }

  // Premier passage, puis second avec une préférence pour le doigté habituel de chaque forme répétée.
  let path = viterbi(events);
  const habit = habits(events, path);
  if (habit.size) {
    for (const e of events) {
      const usual = habit.get(shapeKey(e));
      if (!usual) continue;
      for (const s of e.states) if (shapeFingers(e, s) !== usual) s.cost += W.inconsistent;
    }
    path = viterbi(events);
  }
  events.forEach((e, k) => {
    const state = e.states[path[k] ?? -1];
    if (state) for (const p of state.placed) if (!result.has(p.note.id) || e.freshIds.has(p.note.id)) result.set(p.note.id, p.finger);
  });
  // Notes sans état (événement sans affectation possible) : doigt selon la case.
  for (const n of fretted) if (!result.has(n.id)) result.set(n.id, Math.min(4, Math.max(1, n.fret)) as Finger);
  return result;
}
