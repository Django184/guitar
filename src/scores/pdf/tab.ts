/**
 * Lecture d'une tablature : cases (chiffres posés sur les lignes), colonnes, rythme
 * (hampes sous la portée, ligatures, crochets, points) et accordage.
 */
import { emit, type PageContext, type StaffSyms } from './context';
import type { Beam } from './geometry';
import { REST_QUARTERS } from './glyphs';
import { staffBottom, staffTop, type Staff } from './layout';
import { pitchToMidi, typeFromQuarters, type NoteType, type Pitch } from './model';
import { countBeams, median, readTime, type MeasureRead, type SystemFrame } from './notation';
import { applyTuplets, newEvent, type Ev, type Stem } from './rhythm';
import type { Glyph } from './types';

/** Accordages par défaut (MIDI), corde 1 (aiguë) en premier. */
export const DEFAULT_TUNINGS: Record<number, number[]> = {
  4: [43, 38, 33, 28],
  5: [43, 38, 33, 28, 23],
  6: [64, 59, 55, 50, 45, 40],
  7: [64, 59, 55, 50, 45, 40, 35],
  8: [64, 59, 55, 50, 45, 40, 35, 30],
};

interface FretNumber {
  x: number;
  x1: number;
  cx: number;
  line: number;
  fret: number;
  size: number;
}

/** Cases d'une tablature : chiffres d'une police de texte centrés sur une ligne. */
function fretNumbers(staff: Staff, syms: StaffSyms): FretNumber[] {
  const sp = staff.spacing;
  const size = median(syms.textDigits.map((d) => d.size));
  const digits = syms.textDigits
    .filter((d) => d.size >= size * 0.8)
    .map((d) => {
      const center = d.y - 0.36 * d.size;
      let line = -1;
      let best = 0.42 * sp;
      staff.lines.forEach((ly, i) => {
        if (Math.abs(ly - center) < best) {
          best = Math.abs(ly - center);
          line = i;
        }
      });
      return { d, line };
    })
    .filter((e) => e.line >= 0)
    .sort((a, b) => a.line - b.line || a.d.x - b.d.x);
  const out: FretNumber[] = [];
  for (const { d, line } of digits) {
    const last = out[out.length - 1];
    if (last && last.line === line && d.x - last.x1 < 0.15 * d.size && last.fret < 10) {
      last.fret = last.fret * 10 + d.digit;
      last.x1 = d.x1;
      last.cx = (last.x + last.x1) / 2;
    } else out.push({ x: d.x, x1: d.x1, cx: (d.x + d.x1) / 2, line, fret: d.digit, size: d.size });
  }
  return out;
}

export interface TabRead {
  measures: MeasureRead[];
  /** Le rythme est écrit (hampes) ; sinon les durées sont à déduire de l'espacement. */
  rhythm: boolean;
}

/** Hampes de tablature : traits verticaux sous les chiffres, éventuellement interrompus par eux. */
function tabStems(ctx: PageContext, staff: Staff, columns: Array<{ cx: number; topY: number; bottomY: number }>, frame: SystemFrame): Array<Stem | null> {
  const sp = staff.spacing;
  const bottom = staffBottom(staff);
  const pieces = ctx.vsegs.filter(
    (v) => v.thickness <= 0.3 * sp + 0.25 && v.x > frame.system.x0 && v.x < frame.system.x1 && v.y1 > staffTop(staff) - sp && v.y0 < bottom + 8 * sp,
  );
  return columns.map((c) => {
    const near = pieces.filter((v) => Math.abs(v.x - c.cx) < 0.6 * sp && v.y0 >= c.topY - 0.6 * sp && v.y1 - v.y0 > 0.4 * sp);
    if (!near.length) return null;
    // Le trait le plus long et le plus proche du centre, puis ses morceaux colinéaires
    // (la hampe s'interrompt autour des chiffres ; un crochet de n-olet voisin n'en fait pas partie).
    const main = near.reduce((best, v) => (v.y1 - v.y0 - Math.abs(v.x - c.cx) * 4 > best.y1 - best.y0 - Math.abs(best.x - c.cx) * 4 ? v : best));
    const mine = near.filter((v) => Math.abs(v.x - main.x) < 0.3);
    const y0 = Math.min(...mine.map((v) => v.y0));
    const y1 = Math.max(...mine.map((v) => v.y1));
    if (y1 < bottom + 0.3 * sp) return null;
    return { x: main.x, y0, y1, thickness: main.thickness, up: false, heads: [], beams: 0, beamRefs: [] as Beam[] };
  });
}

export function readTabStaff(ctx: PageContext, frame: SystemFrame, staff: Staff, syms: StaffSyms): TabRead {
  const sp = staff.spacing;
  const page = ctx.page.index;
  const numbers = fretNumbers(staff, syms).sort((a, b) => a.cx - b.cx);

  // Colonnes : chiffres alignés verticalement.
  const columns: Array<{ cx: number; x0: number; x1: number; nums: FretNumber[]; topY: number; bottomY: number }> = [];
  for (const n of numbers) {
    const col = columns.find((c) => Math.abs(c.cx - n.cx) < 0.45 * sp && !c.nums.some((o) => o.line === n.line));
    if (col) {
      col.nums.push(n);
      col.x0 = Math.min(col.x0, n.x);
      col.x1 = Math.max(col.x1, n.x1);
      col.topY = Math.min(col.topY, staff.lines[n.line] as number);
      col.bottomY = Math.max(col.bottomY, staff.lines[n.line] as number);
    } else {
      const y = staff.lines[n.line] as number;
      columns.push({ cx: n.cx, x0: n.x, x1: n.x1, nums: [n], topY: y, bottomY: y });
    }
  }

  const stems = tabStems(ctx, staff, columns, frame);
  const rhythm = columns.length > 0 && stems.filter(Boolean).length >= 0.5 * columns.length;
  const realStems = stems.filter((s): s is Stem => !!s);
  if (rhythm) countBeams(realStems, frame.beams, syms, sp);
  const tipMedian = median(realStems.map((s) => s.y1));

  const events: Ev[] = columns.map((c, i) => {
    const e = newEvent('chord', c.cx, c.x1, c.topY, 'quarter');
    e.notes = [...c.nums]
      .sort((a, b) => a.line - b.line)
      .map((n) => ({ pitch: { step: 'C', alter: 0, octave: 4 } as Pitch, string: n.line + 1, fret: n.fret }));
    const stem = stems[i];
    if (!rhythm) {
      e.unknown = true;
      return e;
    }
    if (!stem) {
      e.type = 'whole';
      return e;
    }
    e.stem = stem;
    emit({ page, kind: 'stem', x0: stem.x, y0: stem.y0, x1: stem.x, y1: stem.y1, label: `t${stem.beams}` });
    // Blanche : hampe raccourcie.
    if (stem.beams === 0 && stem.y1 < tipMedian - 0.9 * sp) e.type = 'half';
    else e.type = typeFromQuarters(1 / 2 ** stem.beams) ?? '128th';
    // Point : à droite du bout de la hampe.
    const dots = syms.dots.filter((d) => d.x > stem.x && d.x < stem.x + 1.6 * sp && Math.abs(d.y - stem.y1) < 1.2 * sp);
    e.dots = Math.min(dots.length, 2);
    return e;
  });

  // Silences écrits dans la tablature.
  for (const r of syms.rests) {
    const e = newEvent('rest', r.x, r.x1, r.y, (typeFromQuarters(REST_QUARTERS[r.value]) ?? 'quarter') as NoteType);
    e.rest = r;
    const dots = syms.dots.filter((d) => d.x > r.x1 - 0.1 * sp && d.x < r.x1 + 1.5 * sp && Math.abs(d.y - r.y) < 1.6 * sp);
    e.dots = Math.min(dots.length, 2);
    if (!rhythm) e.unknown = true;
    events.push(e);
  }

  if (rhythm) applyTuplets(ctx, staff, events, realStems);

  const out: MeasureRead[] = Array.from({ length: frame.measureCount }, () => ({ events: [] }));
  for (const e of events) {
    const m = frame.measureOf(e.x - 0.3 * sp);
    if (m < out.length) (out[m] as MeasureRead).events.push(e);
  }
  out.forEach((mr, m) => {
    mr.events.sort((a, b) => a.x - b.x);
    const left = m === 0 ? frame.system.start : (frame.system.barlines[m - 1] as { right: number }).right;
    const firstX = mr.events.length ? (mr.events[0] as Ev).x - 0.5 * sp : ((frame.system.barlines[m] as { left: number } | undefined)?.left ?? frame.system.x1);
    const time = readTime(syms, staff, left - 0.5, firstX);
    if (time) mr.time = time;
  });
  return { measures: out, rhythm };
}

/* ------------------------------------------------------------------ */
/* Accordage                                                           */
/* ------------------------------------------------------------------ */

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pcOf(name: string): number | null {
  const m = /^([A-Ga-g])\s*([#♯b♭]?)/.exec(name);
  if (!m) return null;
  let pc = NOTE_PC[(m[1] as string).toUpperCase()] as number;
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  return (pc + 12) % 12;
}

/** Hauteur la plus proche de la corde par défaut, pour une classe de hauteur donnée. */
function nearest(pc: number, reference: number): number {
  let best = reference;
  let bestD = Infinity;
  for (let midi = reference - 9; midi <= reference + 6; midi++) {
    if ((midi % 12 + 12) % 12 !== pc) continue;
    const d = Math.abs(midi - reference) + (midi > reference ? 0.5 : 0);
    if (d < bestD) {
      bestD = d;
      best = midi;
    }
  }
  return best;
}

export interface TextLine {
  text: string;
  x: number;
  x1: number;
  y: number;
  size: number;
  page: number;
}

/** Lignes de texte d'une page (glyphes d'une police de texte, regroupés par ligne de base). */
export function textLines(glyphs: Glyph[], page: number): TextLine[] {
  const rows: Glyph[][] = [];
  for (const g of [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs((r[0] as Glyph).y - g.y) < 0.25 * g.size && Math.abs((r[0] as Glyph).size - g.size) < 0.6);
    if (row) row.push(g);
    else rows.push([g]);
  }
  const out: TextLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    // Coupe la ligne aux grands blancs (blocs de texte distincts).
    let current: Glyph[] = [];
    const flush = (): void => {
      if (!current.length) return;
      let text = '';
      let prev: Glyph | null = null;
      for (const g of current) {
        if (prev && g.x - (prev.x + prev.width) > 0.15 * g.size) text += ' ';
        text += g.text;
        prev = g;
      }
      const first = current[0] as Glyph;
      const last = current[current.length - 1] as Glyph;
      out.push({ text: text.trim(), x: first.x, x1: last.x + last.width, y: first.y, size: first.size, page });
      current = [];
    };
    for (const g of row) {
      const last = current[current.length - 1];
      if (last && g.x - (last.x + last.width) > 3 * g.size) flush();
      current.push(g);
    }
    flush();
  }
  return out;
}

const CIRCLED = '①②③④⑤⑥⑦⑧';

/** Accordage écrit en toutes lettres (« Tuning: D A D G B E », « ⑥ = D », « Drop D »…). */
export function tuningFromText(lines: TextLine[], strings: number): { tuning: number[]; capo: number } | null {
  const base = DEFAULT_TUNINGS[strings];
  if (!base) return null;
  const all = lines.map((l) => l.text).join('\n');
  let capo = 0;
  const capoMatch = /capo\.?\s*(?:on\s*|sur\s*|à la\s*|at\s*)?(\d{1,2}|[IVX]{1,4})/i.exec(all);
  if (capoMatch) {
    const v = capoMatch[1] as string;
    capo = /^\d+$/.test(v) ? Number(v) : romanToInt(v);
    if (capo < 0 || capo > 12) capo = 0;
  }
  const tuning = [...base];
  let found = false;
  // « ⑥ = D », « 6 = D », « (6) = D ».
  for (const m of all.matchAll(new RegExp(`(?:([${CIRCLED}])|\\(?([1-8])\\)?)\\s*=\\s*([A-G][#♯b♭]?)`, 'g'))) {
    const n = m[1] ? CIRCLED.indexOf(m[1]) + 1 : Number(m[2]);
    const pc = pcOf(m[3] as string);
    if (n >= 1 && n <= strings && pc !== null) {
      tuning[n - 1] = nearest(pc, base[n - 1] as number);
      found = true;
    }
  }
  if (!found) {
    // Suite de notes de la plus grave à la plus aiguë (« Tuning: D-A-D-G-B-E », « Accordage DADGAD »).
    const key = /(?:tuning|accordage|stimmung|afinaci[oó]n|accordatura)\s*:?/i.exec(all);
    if (key) {
      const rest = (all.slice(key.index + key[0].length).split(/,\s|;|\n|\(|capo/i)[0] ?? '').trim();
      const notes = /^[A-G][#♯b♭]?(?:[\s\-–/]*[A-G][#♯b♭]?)*$/.test(rest) ? (rest.match(/[A-G][#♯b♭]?/g) ?? []) : [];
      if (notes.length === strings) {
        notes.forEach((name, i) => {
          const s = strings - 1 - i;
          const pc = pcOf(name);
          if (pc !== null) tuning[s] = nearest(pc, base[s] as number);
        });
        found = true;
      }
    }
  }
  if (!found && strings === 6) {
    const named: Record<string, string[]> = {
      'drop d': ['D', 'A', 'D', 'G', 'B', 'E'],
      'drop c': ['C', 'G', 'C', 'F', 'A', 'D'],
      dadgad: ['D', 'A', 'D', 'G', 'A', 'D'],
      'open g': ['D', 'G', 'D', 'G', 'B', 'D'],
      'open d': ['D', 'A', 'D', 'F#', 'A', 'D'],
      'open e': ['E', 'B', 'E', 'G#', 'B', 'E'],
      'open c': ['C', 'G', 'C', 'G', 'C', 'E'],
    };
    const lower = all.toLowerCase();
    for (const [name, notes] of Object.entries(named)) {
      if (!lower.includes(name)) continue;
      notes.forEach((n, i) => {
        const s = 5 - i;
        tuning[s] = nearest(pcOf(n) as number, base[s] as number);
      });
      found = true;
      break;
    }
    if (!found) {
      const shift = tuneDown(lines.map((l) => l.text));
      if (shift) {
        tuning.forEach((m, i) => (tuning[i] = m - shift));
        found = true;
      }
    }
  }
  return found || capo ? { tuning, capo } : null;
}

/** « Tune down 1/2 step », « Tuned down a whole step », « Eb tuning », « un demi-ton plus bas »… */
function tuneDown(lines: string[]): number {
  for (const line of lines) {
    if (!/tun|accord|stimm/i.test(line) && !/(?:^|\s)(e♭|eb|mi♭|mib)\b/i.test(line)) continue;
    if (/\b(e♭|eb|e flat|mi♭|mib)\b/i.test(line) && /tun|accord|standard/i.test(line)) return 1;
    if (!/down|lower|plus bas|en dessous|tiefer/i.test(line)) continue;
    if (/1\/2|½|half|demi|halb/i.test(line)) return 1;
    const steps = /(\d+(?:[.,]5)?)\s*(?:whole\s*)?(?:steps?|tones?|tons?|ganzt)/i.exec(line);
    if (steps) return Math.round(Number((steps[1] as string).replace(',', '.')) * 2);
    if (/whole|one step|un ton|1 ton/i.test(line)) return 2;
  }
  return 0;
}

function romanToInt(s: string): number {
  const v: Record<string, number> = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = v[s[i] as string] ?? 0;
    const next = v[s[i + 1] as string] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/** Accordage déduit de notes lues à la fois sur la portée et sur la tablature. */
export function tuningFromPairs(pairs: Array<{ string: number; fret: number; midi: number }>, strings: number): number[] | null {
  const base = DEFAULT_TUNINGS[strings];
  if (!base || pairs.length < 4) return null;
  const tuning = [...base];
  let known = 0;
  for (let s = 1; s <= strings; s++) {
    const votes = new Map<number, number>();
    for (const p of pairs) if (p.string === s) votes.set(p.midi - p.fret, (votes.get(p.midi - p.fret) ?? 0) + 1);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      tuning[s - 1] = best[0];
      known++;
    }
  }
  // Cordes jamais jouées : décalées comme leurs voisines.
  if (known > 0 && known < strings) {
    const shifts = tuning.map((m, i) => m - (base[i] as number));
    const shift = median(shifts.filter((_, i) => pairs.some((p) => p.string === i + 1)));
    tuning.forEach((_, i) => {
      if (!pairs.some((p) => p.string === i + 1)) tuning[i] = (base[i] as number) + shift;
    });
  }
  return known ? tuning : null;
}

export function midiToPitch(midi: number, preferFlats: boolean): Pitch {
  const names = preferFlats
    ? (['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'] as const)
    : (['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const);
  const alters = preferFlats ? [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0] : [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const pc = ((midi % 12) + 12) % 12;
  return { step: names[pc] as Pitch['step'], alter: alters[pc] as number, octave: Math.floor(midi / 12) - 1 };
}

export { pitchToMidi };
