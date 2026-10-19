import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages } from '../src/scores/pdf/extract';
import { recognize } from '../src/scores/pdf/recognize';
import { toMusicXml } from '../src/scores/pdf/musicxml';

/** PDF minimal (une page 300 × 200, police Helvetica standard) avec le flux de dessin donné. */
function makePdf(content: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

// Tablature de 6 lignes (interligne 6 pt) : en coordonnées PDF (origine en bas), lignes y = 150 … 120,
// soit y = 50 … 80 sur la page. Barres de mesure en x = 20, 140, 260.
const lines = [0, 1, 2, 3, 4, 5].map((i) => `20 ${150 - i * 6} m 260 ${150 - i * 6} l S`).join('\n');
const bars = [20, 140, 260].map((x) => `${x} 150 m ${x} 120 l S`).join('\n');
// Une case : chiffre en Helvetica 7 pt centré sur la ligne de la corde (ligne de base 0,36 corps plus bas).
const fret = (x: number, string: number, value: string): string => `BT /F1 7 Tf ${x} ${150 - (string - 1) * 6 - 0.36 * 7} Td (${value}) Tj ET`;
const content = [
  '0.5 w',
  lines,
  '0.9 w',
  bars,
  fret(30, 6, '0'),
  fret(57, 5, '2'),
  fret(84, 4, '12'),
  fret(111, 1, '3'),
  fret(160, 2, '1'),
  fret(160, 3, '0'),
].join('\n');

describe('Extraction pdf.js : glyphes et tracés à leur position exacte', () => {
  it('chiffres et lignes', async () => {
    const task = pdfjs.getDocument({ data: makePdf(content), disableFontFace: true, fontExtraProperties: true, verbosity: 0 });
    const pages = await extractPages(pdfjs, await task.promise);
    await task.destroy();
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.width).toBe(300);
    expect(page?.height).toBe(200);
    // « 12 » : deux glyphes successifs, origine sur la ligne de base (y page = 200 − y PDF).
    const one = page?.glyphs.find((g) => g.text === '1' && Math.abs(g.x - 84) < 0.01);
    expect(one?.font).toBe('Helvetica');
    expect(one?.size).toBeCloseTo(7, 5);
    expect(one?.y).toBeCloseTo(200 - (150 - 3 * 6 - 0.36 * 7), 3);
    const two = page?.glyphs.find((g) => g.text === '2' && g.x > 84 && g.x < 90);
    expect(two?.x).toBeCloseTo(84 + 0.556 * 7, 2);
    // 6 lignes horizontales + 3 barres verticales, tracées.
    const strokes = page?.paths.filter((p) => p.kind === 'stroke') ?? [];
    expect(strokes).toHaveLength(9);
    expect(strokes[0]?.box).toEqual({ x0: 20, y0: 50, x1: 260, y1: 50 });
    expect(strokes[0]?.lineWidth).toBeCloseTo(0.5, 5);

    // Et la tablature est lue : cases, cordes, accordage standard, durées déduites de l'espacement.
    const { score } = recognize(pages);
    const part = score.parts[0];
    expect(part?.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    const xml = toMusicXml(score);
    expect(xml).toContain('<technical><string>4</string><fret>12</fret></technical>');
    expect(xml).toContain('<technical><string>1</string><fret>3</fret></technical>');
    expect(part?.measures[1]?.events[0]?.notes.map((n) => [n.string, n.fret])).toEqual([
      [2, 1],
      [3, 0],
    ]);
  });
});
