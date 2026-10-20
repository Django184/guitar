/**
 * Tablatures « texte » (ASCII) : des lignes de caractères à chasse fixe comme
 *
 *   e|-----0-----|
 *   B|---1---1---|
 *   G|-2-------2-|
 *
 * écrites en texte dans le PDF (police Courier…) ou dessinées en image (lues par tabOcr.ts).
 * Une colonne de caractères est un instant ; le rythme, rarement écrit, est déduit de l'espacement.
 */
import { DEFAULT_TUNINGS, midiToPitch, tuningFromText, type TextLine } from './tab';
import type { NoteType, RecEvent, RecMeasure, RecNote, RecScore } from './model';
import type { Glyph } from './types';

/** Une ligne de texte à chasse fixe : un caractère par colonne (espaces compris). */
export interface TextRow {
  text: string;
  page: number;
  /** Ordonnée de la ligne de base, pour l'ordre de lecture et les blancs entre blocs. */
  y: number;
  /** Hauteur de ligne (corps du texte, ou pas vertical de la grille en image). */
  size: number;
}

/* ------------------------------------------------------------------ */
/* Lignes à chasse fixe depuis les glyphes d'une page                  */
/* ------------------------------------------------------------------ */

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/**
 * Regroupe les glyphes des polices à chasse fixe en lignes de caractères alignées sur une
 * grille commune (les espaces ne sont pas dessinés : la position de chaque glyphe donne sa colonne).
 */
export function monospaceRows(glyphs: Glyph[], page: number): TextRow[] {
  const byFont = new Map<string, Glyph[]>();
  for (const g of glyphs) {
    const key = `${g.font}|${g.size.toFixed(1)}`;
    const list = byFont.get(key) ?? [];
    list.push(g);
    byFont.set(key, list);
  }
  const rows: TextRow[] = [];
  for (const list of byFont.values()) {
    if (list.length < 20) continue;
    const pitch = median(list.map((g) => g.width));
    if (pitch <= 0) continue;
    // Chasse fixe : (presque) tous les glyphes ont la même largeur.
    const regular = list.filter((g) => Math.abs(g.width - pitch) < pitch * 0.04).length / list.length;
    if (regular < 0.9) continue;
    const origin = Math.min(...list.map((g) => g.x));
    const lines: Glyph[][] = [];
    for (const g of [...list].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const line = lines[lines.length - 1];
      if (line && Math.abs((line[0] as Glyph).y - g.y) < 0.3 * g.size) line.push(g);
      else lines.push([g]);
    }
    for (const line of lines) {
      const chars: string[] = [];
      for (const g of line) {
        const col = Math.round((g.x - origin) / pitch);
        while (chars.length < col) chars.push(' ');
        chars[col] = g.text;
      }
      rows.push({ text: chars.join(''), page, y: (line[0] as Glyph).y, size: (line[0] as Glyph).size });
    }
  }
  return rows.sort((a, b) => a.page - b.page || a.y - b.y);
}

/* ------------------------------------------------------------------ */
/* Blocs de tablature                                                  */
/* ------------------------------------------------------------------ */

interface TabNote {
  string: number;
  fret: number;
  start: number;
  end: number;
}

interface Block {
  rows: TextRow[];
  names: Array<string | null>;
  notes: TabNote[];
  /** Colonnes des barres de mesure (hors barre de début). */
  bars: number[];
  start: number;
  end: number;
}

const DASHES = /[–—−_]/g;

/**
 * Partie utile d'une ligne : la musique s'arrête au premier blanc qui suit le premier tiret
 * (au-delà : numéro de ligne, commentaire…).
 */
function content(text: string): string {
  const t = text.replace(DASHES, '-');
  const dash = t.indexOf('-');
  if (dash < 0) return t.trimEnd();
  const cut = t.slice(dash).search(/\s/);
  return cut < 0 ? t : t.slice(0, dash + cut);
}

export function isTabRow(text: string): boolean {
  const t = content(text).trim();
  if (t.length < 8) return false;
  const dashes = (t.match(/-/g) ?? []).length;
  const ink = t.replace(/\s/g, '').length;
  return dashes >= 6 && dashes / ink >= 0.45 && /^([A-Ga-g][#b]?\s*)?[|:\-[]/.test(t);
}

const NAME = /^\s*([A-Ga-g][#b]?)\s*[|:[]/;

function parseBlock(rows: TextRow[]): Block | null {
  const texts = rows.map((r) => content(r.text));
  const names = texts.map((t) => NAME.exec(t)?.[1] ?? null);
  // Début de la musique : après le nom de corde et la première barre.
  const starts = texts.map((t) => {
    const m = /^\s*(?:[A-Ga-g][#b]?\s*)?[|:[]+/.exec(t);
    if (m) return m.index + m[0].length;
    return Math.max(0, t.search(/-/));
  });
  const start = median(starts);
  const end = Math.max(...texts.map((t) => t.trimEnd().length));
  const n = rows.length;

  const notes: TabNote[] = [];
  texts.forEach((t, i) => {
    for (const m of t.slice(starts[i] as number).matchAll(/\d+/g)) {
      const at = (starts[i] as number) + (m.index ?? 0);
      // Plus de deux chiffres collés : cases successives de deux chiffres au plus.
      for (let k = 0; k < m[0].length; k += 2) {
        const digits = m[0].slice(k, k + 2);
        const fret = Number(digits);
        if (fret <= 30) notes.push({ string: i + 1, fret, start: at + k, end: at + k + digits.length - 1 });
      }
    }
  });

  // Barres de mesure : un « | » à la même colonne sur (presque) toutes les cordes.
  const bars: number[] = [];
  for (let c = start; c <= end; c++) {
    const hits = texts.filter((t) => t[c] === '|').length;
    if (hits >= Math.max(2, n - 1) && !bars.includes(c - 1)) bars.push(c);
  }
  return { rows, names, notes, bars, start, end: bars.length && (bars[bars.length - 1] as number) >= end - 1 ? (bars[bars.length - 1] as number) : end + 1 };
}

/** Découpe les lignes en blocs de 4 à 8 cordes. */
function findBlocks(rows: TextRow[]): Block[] {
  const groups: TextRow[][] = [];
  let current: TextRow[] = [];
  for (const row of rows) {
    const prev = current[current.length - 1];
    const tab = isTabRow(row.text);
    const close = prev && prev.page === row.page && row.y - prev.y < 1.8 * Math.max(prev.size, row.size);
    if (tab && close) current.push(row);
    else {
      if (current.length) groups.push(current);
      current = tab ? [row] : [];
    }
  }
  if (current.length) groups.push(current);

  const blocks: Block[] = [];
  for (const g of groups) {
    // Deux blocs collés : on coupe quand le nom de la corde aiguë revient.
    const chunks: TextRow[][] = [];
    if (g.length > 8) {
      const names = g.map((r) => NAME.exec(content(r.text))?.[1] ?? null);
      const top = names[0];
      let chunk: TextRow[] = [];
      g.forEach((r, i) => {
        if (top && i > 0 && names[i] === top && chunk.length >= 4) {
          chunks.push(chunk);
          chunk = [];
        }
        chunk.push(r);
      });
      chunks.push(chunk);
      if (!top) {
        chunks.length = 0;
        const size = g.length % 6 === 0 ? 6 : g.length % 4 === 0 ? 4 : g.length % 7 === 0 ? 7 : 6;
        for (let i = 0; i < g.length; i += size) chunks.push(g.slice(i, i + size));
      }
    } else chunks.push(g);
    for (const c of chunks) {
      if (c.length < 4 || c.length > 8) continue;
      const block = parseBlock(c);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Rythme                                                              */
/* ------------------------------------------------------------------ */

const VALUES: Array<{ q: number; type: NoteType; dots: number }> = [
  { q: 4, type: 'whole', dots: 0 },
  { q: 3, type: 'half', dots: 1 },
  { q: 2, type: 'half', dots: 0 },
  { q: 1.5, type: 'quarter', dots: 1 },
  { q: 1, type: 'quarter', dots: 0 },
  { q: 0.75, type: 'eighth', dots: 1 },
  { q: 0.5, type: 'eighth', dots: 0 },
  { q: 0.25, type: '16th', dots: 0 },
];

/** Décompose une durée (multiple de la double croche) en figures liées. */
export function splitValue(q: number): Array<{ q: number; type: NoteType; dots: number }> {
  const out: Array<{ q: number; type: NoteType; dots: number }> = [];
  let left = Math.round(q * 4) / 4;
  while (left > 1e-9) {
    const v = VALUES.find((x) => x.q <= left + 1e-9) ?? (VALUES[VALUES.length - 1] as (typeof VALUES)[number]);
    out.push(v);
    left -= v.q;
  }
  return out;
}

interface Column {
  start: number;
  notes: TabNote[];
}

/** Colonnes : cases dont les caractères se chevauchent (« 10 » sur une corde, « 8 » sous le « 0 »). */
function columns(notes: TabNote[]): Column[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.string - b.string);
  const out: Array<Column & { end: number }> = [];
  for (const n of sorted) {
    const col = out[out.length - 1];
    if (col && n.start <= col.end && !col.notes.some((o) => o.string === n.string)) {
      col.notes.push(n);
      col.end = Math.max(col.end, n.end);
    } else out.push({ start: n.start, end: n.end, notes: [n] });
  }
  return out;
}

interface Timed {
  onset: number;
  notes: TabNote[];
}

/* ------------------------------------------------------------------ */
/* Partition                                                           */
/* ------------------------------------------------------------------ */

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function tuningFromNames(names: Array<string | null>): number[] | null {
  const base = DEFAULT_TUNINGS[names.length];
  if (!base || names.some((n) => !n)) return null;
  return names.map((name, i) => {
    let pc = PC[(name as string)[0]?.toUpperCase() ?? 'E'] ?? 4;
    if ((name as string)[1] === '#') pc += 1;
    if ((name as string)[1] === 'b') pc -= 1;
    pc = (pc + 12) % 12;
    // Hauteur de cette note la plus proche de la corde de l'accordage standard (plutôt en dessous).
    const ref = base[i] as number;
    let best = ref;
    let bestD = Infinity;
    for (let m = ref - 7; m <= ref + 5; m++) {
      if ((((m % 12) + 12) % 12) !== pc) continue;
      const d = Math.abs(m - ref) + (m > ref ? 0.5 : 0);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  });
}

/** Chiffrage écrit dans le texte (« Rhythm 3/4 », « 6/8 ») ; 4/4 par défaut. */
export function timeFromText(lines: string[]): { beats: number; beatType: number } | null {
  for (const line of lines) {
    if (isTabRow(line)) continue;
    const m = /(?:^|[^\d/])([2-9]|1[0-6])\s*\/\s*(2|4|8|16)(?![\d/])/.exec(line);
    if (m && !/step|ton|tone/i.test(line.slice(m.index, m.index + 14))) return { beats: Number(m[1]), beatType: Number(m[2]) };
  }
  return null;
}

/**
 * Lit les tablatures texte de lignes déjà alignées sur une grille de caractères.
 * `texts` : autres lignes du document (titre, accordage, capodastre, chiffrage).
 */
export function readAsciiTab(rows: TextRow[], texts: TextLine[]): { score: RecScore; notes: number } | null {
  const blocks = findBlocks(rows);
  const total = blocks.reduce((s, b) => s + b.notes.length, 0);
  if (!blocks.length || total === 0) return null;

  const strings = Math.max(...blocks.map((b) => b.rows.length));
  const allText = [...texts.map((t) => t.text), ...rows.filter((r) => !isTabRow(r.text)).map((r) => r.text)];
  const written = tuningFromText(allText.map((text) => ({ text, x: 0, x1: 0, y: 0, size: 0, page: 0 })), strings);
  const named = blocks.map((b) => tuningFromNames(b.names)).find((t) => t && t.length === strings) ?? null;
  const tuning = named ?? written?.tuning ?? DEFAULT_TUNINGS[strings] ?? (DEFAULT_TUNINGS[6] as number[]);
  const capo = written?.capo ?? 0;
  const time = timeFromText(allText) ?? { beats: 4, beatType: 4 };
  const length = (time.beats * 4) / time.beatType;

  // Événements datés, mesure par mesure.
  const measures: Timed[][] = [];
  const hasBars = blocks.some((b) => b.bars.some((c) => c < b.end - 1));
  if (hasBars) {
    for (const b of blocks) {
      const edges = [b.start, ...b.bars.map((c) => c + 1)];
      if ((edges[edges.length - 1] as number) < b.end) edges.push(b.end + 1);
      const spans: Array<{ from: number; to: number; cols: Column[] }> = [];
      for (let i = 0; i + 1 < edges.length; i++) {
        const from = edges[i] as number;
        const to = (edges[i + 1] as number) - 1; // colonne de la barre
        const cols = columns(b.notes.filter((n) => n.start >= from && n.start < to));
        if (to - from < 2 && !cols.length) continue;
        spans.push({ from, to, cols });
      }
      // Tiret d'attaque après chaque barre (« |-2-----1--- ») : le premier temps est juste après.
      const lead = Math.min(2, ...spans.filter((sp) => sp.cols.length).map((sp) => (sp.cols[0] as Column).start - sp.from));
      for (const { from, to, cols } of spans) {
        const width = Math.max(1, to - from - lead);
        const timed: Timed[] = [];
        for (const c of cols) {
          let onset = Math.round((Math.max(0, c.start - from - lead) / width) * length * 4) / 4;
          const last = timed[timed.length - 1];
          if (last && onset <= last.onset) onset = last.onset + 0.25;
          if (onset >= length) onset = Math.max(0, length - 0.25);
          if (last && Math.abs(last.onset - onset) < 1e-9) last.notes.push(...c.notes);
          else timed.push({ onset, notes: c.notes });
        }
        measures.push(timed);
      }
    }
  } else {
    // Sans barres : le pas le plus fréquent entre deux colonnes vaut une croche.
    const gaps: number[] = [];
    const perBlock = blocks.map((b) => columns(b.notes));
    perBlock.forEach((cols) => cols.forEach((c, i) => i > 0 && gaps.push(c.start - (cols[i - 1] as Column).start)));
    const counts = new Map<number, number>();
    for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
    const step = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 2;
    let t = 0;
    const stream: Timed[] = [];
    perBlock.forEach((cols, bi) => {
      cols.forEach((c, i) => {
        stream.push({ onset: t, notes: c.notes });
        const next = cols[i + 1];
        const gap = next ? next.start - c.start : Math.max(step, (blocks[bi] as Block).end - c.start);
        t += Math.max(0.25, Math.round((gap / step) * 2) / 4);
      });
    });
    const totalLength = Math.ceil(t / length - 1e-9) * length;
    for (let m = 0; m * length < totalLength; m++) {
      measures.push(stream.filter((e) => e.onset >= m * length - 1e-9 && e.onset < (m + 1) * length - 1e-9).map((e) => ({ onset: e.onset - m * length, notes: e.notes })));
    }
  }

  const recMeasures: RecMeasure[] = measures.map((timed, mi) => {
    const events: RecEvent[] = [];
    const push = (onset: number, q: number, notes: RecNote[]): void => {
      let at = onset;
      const parts = splitValue(q);
      parts.forEach((p, i) => {
        events.push({
          onset: at,
          duration: p.q,
          type: p.type,
          dots: p.dots,
          notes: notes.map((n) => ({ ...n, ...(i > 0 ? { tieStop: true } : {}), ...(i < parts.length - 1 ? { tieStart: true } : {}) })),
          voice: 1,
          staff: 1,
        });
        at += p.q;
      });
    };
    const first = timed[0];
    if (!first) {
      events.push({ onset: 0, duration: length, type: 'whole', dots: 0, notes: [], voice: 1, staff: 1, measureRest: true });
    } else {
      if (first.onset > 0) {
        let at = 0;
        for (const p of splitValue(first.onset)) {
          events.push({ onset: at, duration: p.q, type: p.type, dots: p.dots, notes: [], voice: 1, staff: 1 });
          at += p.q;
        }
      }
      timed.forEach((e, i) => {
        const end = (timed[i + 1] as Timed | undefined)?.onset ?? length;
        const notes: RecNote[] = [...e.notes]
          .sort((a, b) => a.string - b.string)
          .map((n) => ({
            pitch: midiToPitch((tuning[n.string - 1] ?? 40) + n.fret + capo, false),
            string: n.string,
            fret: n.fret,
          }));
        push(e.onset, Math.max(0.25, end - e.onset), notes);
      });
    }
    const rec: RecMeasure = { number: mi + 1, events };
    if (mi === 0) {
      rec.time = { ...time };
      rec.key = 0;
      rec.clefs = [{ sign: 'TAB', line: 5, octave: 0 }];
    }
    return rec;
  });

  const title = titleOf(texts, rows);
  return {
    score: { title, composer: '', tempo: null, parts: [{ name: 'Guitare', staves: 1, measures: recMeasures, tuning, capo }] },
    notes: total,
  };
}

/** Titre : la plus grande écriture de la première page (hors tablature). */
function titleOf(texts: TextLine[], rows: TextRow[]): string {
  const page = Math.min(...texts.map((t) => t.page), ...rows.map((r) => r.page));
  const lines = texts.filter((t) => t.page === page && /\p{L}{2}/u.test(t.text) && !isTabRow(t.text));
  if (!lines.length) return '';
  const max = Math.max(...lines.map((l) => l.size));
  const others = lines.filter((l) => l.size < max - 0.5).map((l) => l.size);
  if (others.length && max < 1.2 * median(others)) return '';
  return lines
    .filter((l) => l.size >= max - 0.5)
    .sort((a, b) => a.y - b.y)
    .map((l) => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
