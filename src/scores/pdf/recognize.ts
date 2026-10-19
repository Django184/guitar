/**
 * Reconnaissance d'une partition vectorielle : des primitives de chaque page
 * (glyphes, traits) à une partition structurée (parties, mesures, voix).
 */
import { emit, readPage, staffSymbols, tracer, type PageContext, type StaffSyms, type TraceItem } from './context';
import { staffBottom, staffTop, type Staff, type System } from './layout';
import { pitchToMidi, type Clef, type RecEvent, type RecMeasure, type RecPart, type RecScore } from './model';
import { median, newStaffState, readNotationStaff, type MeasureRead, type StaffState, type SystemFrame } from './notation';
import { EPS, assignVoices, finalizeDurations, inferDurations, measureLength, repairStemDurations, type Ev } from './rhythm';
import { DEFAULT_TUNINGS, midiToPitch, readTabStaff, textLines, tuningFromPairs, tuningFromText, type TabRead, type TextLine } from './tab';
import type { PageData } from './types';

export type { TraceItem } from './context';

export interface RecognizeStats {
  pages: number;
  staves: number;
  systems: number;
  measures: number;
  notes: number;
  /** Mesures (par portée) dont la durée ne correspond pas au chiffrage. */
  irregular: number;
}

export interface RecognizeResult {
  score: RecScore;
  stats: RecognizeStats;
}

export interface RecognizeOptions {
  trace?: (item: TraceItem) => void;
}

/* ------------------------------------------------------------------ */
/* Systèmes et correspondance des portées                              */
/* ------------------------------------------------------------------ */

interface StaffInfo {
  kind: Staff['kind'];
  spacing: number;
  clef: string;
  braced: boolean;
}

interface Frame extends SystemFrame {
  ctx: PageContext;
  syms: Map<Staff, StaffSyms>;
  infos: StaffInfo[];
  /** Portée du modèle (système le plus complet) correspondant à chaque portée. */
  slots: number[];
  notation: Map<number, MeasureRead[]>;
  tabs: Map<number, TabRead>;
}

function makeFrame(ctx: PageContext, system: System): Frame {
  const sp0 = (system.staves[0] as Staff).spacing;
  const barXs = system.barlines.map((b) => b.x);
  const syms = staffSymbols(ctx, system);
  const braces = ctx.symbols.braces.filter((b) => b.x < system.x0 + 2 && b.x > system.x0 - 50);
  const infos: StaffInfo[] = system.staves.map((s, i) => {
    const clef = (syms.get(s)?.clefs ?? []).filter((c) => c.x < s.x0 + 10 * s.spacing).sort((a, b) => a.x - b.x)[0];
    const next = system.staves[i + 1];
    const prev = system.staves[i - 1];
    const spans = (a: Staff, b: Staff): boolean =>
      braces.some((br) => br.y - br.size * 1.05 <= staffTop(a) + a.spacing && br.y >= staffBottom(b) - b.spacing);
    return {
      kind: s.kind,
      spacing: s.spacing,
      clef: clef ? clef.sign : s.kind === 'tab' ? 'tab' : '?',
      braced: (!!next && spans(s, next)) || (!!prev && spans(prev, s)),
    };
  });
  return {
    ctx,
    system,
    syms,
    infos,
    slots: [],
    notation: new Map(),
    tabs: new Map(),
    measureCount: Math.max(1, system.barlines.length),
    measureOf: (x: number): number => {
      for (let i = 0; i < system.barlines.length; i++) if (x < (system.barlines[i] as { left: number }).left - 0.2) return i;
      return system.barlines.length;
    },
    stemCandidates: ctx.vsegs.filter(
      (v) =>
        v.x > system.x0 - 0.5 &&
        v.x < system.x1 + 0.5 &&
        v.thickness <= 0.3 * sp0 + 0.25 &&
        v.y1 - v.y0 >= 1.4 * sp0 &&
        !barXs.some((bx) => Math.abs(bx - v.x) < 0.3),
    ),
    beams: ctx.beams.filter((b) => b.thickness >= 0.28 * sp0 && b.thickness <= 0.9 * sp0 && b.x0 < system.x1 + 1 && b.x1 > system.x0 - 1),
  };
}

function similarity(a: StaffInfo, b: StaffInfo): number {
  if (a.kind !== b.kind) return -100;
  let s = 3;
  if (Math.abs(a.spacing / b.spacing - 1) < 0.08) s += 1;
  if (a.clef === b.clef && a.clef !== '?') s += 1;
  if (a.braced === b.braced) s += 2;
  return s;
}

/** Aligne les portées d'un système sur celles du modèle (ordre conservé). */
function align(infos: StaffInfo[], template: StaffInfo[]): number[] {
  const n = infos.length;
  const m = template.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(-Infinity));
  const back: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let j = 0; j <= m; j++) (score[0] as number[])[j] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const skip = (score[i] as number[])[j - 1] as number;
      const match = ((score[i - 1] as number[])[j - 1] as number) + similarity(infos[i - 1] as StaffInfo, template[j - 1] as StaffInfo);
      if (match >= skip) {
        (score[i] as number[])[j] = match;
        (back[i] as number[])[j] = 1;
      } else {
        (score[i] as number[])[j] = skip;
        (back[i] as number[])[j] = 0;
      }
    }
  }
  const slots = new Array<number>(n).fill(0);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if ((back[i] as number[])[j] === 1) {
      slots[i - 1] = j - 1;
      i--;
      j--;
    } else j--;
  }
  return slots;
}

/* ------------------------------------------------------------------ */
/* Parties                                                             */
/* ------------------------------------------------------------------ */

interface PartPlan {
  /** Portées (index du modèle) de notation, ou la tablature seule. */
  staves: number[];
  tab: number | null;
  /** Tablature lue seule (pas de portée de notation associée). */
  tabOnly: boolean;
  tuning: number[] | null;
  capo: number;
  guitar: boolean;
}

/** Part des cases de la tablature qui tombent sous un accord de la portée de notation. */
function pairingRatio(frames: Frame[], notationSlot: number, tabSlot: number): number {
  let matched = 0;
  let total = 0;
  for (const f of frames) {
    const ni = f.slots.indexOf(notationSlot);
    const ti = f.slots.indexOf(tabSlot);
    if (ni < 0 || ti < 0) continue;
    const notation = (f.notation.get(ni) ?? []).flatMap((m) => m.events.filter((e) => e.kind === 'chord'));
    const sp = (f.system.staves[ni] as Staff).spacing;
    for (const col of (f.tabs.get(ti)?.measures ?? []).flatMap((m) => m.events.filter((e) => e.kind === 'chord'))) {
      total++;
      if (notation.some((e) => col.x >= e.x - 0.8 * sp && col.x <= e.x1 + 0.8 * sp)) matched++;
    }
  }
  return total ? matched / total : 0;
}

function planParts(template: Frame, frames: Frame[]): PartPlan[] {
  const plans: PartPlan[] = [];
  const infos = template.infos;
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i] as StaffInfo;
    if (info.kind === 'tab') {
      const prev = plans[plans.length - 1];
      if (prev && !prev.tabOnly && prev.tab === null && prev.staves.length === 1 && prev.staves[0] === i - 1 && pairingRatio(frames, i - 1, i) >= 0.6) {
        prev.tab = i;
        prev.guitar = true;
      } else plans.push({ staves: [], tab: i, tabOnly: true, tuning: null, capo: 0, guitar: true });
      continue;
    }
    const next = infos[i + 1];
    if (info.braced && next && next.kind === 'standard' && next.braced) {
      plans.push({ staves: [i, i + 1], tab: null, tabOnly: false, tuning: null, capo: 0, guitar: false });
      i++;
    } else plans.push({ staves: [i], tab: null, tabOnly: false, tuning: null, capo: 0, guitar: false });
  }
  return plans;
}

/* ------------------------------------------------------------------ */
/* Titre                                                               */
/* ------------------------------------------------------------------ */

function findMeta(pages: PageContext[], lines: TextLine[]): { title: string; composer: string; tempo: number | null } {
  const first = pages[0];
  if (!first) return { title: '', composer: '', tempo: null };
  const firstStaff = first.systems[0]?.staves[0];
  const limit = firstStaff ? staffTop(firstStaff) : first.page.height / 3;
  // Texte au-dessus de la musique, hors indications de tempo, numéros et reprises (« 1. 2. »).
  const head = lines.filter(
    (l) => l.page === first.page.index && l.y < limit && /\p{L}{2}/u.test(l.text) && !/=/.test(l.text),
  );
  // Titre : la plus grande écriture au-dessus de la musique, centrée sur la page.
  const centered = (l: TextLine): boolean => Math.abs((l.x + l.x1) / 2 - first.page.width / 2) < first.page.width * 0.12;
  // Au-dessus de la première portée (sans être un nom d'accord ou une nuance, qui en sont proches),
  // et nettement plus grand que le reste du texte.
  const far = (l: TextLine): boolean => !firstStaff || l.y < staffTop(firstStaff) - 2.5 * firstStaff.spacing;
  const maxSize = Math.max(0, ...head.filter(far).map((l) => l.size));
  const others = lines.filter((l) => l.page === first.page.index && l.size < maxSize - 0.5).map((l) => l.size);
  const large = !others.length || maxSize >= 1.3 * median(others);
  const titleLines = large ? head.filter((l) => far(l) && l.size >= maxSize - 0.5 && centered(l)) : [];
  const title = titleLines
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((l) => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Compositeur : texte aligné à droite entre le titre et la musique (ni numéro, ni indication de tempo).
  const bodySize = median(head.map((l) => l.size));
  const right = head
    .filter((l) => !titleLines.includes(l) && l.x > first.page.width * 0.5 && l.size >= bodySize * 0.8)
    .filter((l) => !/^[\d\s.,()=-]*$/.test(l.text) && !/=|♩|\bbpm\b/i.test(l.text))
    .filter((l) => !firstStaff || l.y < staffTop(firstStaff) - 4 * firstStaff.spacing)
    .sort((a, b) => a.y - b.y);
  const composer = right.length ? (right[right.length - 1] as TextLine).text : '';
  let tempo: number | null = null;
  for (const l of lines.filter((x) => x.page === first.page.index)) {
    const m = /=\s*(\d{2,3})\b/.exec(l.text);
    if (m && Number(m[1]) >= 20 && Number(m[1]) <= 400) {
      tempo = Number(m[1]);
      break;
    }
  }
  return { title, composer, tempo };
}

/* ------------------------------------------------------------------ */
/* Assemblage                                                          */
/* ------------------------------------------------------------------ */

const fmt = (q: number): string => (Math.round(q * 1000) / 1000).toString();

function traceEvents(page: number, events: Ev[]): void {
  if (!tracer.fn) return;
  for (const e of events) {
    const names = e.notes
      .map((n) => `${n.pitch.step}${n.pitch.alter > 0 ? '#'.repeat(n.pitch.alter) : 'b'.repeat(-n.pitch.alter)}${n.pitch.octave}${n.fret !== undefined ? `/${n.string}:${n.fret}` : ''}`)
      .join(',');
    const ys = e.heads.map((h) => h.y);
    emit({
      page,
      kind: 'event',
      x0: e.x,
      y0: ys.length ? Math.min(...ys) : e.y,
      x1: e.x1,
      y1: ys.length ? Math.max(...ys) : e.y,
      label: `${names || 'r'} ${fmt(e.duration)} v${e.voice}@${fmt(e.onset)}`,
    });
  }
}

/** Associe cases de tablature et notes de la portée jumelle (même colonne, hauteurs dans l'ordre). */
function attachFrets(notation: Ev[], tab: Ev[], sp: number, pairs: Array<{ string: number; fret: number; midi: number }>): void {
  for (const col of tab) {
    if (col.kind !== 'chord') continue;
    const chords = notation.filter((e) => e.kind === 'chord' && col.x >= e.x - 0.8 * sp && col.x <= e.x1 + 0.8 * sp);
    const notes = chords
      .flatMap((e) => e.notes)
      .filter((n) => n.fret === undefined)
      .sort((a, b) => pitchToMidi(b.pitch) - pitchToMidi(a.pitch));
    const frets = [...col.notes].sort((a, b) => (a.string ?? 0) - (b.string ?? 0));
    if (notes.length !== frets.length) continue;
    notes.forEach((n, i) => {
      const f = frets[i] as Ev['notes'][number];
      n.string = f.string;
      n.fret = f.fret;
      pairs.push({ string: f.string as number, fret: f.fret as number, midi: pitchToMidi(n.pitch) });
    });
  }
}

export function recognize(pagesData: PageData[], options: RecognizeOptions = {}): RecognizeResult {
  tracer.fn = options.trace ?? null;
  try {
    return recognizeAll(pagesData);
  } finally {
    tracer.fn = null;
  }
}

function recognizeAll(pagesData: PageData[]): RecognizeResult {
  const pages = pagesData.map(readPage);
  const frames: Frame[] = [];
  for (const ctx of pages) {
    for (const system of ctx.systems) {
      frames.push(makeFrame(ctx, system));
      if (tracer.fn) {
        for (const st of system.staves) for (const y of st.lines) emit({ page: ctx.page.index, kind: 'staff', x0: st.x0, y0: y, x1: st.x1, y1: y, label: st.kind });
        const top = staffTop(system.staves[0] as Staff);
        const bottom = staffBottom(system.staves[system.staves.length - 1] as Staff);
        for (const b of system.barlines) emit({ page: ctx.page.index, kind: 'barline', x0: b.x, y0: top - 4, x1: b.x, y1: bottom + 4, label: b.style });
        emit({ page: ctx.page.index, kind: 'barline', x0: system.start, y0: top - 6, x1: system.start, y1: bottom + 6, label: 'start' });
      }
    }
  }
  const stats: RecognizeStats = { pages: pagesData.length, staves: 0, systems: frames.length, measures: 0, notes: 0, irregular: 0 };
  const lines = pages.flatMap((p) => textLines(p.symbols.text, p.page.index));
  const meta = findMeta(pages, lines);
  if (!frames.length) return { score: { ...meta, parts: [] }, stats };
  stats.staves = frames.reduce((s, f) => s + f.system.staves.length, 0);

  // Modèle : le système le plus complet ; chaque système y est aligné.
  const template = frames.reduce((best, f) => (f.system.staves.length > best.system.staves.length ? f : best), frames[0] as Frame);
  for (const f of frames) f.slots = f === template ? f.infos.map((_, i) => i) : align(f.infos, template.infos);

  // Lecture de chaque portée.
  const states = new Map<number, StaffState>();
  for (const f of frames) {
    f.system.staves.forEach((staff, si) => {
      const slot = f.slots[si] as number;
      const syms = f.syms.get(staff) as StaffSyms;
      if (staff.kind === 'tab') {
        f.tabs.set(si, readTabStaff(f.ctx, f, staff, syms));
      } else {
        let st = states.get(slot);
        if (!st) {
          st = newStaffState();
          states.set(slot, st);
        }
        f.notation.set(si, readNotationStaff(f.ctx, f, staff, syms, st));
      }
    });
  }

  const plans = planParts(template, frames);
  const textual = lines.some((l) => /guit|gtr|chitarra|gitarr|guitare/i.test(l.text));
  for (const plan of plans) if (textual && plan.staves.length === 1) plan.guitar = true;

  // Accordage des tablatures : notes jumelles, sinon texte, sinon accordage standard.
  const pairsBySlot = new Map<number, Array<{ string: number; fret: number; midi: number }>>();
  for (const plan of plans) {
    if (plan.tab === null || plan.tabOnly) continue;
    const pairs: Array<{ string: number; fret: number; midi: number }> = [];
    for (const f of frames) {
      const ni = f.slots.indexOf(plan.staves[0] as number);
      const ti = f.slots.indexOf(plan.tab);
      if (ni < 0 || ti < 0) continue;
      const sp = (f.system.staves[ni] as Staff).spacing;
      const nm = f.notation.get(ni) ?? [];
      const tm = f.tabs.get(ti)?.measures ?? [];
      nm.forEach((m, k) => attachFrets(m.events, tm[k]?.events ?? [], sp, pairs));
    }
    pairsBySlot.set(plan.tab, pairs);
  }
  for (const plan of plans) {
    if (plan.tab === null) continue;
    const strings = (template.system.staves[plan.tab] as Staff).lines.length;
    const fromText = tuningFromText(lines, strings);
    const pairs = pairsBySlot.get(plan.tab) ?? [];
    let tuning = tuningFromPairs(pairs, strings);
    if (tuning) {
      // Portée écrite une octave au-dessus du son réel (clé de sol simple) : on corrige la notation.
      const base = DEFAULT_TUNINGS[strings] as number[];
      const shift = median(tuning.map((m, i) => m - (base[i] as number)));
      if (shift >= 10) {
        tuning = tuning.map((m) => m - 12);
        for (const f of frames) {
          const ni = f.slots.indexOf(plan.staves[0] as number);
          for (const m of f.notation.get(ni) ?? []) for (const e of m.events) for (const n of e.notes) n.pitch = { ...n.pitch, octave: n.pitch.octave - 1 };
        }
        plan.guitar = false; // déjà corrigée
        octaveFixed.add(plan);
      }
    }
    plan.tuning = tuning ?? fromText?.tuning ?? DEFAULT_TUNINGS[strings] ?? null;
    plan.capo = fromText?.capo ?? 0;
  }

  // Assemblage mesure par mesure.
  const parts: RecPart[] = plans.map((p, i) => ({
    name: p.tabOnly || p.tab !== null ? 'Guitare' : `Partie ${i + 1}`,
    staves: Math.max(1, p.staves.length),
    measures: [],
    ...(p.tuning && p.tab !== null ? { tuning: p.tuning, capo: p.capo } : {}),
  }));
  let time = { beats: 4, beatType: 4 };
  let number = 0;
  const lastClef = new Map<string, string>();
  for (const f of frames) {
    for (let m = 0; m < f.measureCount; m++) {
      number++;
      const reads: MeasureRead[] = [];
      f.notation.forEach((mr) => mr[m] && reads.push(mr[m] as MeasureRead));
      f.tabs.forEach((tr) => tr.measures[m] && reads.push(tr.measures[m] as MeasureRead));
      const t = reads.find((r) => r.time)?.time;
      const timeChanged = !!t && (t.beats !== time.beats || t.beatType !== time.beatType);
      if (t) time = { beats: t.beats, beatType: t.beatType };
      const length = measureLength(time);
      const end = (f.system.barlines[m] as { left: number } | undefined)?.left ?? f.system.x1;

      plans.forEach((plan, pi) => {
        const part = parts[pi] as RecPart;
        const rec: RecMeasure = { number, events: [] };
        if (number === 1 || timeChanged) rec.time = t ? { ...t } : { ...time };
        const clefs: Array<Clef | undefined> = [];
        const sources: Array<{ k: number; staff: Staff; mr: MeasureRead; tab: TabRead | null }> = [];
        if (plan.tabOnly && plan.tab !== null) {
          const ti = f.slots.indexOf(plan.tab);
          const tr = ti >= 0 ? f.tabs.get(ti) : undefined;
          if (tr?.measures[m]) sources.push({ k: 0, staff: f.system.staves[ti] as Staff, mr: tr.measures[m] as MeasureRead, tab: tr });
        } else {
          plan.staves.forEach((slot, k) => {
            const si = f.slots.indexOf(slot);
            const mr = si >= 0 ? f.notation.get(si)?.[m] : undefined;
            if (mr) sources.push({ k, staff: f.system.staves[si] as Staff, mr, tab: null });
          });
        }
        for (const { k, staff, mr, tab } of sources) {
          if (mr.clef) {
            const key = `${pi}:${k}`;
            const sig = JSON.stringify(mr.clef);
            if (lastClef.get(key) !== sig || number === 1) clefs[k] = mr.clef;
            lastClef.set(key, sig);
          }
          if (mr.key !== undefined && k === 0) rec.key = mr.key;
          if (mr.repeatStart) rec.repeatStart = true;
          if (mr.repeatEnd) rec.repeatEnd = true;
          const events = mr.events;
          if (tab) {
            // Hauteurs d'après l'accordage.
            const tuning = plan.tuning ?? DEFAULT_TUNINGS[staff.lines.length] ?? [];
            const flats = (rec.key ?? 0) < 0;
            for (const e of events) {
              for (const n of e.notes) {
                const open = tuning[(n.string ?? 1) - 1] ?? 40;
                n.pitch = midiToPitch(open + (n.fret ?? 0) + plan.capo, flats);
              }
            }
            if (!tab.rhythm) inferDurations(events, end, length);
          }
          finalizeDurations(events, time);
          if (tab?.rhythm) repairStemDurations(events, end, length);
          const sp = staff.spacing;
          const col = tab ? 0.45 * sp : 0.6 * (median(events.flatMap((e) => e.heads.map((h) => h.x1 - h.x))) || 1.18 * sp);
          assignVoices(events, length, col, (staffTop(staff) + staffBottom(staff)) / 2);
          traceEvents(f.system.page, events);
          for (const e of events) {
            if (e.kind === 'chord') stats.notes += e.notes.length;
            const ev: RecEvent = { onset: e.onset, duration: e.duration, type: e.type, dots: e.dots, notes: e.notes, voice: e.voice + k * 4, staff: k + 1 };
            if (e.measureRest) ev.measureRest = true;
            if (e.stemDir && !tab) ev.stem = e.stemDir;
            if (e.tuplet) ev.tuplet = { actual: e.tuplet.actual, normal: e.tuplet.normal };
            rec.events.push(ev);
          }
          const ends = new Map<number, number>();
          for (const e of events) ends.set(e.voice, Math.max(ends.get(e.voice) ?? 0, e.onset + e.duration));
          for (const endT of ends.values()) if (Math.abs(endT - length) > EPS) stats.irregular++;
        }
        if (plan.tabOnly && part.measures.length === 0) clefs[0] = { sign: 'TAB', line: 5, octave: 0 };
        if (clefs.some(Boolean)) rec.clefs = clefs;
        const bar = f.system.barlines[m];
        if (bar?.style === 'final') rec.barStyle = 'final';
        else if (bar?.style === 'double') rec.barStyle = 'double';
        part.measures.push(rec);
      });
    }
  }
  stats.measures = number;

  // Guitare écrite en clé de sol simple : le son réel est une octave plus bas.
  plans.forEach((plan, pi) => {
    const part = parts[pi] as RecPart;
    if (plan.tabOnly || octaveFixed.has(plan)) {
      if (octaveFixed.has(plan)) markOctaveClef(part);
      return;
    }
    if (!plan.guitar || part.staves !== 1) return;
    const clefs = part.measures.flatMap((m) => m.clefs ?? []).filter(Boolean) as Clef[];
    if (clefs.length && clefs.every((c) => c.sign === 'G' && c.octave === 0)) {
      for (const m of part.measures) for (const e of m.events) for (const n of e.notes) n.pitch = { ...n.pitch, octave: n.pitch.octave - 1 };
      markOctaveClef(part);
    }
  });
  octaveFixed.clear();
  markTupletBounds(parts);
  return { score: { ...meta, parts }, stats };
}

const octaveFixed = new Set<PartPlan>();

function markOctaveClef(part: RecPart): void {
  for (const m of part.measures) {
    if (!m.clefs) continue;
    m.clefs = m.clefs.map((c) => (c && c.sign === 'G' && c.octave === 0 ? { ...c, octave: -1 } : c));
  }
}

/** Début et fin de chaque groupe de n-olet, voix par voix. */
function markTupletBounds(parts: RecPart[]): void {
  for (const part of parts) {
    for (const m of part.measures) {
      const byVoice = new Map<number, RecEvent[]>();
      for (const e of m.events) {
        const list = byVoice.get(e.voice) ?? [];
        list.push(e);
        byVoice.set(e.voice, list);
      }
      for (const list of byVoice.values()) {
        list.sort((a, b) => a.onset - b.onset);
        let acc = 0;
        for (let i = 0; i < list.length; i++) {
          const e = list[i] as RecEvent;
          if (!e.tuplet) {
            acc = 0;
            continue;
          }
          if (acc < EPS) e.tuplet.start = true;
          acc += e.duration;
          // Un groupe complet dure « normal » fois la figure de base.
          const unit = e.duration / ((e.tuplet.normal / e.tuplet.actual) * (e.dots ? 1.5 : 1));
          const groupLength = unit * e.tuplet.normal;
          const next = list[i + 1];
          if (!next?.tuplet || acc >= groupLength - EPS) {
            e.tuplet.stop = true;
            acc = 0;
          }
        }
      }
    }
  }
}
