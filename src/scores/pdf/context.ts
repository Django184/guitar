/**
 * Contexte de lecture d'une page : primitives classées, symboles, portées et systèmes,
 * et répartition des symboles entre les portées.
 */
import { classifyPaths, type Beam, type Curve, type HSeg, type VSeg } from './geometry';
import { buildSystems, findStaves, mergeHorizontal, staffBottom, staffTop, type Staff, type System } from './layout';
import { collectSymbols, type AccidentalSym, type ClefSym, type DigitSym, type HeadSym, type PageSymbols, type RestSym } from './symbols';
import type { PageData } from './types';

/** Trace de mise au point : éléments reconnus, en coordonnées de page. */
export interface TraceItem {
  page: number;
  kind: 'staff' | 'barline' | 'stem' | 'beam' | 'event' | 'note' | 'tie' | 'tuplet' | 'info';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  label?: string;
}

export const tracer: { fn: ((item: TraceItem) => void) | null } = { fn: null };

export function emit(item: TraceItem): void {
  tracer.fn?.(item);
}

export interface PageContext {
  page: PageData;
  symbols: PageSymbols;
  hsegs: HSeg[];
  vsegs: VSeg[];
  beams: Beam[];
  curves: Curve[];
  staves: Staff[];
  systems: System[];
}

export function readPage(page: PageData): PageContext {
  const geo = classifyPaths(page);
  const symbols = collectSymbols(page);
  // Trous des lignes de tablature : chiffres d'une police de texte.
  const holes = symbols.text.map((g) => ({ x0: g.x, x1: g.x + g.width, y0: g.y - 0.8 * g.size, y1: g.y + 0.1 * g.size }));
  const staves = findStaves(mergeHorizontal(geo.hsegs, holes), page.index);
  const braces = symbols.braces.map((b) => ({ x: b.x, y0: b.y - b.size * 1.05, y1: b.y + b.size * 0.05 }));
  const heads = symbols.heads.map((h) => ({ x0: h.x, x1: h.x1, y: h.y }));
  const systems = buildSystems(staves, geo.vsegs, braces, heads);
  return { page, symbols, hsegs: geo.hsegs, vsegs: geo.vsegs, beams: geo.beams, curves: geo.curves, staves, systems };
}

/** Portée la plus proche (verticalement) d'un point. */
export function nearestStaff(staves: Staff[], x: number, y: number, maxSpaces = 9): Staff | null {
  let best: Staff | null = null;
  let bestD = Infinity;
  for (const s of staves) {
    if (x < s.x0 - 3 * s.spacing || x > s.x1 + 2 * s.spacing) continue;
    const d = y < staffTop(s) ? staffTop(s) - y : y > staffBottom(s) ? y - staffBottom(s) : 0;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best && bestD <= maxSpaces * best.spacing ? best : null;
}

export interface StaffSyms {
  heads: HeadSym[];
  rests: RestSym[];
  accidentals: AccidentalSym[];
  clefs: ClefSym[];
  timeDigits: DigitSym[];
  timeCommons: Array<{ x: number; y: number; cut: boolean }>;
  dots: Array<{ x: number; x1: number; y: number }>;
  flags: Array<{ x: number; y: number; beams: number; up: boolean }>;
  repeatDots: Array<{ x: number; y: number }>;
  textDigits: DigitSym[];
}

/** Répartit les symboles de la page entre les portées d'un système. */
export function staffSymbols(ctx: PageContext, system: System): Map<Staff, StaffSyms> {
  const per = new Map<Staff, StaffSyms>(
    system.staves.map((s) => [
      s,
      { heads: [], rests: [], accidentals: [], clefs: [], timeDigits: [], timeCommons: [], dots: [], flags: [], repeatDots: [], textDigits: [] },
    ]),
  );
  const assign = <T extends { x: number; y: number }>(items: T[], pick: (s: StaffSyms) => T[], maxSpaces = 9): void => {
    for (const item of items) {
      const staff = nearestStaff(ctx.staves, item.x, item.y, maxSpaces);
      if (!staff) continue;
      const bucket = per.get(staff);
      if (bucket) pick(bucket).push(item);
    }
  };
  const { symbols } = ctx;
  assign(symbols.heads, (s) => s.heads);
  assign(symbols.rests, (s) => s.rests);
  assign(symbols.accidentals, (s) => s.accidentals);
  assign(symbols.clefs, (s) => s.clefs);
  assign(symbols.timeDigits, (s) => s.timeDigits);
  assign(symbols.timeCommons, (s) => s.timeCommons);
  assign(symbols.dots, (s) => s.dots);
  assign(symbols.flags, (s) => s.flags);
  assign(symbols.repeatDots, (s) => s.repeatDots);
  // Chiffres de tablature : centrés sur les lignes, donc dans la portée.
  assign(symbols.textDigits, (s) => s.textDigits, 1.5);
  return per;
}
