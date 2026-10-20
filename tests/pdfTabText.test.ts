import { describe, expect, it } from 'vitest';
import { isTabRow, monospaceRows, readAsciiTab, timeFromText, type TextRow } from '../src/scores/pdf/asciiTab';
import { GLYPH_TEMPLATES } from '../src/scores/pdf/glyphTemplates';
import type { RecMeasure } from '../src/scores/pdf/model';
import { toMusicXml } from '../src/scores/pdf/musicxml';
import type { TextLine } from '../src/scores/pdf/tab';
import { ocrTabRows, toGray, type GrayImage } from '../src/scores/pdf/tabOcr';
import type { Glyph } from '../src/scores/pdf/types';

/* Tablatures « texte » : en caractères à chasse fixe dans le PDF, ou dessinées en image. */

// Deux mesures en 4/4 : 16 colonnes par mesure (une par double croche) après un tiret d'attaque.
const TAB = [
  'e|-0---------------|-----------------|',
  'B|-----1-------1---|-3---------------|',
  'G|---------2-------|-----------------|',
  'D|-----------------|---------2-------|',
  'A|-----------------|-----------------|',
  'D|-----------------|-0-----------10--|',
];

const rowsOf = (lines: string[], top = 100, size = 10): TextRow[] => lines.map((text, i) => ({ text, page: 0, y: top + i * size, size }));
const textLine = (text: string, y: number): TextLine => ({ text, x: 50, x1: 50 + text.length * 5, y, size: 10, page: 0 });

/** Événements d'une mesure : « temps:corde/case+… ». */
const events = (m: RecMeasure | undefined): string[] =>
  (m?.events ?? []).filter((e) => e.notes.length).map((e) => `${e.onset}:${e.notes.map((n) => `${n.string}/${n.fret}`).join('+')}`);

describe('Tablature texte (caractères à chasse fixe)', () => {
  const texts = [textLine('Exercice en arpèges', 40), textLine('Capo 2', 60)];
  const read = readAsciiTab(rowsOf(TAB), texts);
  const part = read?.score.parts[0];

  it('reconnaît les lignes de tablature', () => {
    expect(TAB.every(isTabRow)).toBe(true);
    expect(isTabRow('Tuning: D A D G B E')).toBe(false);
    expect(isTabRow('e|---')).toBe(false);
  });

  it('accordage lu dans les noms de cordes (drop D), capodastre lu dans le texte', () => {
    expect(read?.notes).toBe(8);
    expect(part?.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(part?.capo).toBe(2);
    expect(part?.measures).toHaveLength(2);
  });

  it('temps déduits de la position dans la mesure', () => {
    expect(events(part?.measures[0])).toEqual(['0:1/0', '1:2/1', '2:3/2', '3:2/1']);
    expect(events(part?.measures[1])).toEqual(['0:2/3+6/0', '2:4/2', '3:6/10']);
    // Chaque mesure est pleine (4 noires).
    for (const m of part?.measures ?? []) expect(m.events.reduce((s, e) => s + e.duration, 0)).toBe(4);
  });

  it('MusicXML : accordage, capodastre, cases et hauteurs sonnantes', () => {
    const xml = toMusicXml(read!.score);
    expect(xml).toContain('<capo>2</capo>');
    expect(xml).toContain('<fret>10</fret>');
    // Corde grave en ré (drop D).
    expect(xml).toMatch(/<staff-tuning line="1">\s*<tuning-step>D<\/tuning-step>\s*<tuning-octave>2<\/tuning-octave>/);
  });

  it('chiffrage écrit dans le texte', () => {
    expect(timeFromText(['Rhythm: 3/4'])).toEqual({ beats: 3, beatType: 4 });
    expect(timeFromText(['Tuning: 1/2 step down'])).toBeNull();
    const waltz = readAsciiTab(rowsOf(TAB), [textLine('Valse en 3/4', 40)]);
    expect(waltz?.score.parts[0]?.measures[0]?.time).toEqual({ beats: 3, beatType: 4 });
  });

  it('sans barres de mesure : le pas le plus fréquent vaut une croche', () => {
    const lines = [
      'e|--------------------',
      'B|--------------------',
      'G|--------------------',
      'D|--------------------',
      'A|-3--3--5--5-----7---',
      'E|--------------------',
    ];
    const res = readAsciiTab(rowsOf(lines), []);
    const p = res?.score.parts[0];
    expect(p?.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(events(p?.measures[0])).toEqual(['0:5/3', '0.5:5/3', '1:5/5', '1.5:5/5', '2.5:5/7']);
  });

  it('lignes à chasse fixe retrouvées depuis les glyphes (espaces non dessinés)', () => {
    const lines = ['e|-0-----|', 'B|---1 1-|', 'G|-----2-|', 'D|-------|'];
    const glyphs: Glyph[] = [];
    lines.forEach((line, r) =>
      [...line].forEach((c, k) => {
        if (c !== ' ') glyphs.push({ text: c, cp: c.codePointAt(0) ?? 0, font: 'CourierNewPSMT', x: 50 + k * 6, y: 100 + r * 11, size: 10, width: 6 });
      }),
    );
    // Texte proportionnel à côté : ignoré.
    glyphs.push(...[...'Titre de la page'].map((c, i) => ({ text: c, cp: c.codePointAt(0) ?? 0, font: 'Helvetica', x: 50 + i * 7, y: 60, size: 14, width: 4 + (i % 3) })));
    expect(monospaceRows(glyphs, 0).map((r) => r.text)).toEqual(lines);
  });
});

/* ------------------------------------------------------------------ */
/* Image : tablature dessinée avec les gabarits de caractères          */
/* ------------------------------------------------------------------ */

const CELL = 11; // pas des colonnes, en pixels
const LINE = 20; // pas des lignes
const GLYPH_H = 14;

/** Gabarit (grille 8 × 12, encre de 0 à 15) d'un caractère. */
function template(ch: string): { aspect: number; grid: number[] } {
  const entry = GLYPH_TEMPLATES.split(';').find((e) => e[0] === ch);
  if (!entry) throw new Error(`pas de gabarit pour ${ch}`);
  return { aspect: Number(entry.slice(1, 4)) / 100, grid: [...entry.slice(4, 100)].map((h) => parseInt(h, 16)) };
}

/** Dessine des lignes de tablature (texte noir sur fond blanc), barres d'un seul trait par bloc. */
function drawTab(lines: string[]): GrayImage {
  const width = 20 + lines[0]!.length * CELL;
  const height = 30 + lines.length * LINE;
  const data = new Uint8Array(width * height).fill(255);
  const ink = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] = 20;
  };
  lines.forEach((line, r) => {
    const mid = 15 + r * LINE + LINE / 2;
    [...line].forEach((c, k) => {
      const x0 = 10 + k * CELL;
      if (c === '-') {
        for (let x = x0 + 2; x < x0 + 9; x++) for (let y = mid; y < mid + 2; y++) ink(x, y);
      } else if (c === '|') {
        for (let y = mid - LINE / 2; y < mid + LINE / 2; y++) ink(x0 + 5, y);
      } else if (c !== ' ') {
        const t = template(c);
        const w = Math.max(2, Math.round(t.aspect * GLYPH_H));
        const left = x0 + Math.round((CELL - w) / 2);
        const top = mid - Math.round(GLYPH_H / 2) + 1;
        for (let y = 0; y < GLYPH_H; y++) {
          for (let x = 0; x < w; x++) {
            const v = t.grid[Math.floor((y * 12) / GLYPH_H) * 8 + Math.floor((x * 8) / w)] ?? 0;
            if (v >= 8) ink(left + x, top + y);
          }
        }
      }
    });
  });
  return { width, height, data };
}

describe('Tablature texte dessinée en image', () => {
  const img = drawTab(TAB);

  it('reconnaissance des caractères : lignes, tirets, barres, cases et noms de cordes', () => {
    expect(ocrTabRows(img, 0).map((r) => r.text)).toEqual(TAB);
  });

  it('positions ramenées aux coordonnées de la page', () => {
    const box = { x0: 72, y0: 200, x1: 72 + img.width / 2, y1: 200 + img.height / 2 };
    const rows = ocrTabRows(img, 3, box);
    expect(rows[0]?.page).toBe(3);
    expect(rows[0]?.y).toBeGreaterThan(200);
    expect(rows[1]!.y - rows[0]!.y).toBeCloseTo(LINE / 2, 0);
    expect(rows[5]!.y).toBeLessThan(box.y1);
  });

  it('même partition que la version texte', () => {
    const fromImage = readAsciiTab(ocrTabRows(img, 0), []);
    const fromText = readAsciiTab(rowsOf(TAB), []);
    expect(fromImage?.notes).toBe(8);
    expect(fromImage?.score.parts[0]?.measures.map(events)).toEqual(fromText?.score.parts[0]?.measures.map(events));
  });

  it('pixels pdf.js : gris 1 bit (lignes complétées à l’octet), RVB, RVBA transparent', () => {
    // 10 × 2 en 1 bit : 2 octets par ligne ; noir = 0.
    const bits = toGray({ width: 10, height: 2, kind: 1, data: new Uint8Array([0b01111111, 0b11000000, 0b11111111, 0b10000000]) });
    expect(Array.from(bits!.data.slice(0, 10))).toEqual([0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect(bits!.data[19]).toBe(0);
    const rgb = toGray({ width: 1, height: 1, kind: 2, data: new Uint8Array([255, 255, 255]) });
    expect(rgb!.data[0]).toBe(255);
    const transparent = toGray({ width: 1, height: 1, kind: 3, data: new Uint8Array([0, 0, 0, 0]) });
    expect(transparent!.data[0]).toBe(255);
    expect(toGray({ width: 0, height: 0 })).toBeNull();
  });
});
