/**
 * Lecture d'une portée de notation dans un système : têtes, hampes, ligatures, crochets,
 * points, silences, altérations, clés, armures, chiffrages, liaisons de prolongation.
 */
import { emit, type PageContext, type StaffSyms } from './context';
import { beamTopAt, type Beam, type VSeg } from './geometry';
import { HEAD_QUARTERS, REST_QUARTERS } from './glyphs';
import { staffBottom, staffTop, type Staff, type System } from './layout';
import { diatonicIndex, fromDiatonic, typeFromQuarters, type Clef, type NoteType } from './model';
import { applyTuplets, newEvent, type Ev, type Stem } from './rhythm';
import type { AccidentalSym, ClefSym, DigitSym, HeadSym } from './symbols';

export interface StaffState {
  clef: Clef;
  key: number;
  /** Notes liées vers le système suivant (index diatonique → altération). */
  pendingTies: Map<number, number>;
}

export function newStaffState(): StaffState {
  return { clef: { sign: 'G', line: 2, octave: 0 }, key: 0, pendingTies: new Map() };
}

export interface MeasureRead {
  events: Ev[];
  clef?: Clef;
  key?: number;
  time?: { beats: number; beatType: number; symbol?: 'common' | 'cut' };
  repeatStart?: boolean;
  repeatEnd?: boolean;
}

export interface SystemFrame {
  system: System;
  /** Index de la mesure d'une abscisse (nombre de mesures = au-delà de la dernière barre). */
  measureOf: (x: number) => number;
  measureCount: number;
  stemCandidates: VSeg[];
  beams: Beam[];
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/** Position verticale en demi-interlignes au-dessus de la ligne du bas. */
export function staffStep(staff: Staff, y: number): number {
  return Math.round((staffBottom(staff) - y) / (staff.spacing / 2));
}

const CLEF_REF: Record<string, number> = { G: 4 * 7 + 4, F: 3 * 7 + 3, C: 4 * 7, percussion: 4 * 7 + 4, TAB: 4 * 7 + 4 };

function clefFromSymbol(sym: ClefSym, staff: Staff): Clef {
  if (sym.sign === 'percussion') return { sign: 'percussion', line: 3, octave: 0 };
  if (sym.sign === 'tab') return { sign: 'TAB', line: 5, octave: 0 };
  const line = Math.min(5, Math.max(1, Math.round(staffStep(staff, sym.y) / 2) + 1));
  return { sign: sym.sign, line, octave: sym.octave };
}

export function diatonicAt(clef: Clef, step: number): number {
  const ref = CLEF_REF[clef.sign] ?? (CLEF_REF.G as number);
  return ref + clef.octave * 7 + (step - (clef.line - 1) * 2);
}

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

export function keyAlter(fifths: number, step: string): number {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

export function readTime(syms: StaffSyms, staff: Staff, from: number, to: number): MeasureRead['time'] | undefined {
  const middle = (staffTop(staff) + staffBottom(staff)) / 2;
  const common = syms.timeCommons.find((t) => t.x >= from && t.x < to);
  if (common) return common.cut ? { beats: 2, beatType: 2, symbol: 'cut' } : { beats: 4, beatType: 4, symbol: 'common' };
  const digits = syms.timeDigits
    .filter((d) => d.x >= from && d.x < to && d.y > staffTop(staff) - 0.5 * staff.spacing && d.y < staffBottom(staff) + 0.5 * staff.spacing)
    .sort((a, b) => a.y - b.y);
  // Deux rangées de chiffres (numérateur au-dessus) : on coupe au plus grand écart vertical.
  // L'origine des chiffres varie selon la police (centre chez SMuFL, ligne de base chez LilyPond).
  let cut = -1;
  let gap = staff.spacing;
  for (let i = 1; i < digits.length; i++) {
    const d = (digits[i] as DigitSym).y - (digits[i - 1] as DigitSym).y;
    if (d >= gap) {
      gap = d;
      cut = i;
    }
  }
  void middle;
  const top = (cut > 0 ? digits.slice(0, cut) : []).sort((a, b) => a.x - b.x);
  const bottom = (cut > 0 ? digits.slice(cut) : []).sort((a, b) => a.x - b.x);
  if (!top.length || !bottom.length) return undefined;
  const beats = Number(top.map((d) => d.digit).join(''));
  const beatType = Number(bottom.map((d) => d.digit).join(''));
  if (!beats || beats > 32 || ![1, 2, 4, 8, 16, 32].includes(beatType)) return undefined;
  return { beats, beatType };
}

/** Nombre de points alignés à droite d'une note. */
function dotChain(row: Array<{ x: number; x1: number }>, start: number, sp: number): number {
  let count = 0;
  let edge = start;
  for (const d of row) {
    if (d.x - edge > (count === 0 ? 1.6 : 0.9) * sp) break;
    count++;
    edge = d.x1;
  }
  return count;
}

/** Hampes attachées aux têtes de la portée, avec leurs ligatures ou crochets. */
function findStems(staff: Staff, heads: HeadSym[], syms: StaffSyms, frame: SystemFrame): Stem[] {
  const sp = staff.spacing;
  const stems: Stem[] = [];
  for (const v of frame.stemCandidates) {
    if (v.y1 < staffTop(staff) - 9 * sp || v.y0 > staffBottom(staff) + 9 * sp) continue;
    const attached = heads.filter(
      (h) =>
        h.head !== 'whole' &&
        h.head !== 'breve' &&
        (Math.abs(v.x - h.x1) < 0.35 * sp || Math.abs(v.x - h.x) < 0.35 * sp) &&
        h.y >= v.y0 - 0.45 * sp &&
        h.y <= v.y1 + 0.45 * sp,
    );
    if (!attached.length) continue;
    const top = Math.min(...attached.map((h) => h.y));
    const bottom = Math.max(...attached.map((h) => h.y));
    let up: boolean | null = null;
    if (Math.abs(v.y1 - bottom) < 0.7 * sp && v.y0 < top - 0.8 * sp) up = true;
    else if (Math.abs(v.y0 - top) < 0.7 * sp && v.y1 > bottom + 0.8 * sp) up = false;
    if (up === null) continue;
    // Une tête « normale » est du côté attendu : à gauche d'une hampe montante, à droite d'une descendante.
    const normal = attached.filter((h) => (up ? Math.abs(v.x - h.x1) < 0.35 * sp : Math.abs(v.x - h.x) < 0.35 * sp));
    if (!normal.length) continue;
    stems.push({ ...v, up, heads: attached, beams: 0, beamRefs: [] });
  }
  countBeams(stems, frame.beams, syms, sp);
  return stems;
}

/** Nombre de ligatures (ou de crochets) au bout de chaque hampe. */
export function countBeams(stems: Stem[], beams: Beam[], syms: StaffSyms, sp: number): void {
  for (const stem of stems) {
    const tip = stem.up ? stem.y0 : stem.y1;
    const headEnd = stem.up ? stem.y1 : stem.y0;
    const crossing = beams.filter((b) => {
      if (stem.x < b.x0 - 0.6 || stem.x > b.x1 + 0.6) return false;
      const top = beamTopAt(b, Math.min(Math.max(stem.x, b.x0), b.x1));
      const bottom = top + b.thickness;
      if (bottom < stem.y0 - 0.5 || top > stem.y1 + 0.5) return false;
      const mid = (top + bottom) / 2;
      return Math.abs(mid - tip) < Math.abs(mid - headEnd);
    });
    // Ligatures distinctes (deux tracés superposés comptent une fois).
    const levels: number[] = [];
    for (const b of crossing) {
      const mid = beamTopAt(b, stem.x) + b.thickness / 2;
      if (!levels.some((l) => Math.abs(l - mid) < b.thickness * 0.6)) levels.push(mid);
    }
    stem.beams = levels.length;
    stem.beamRefs = crossing;
    if (stem.beams === 0) {
      const flag = syms.flags.find((f) => Math.abs(f.x - stem.x) < 0.7 * sp && f.y >= stem.y0 - 1.2 * sp && f.y <= stem.y1 + 1.2 * sp);
      if (flag) stem.beams = flag.beams;
    }
  }
}

export function readNotationStaff(
  ctx: PageContext,
  frame: SystemFrame,
  staff: Staff,
  syms: StaffSyms,
  st: StaffState,
): MeasureRead[] {
  const { system } = frame;
  const sp = staff.spacing;
  const page = ctx.page.index;

  // Têtes de taille normale (les petites sont des appoggiatures ou des notes de repère).
  // Une tête partagée par deux voix est souvent dessinée deux fois au même endroit : on n'en garde qu'une.
  const normalSize = median(syms.heads.map((h) => h.size));
  const heads: HeadSym[] = [];
  for (const h of syms.heads.filter((g) => g.size >= normalSize * 0.82).sort((a, b) => a.x - b.x)) {
    if (heads.some((o) => o.head === h.head && Math.abs(o.x - h.x) < 0.1 * sp && Math.abs(o.y - h.y) < 0.1 * sp)) continue;
    heads.push(h);
  }
  const headWidth = median(heads.filter((h) => h.head === 'black').map((h) => h.x1 - h.x)) || 1.18 * sp;
  const restSize = median(syms.rests.map((r) => r.size));
  const rests = syms.rests.filter((r) => r.size >= restSize * 0.82);

  const stems = findStems(staff, heads, syms, frame);
  for (const stem of stems) emit({ page, kind: 'stem', x0: stem.x, y0: stem.y0, x1: stem.x, y1: stem.y1, label: `${stem.up ? 'u' : 'd'}${stem.beams}` });

  // Accords : têtes partageant une hampe ; les têtes sans hampe sont regroupées par colonne.
  const events: Ev[] = [];
  const used = new Set<HeadSym>();
  for (const stem of stems) {
    const hs = [...stem.heads].sort((a, b) => a.y - b.y);
    hs.forEach((h) => used.add(h));
    const normalHeads = hs.filter((h) => (stem.up ? Math.abs(stem.x - h.x1) < 0.35 * sp : Math.abs(stem.x - h.x) < 0.35 * sp));
    const half = hs.some((h) => h.head === 'half');
    const type: NoteType = half ? 'half' : (typeFromQuarters(1 / 2 ** stem.beams) ?? '128th');
    const e = newEvent('chord', normalHeads.length ? Math.min(...normalHeads.map((h) => h.x)) : stem.x, Math.max(...hs.map((h) => h.x1)), (hs[0] as HeadSym).y, type);
    e.heads = hs;
    e.stem = stem;
    e.stemDir = stem.up ? 'up' : 'down';
    events.push(e);
  }
  for (const h of heads.filter((g) => !used.has(g))) {
    const same = events.find((e) => !e.stem && e.kind === 'chord' && Math.abs(e.x - h.x) < 0.5 * headWidth);
    const second = events.find(
      (e) => !e.stem && e.kind === 'chord' && Math.abs(Math.abs(e.x - h.x) - headWidth) < 0.4 * headWidth && e.heads.some((o) => Math.abs(o.y - h.y) < 0.6 * sp),
    );
    const target = same ?? second;
    if (target) {
      target.heads.push(h);
      target.x = Math.min(target.x, h.x);
      target.y = Math.min(target.y, h.y);
      continue;
    }
    const e = newEvent('chord', h.x, h.x1, h.y, typeFromQuarters(h.head === 'black' ? 1 : HEAD_QUARTERS[h.head]) ?? 'whole');
    e.heads = [h];
    events.push(e);
  }
  for (const r of rests) {
    const e = newEvent('rest', r.x, r.x1, r.y, typeFromQuarters(REST_QUARTERS[r.value]) ?? 'quarter');
    e.rest = r;
    events.push(e);
  }

  // Points d'augmentation.
  const dots = [...syms.dots].sort((a, b) => a.x - b.x);
  for (const e of events) {
    const right = e.x1;
    let count = 0;
    if (e.kind === 'chord') {
      for (const h of e.heads) {
        const row = dots.filter((d) => d.x > right - 0.1 * sp && d.x < right + 2.6 * sp && Math.abs(d.y - h.y) <= 0.75 * sp);
        count = Math.max(count, dotChain(row, right, sp));
      }
    } else {
      const row = dots.filter((d) => d.x > right - 0.1 * sp && d.x < right + 2 * sp && Math.abs(d.y - e.y) <= 1.6 * sp);
      count = dotChain(row, right, sp);
    }
    e.dots = Math.min(count, 3);
  }

  applyTuplets(ctx, staff, events, stems);

  // Répartition par mesure.
  const out: MeasureRead[] = Array.from({ length: frame.measureCount }, () => ({ events: [] }));
  for (const e of events) {
    const m = frame.measureOf(e.x + 0.1);
    if (m < out.length) (out[m] as MeasureRead).events.push(e);
  }

  // Altérations accidentelles : la plus proche à gauche de la tête, à la même hauteur.
  const clefs = [...syms.clefs].sort((a, b) => a.x - b.x);
  const accidentals = [...syms.accidentals].sort((a, b) => a.x - b.x);
  const attachedAcc = new Map<HeadSym, AccidentalSym>();
  const usedAcc = new Set<AccidentalSym>();
  for (const h of heads) {
    let best: AccidentalSym | null = null;
    for (const a of accidentals) {
      if (usedAcc.has(a) || Math.abs(a.y - h.y) > 0.3 * sp) continue;
      if (a.x1 > h.x + 0.3 * sp || h.x - a.x > 4.5 * sp) continue;
      if (!best || a.x > best.x) best = a;
    }
    if (best) {
      attachedAcc.set(h, best);
      usedAcc.add(best);
    }
  }

  let clef = st.clef;
  let clefIdx = 0;
  const startTies = new Map(st.pendingTies);
  st.pendingTies = new Map();

  out.forEach((mr, m) => {
    const list = mr.events.sort((a, b) => a.x - b.x);
    const left = m === 0 ? system.start : (system.barlines[m - 1] as { right: number }).right;
    const right = (system.barlines[m] as { left: number } | undefined)?.left ?? system.x1;
    const firstX = list.length ? (list[0] as Ev).x : right;

    // Clé, armure et chiffrage en tête de mesure.
    while (clefIdx < clefs.length && (clefs[clefIdx] as ClefSym).x < firstX) {
      const c = clefs[clefIdx] as ClefSym;
      clef = clefFromSymbol(c, staff);
      clefIdx++;
      if (c.x >= left - 0.5) mr.clef = clef;
    }
    const keyAcc = accidentals.filter((a) => !usedAcc.has(a) && a.x >= left - 0.5 && a.x1 <= firstX + 0.1 * sp);
    if (keyAcc.length) {
      const sharps = keyAcc.filter((a) => a.alter === 1).length;
      const flats = keyAcc.filter((a) => a.alter === -1).length;
      const fifths = sharps > 0 && flats === 0 ? sharps : flats > 0 && sharps === 0 ? -flats : sharps === 0 && flats === 0 ? 0 : st.key;
      if (fifths !== st.key || m === 0) {
        st.key = fifths;
        mr.key = fifths;
      }
    }
    const time = readTime(syms, staff, left - 0.5, firstX);
    if (time) mr.time = time;

    // Hauteurs.
    const memory = new Map<number, number>();
    for (const e of list) {
      while (clefIdx < clefs.length && (clefs[clefIdx] as ClefSym).x < e.x) clef = clefFromSymbol(clefs[clefIdx++] as ClefSym, staff);
      if (e.kind !== 'chord') continue;
      for (const h of e.heads) {
        const dia = diatonicAt(clef, staffStep(staff, h.y));
        const { step, octave } = fromDiatonic(dia);
        const acc = attachedAcc.get(h);
        let alter: number;
        if (acc) {
          alter = acc.alter;
          memory.set(dia, alter);
        } else if (memory.has(dia)) alter = memory.get(dia) as number;
        else if (m === 0 && startTies.has(dia) && e === list[0]) alter = startTies.get(dia) as number;
        else alter = keyAlter(st.key, step);
        e.notes.push({ pitch: { step, alter, octave } });
      }
    }
  });
  // Clés restant après la dernière mesure (changement en fin de ligne) : effet au système suivant.
  while (clefIdx < clefs.length) clef = clefFromSymbol(clefs[clefIdx++] as ClefSym, staff);
  st.clef = clef;

  applyTies(ctx, system, staff, events, st);
  applyRepeats(syms, frame, staff, out);
  return out;
}

function applyTies(ctx: PageContext, system: System, staff: Staff, events: Ev[], st: StaffState): void {
  const sp = staff.spacing;
  const heads: Array<{ h: HeadSym; e: Ev; i: number }> = [];
  for (const e of events) e.heads.forEach((h, i) => e.notes[i] && heads.push({ h, e, i }));
  for (const curve of ctx.curves) {
    if (curve.box.y1 < staffTop(staff) - 8 * sp || curve.box.y0 > staffBottom(staff) + 8 * sp) continue;
    if (curve.box.x1 < system.x0 || curve.box.x0 > system.x1) continue;
    const width = curve.right.x - curve.left.x;
    if (width < 0.8 * sp) continue;
    if (Math.abs(curve.left.y - curve.right.y) > 0.6 * sp) continue;
    if (curve.box.y1 - curve.box.y0 > Math.max(1.6 * sp, width * 0.35)) continue;
    const y = (curve.left.y + curve.right.y) / 2;
    const from = heads
      .filter((c) => Math.abs(c.h.y - y) < 1.0 * sp && curve.left.x >= c.h.x - 0.2 * sp && curve.left.x - c.h.x1 < 1.2 * sp)
      .sort((a, b) => Math.abs(a.h.y - y) - Math.abs(b.h.y - y))[0];
    const to = heads
      .filter((c) => Math.abs(c.h.y - y) < 1.0 * sp && curve.right.x <= c.h.x1 + 0.2 * sp && c.h.x - curve.right.x < 1.2 * sp)
      .sort((a, b) => Math.abs(a.h.y - y) - Math.abs(b.h.y - y))[0];
    const noteOf = (c: { e: Ev; i: number }) => c.e.notes[c.i] as Ev['notes'][number];
    if (from && to && from.e !== to.e && Math.abs(from.h.y - to.h.y) < 0.3 * sp) {
      noteOf(from).tieStart = true;
      noteOf(to).tieStop = true;
      noteOf(to).pitch = { ...noteOf(to).pitch, alter: noteOf(from).pitch.alter };
      emit({ page: ctx.page.index, kind: 'tie', x0: curve.left.x, y0: curve.left.y, x1: curve.right.x, y1: curve.right.y });
    } else if (from && !to && curve.right.x > system.x1 - 2.5 * sp) {
      noteOf(from).tieStart = true;
      st.pendingTies.set(diatonicIndex(noteOf(from).pitch), noteOf(from).pitch.alter);
    } else if (to && !from && curve.left.x < system.start + 6 * sp) {
      noteOf(to).tieStop = true;
    }
  }
}

function applyRepeats(syms: StaffSyms, frame: SystemFrame, staff: Staff, out: MeasureRead[]): void {
  const sp = staff.spacing;
  const { system } = frame;
  for (const d of syms.repeatDots) {
    const m = frame.measureOf(d.x);
    const bar = system.barlines[m];
    const prev = system.barlines[m - 1];
    if (bar && Math.abs(bar.left - d.x) < 1.5 * sp) {
      const mr = out[m];
      if (mr) mr.repeatEnd = true;
    } else if (prev && d.x - prev.right < 1.5 * sp) {
      const mr = out[m];
      if (mr) mr.repeatStart = true;
    } else if (m === 0 && d.x - system.start < 1.5 * sp) {
      const mr = out[0];
      if (mr) mr.repeatStart = true;
    }
  }
}
