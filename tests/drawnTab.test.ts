import { describe, expect, it } from 'vitest';
import { readAsciiTab } from '../src/scores/pdf/asciiTab';
import { GLYPH_TEMPLATES } from '../src/scores/pdf/glyphTemplates';
import { type GrayImage, drawnTabRows } from '../src/scores/pdf/tabOcr';

/* Tablatures « dessinées » : cordes en traits continus, cases posées dans une interruption du trait. */

const W = 900;
const H = 240;
const GAP = 30;
const lineY = (s: number): number => 40 + (s - 1) * GAP;

/** Chiffre dessiné à partir des gabarits (8×12, agrandis ×2), centré en (cx, cy). */
function drawDigit(img: GrayImage, ch: string, cx: number, cy: number): void {
  const entry = GLYPH_TEMPLATES.split(';').find((e) => e[0] === ch);
  if (!entry) throw new Error(ch);
  for (let gy = 0; gy < 24; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const v = parseInt(entry[4 + Math.floor(gy / 2) * 8 + Math.floor(gx / 2)] ?? '0', 16) / 15;
      if (v < 0.35) continue;
      const x = Math.round(cx - 8 + gx);
      const y = Math.round(cy - 12 + gy);
      img.data[y * img.width + x] = Math.round(255 * (1 - v));
    }
  }
}

/** Portée de 6 cordes ; notes [corde (1 = aiguë), position (pas de 40 px), case]. */
function drawnTab(notes: Array<[number, number, number]>, options: { bar?: number; band?: boolean } = {}): GrayImage {
  const img: GrayImage = { width: W, height: H, data: new Uint8Array(W * H).fill(255) };
  const px = (k: number): number => 120 + k * 40;
  // Bandeau grisé à gauche (« CAPO 4 » écrit à la verticale, dans les exports de certains sites).
  if (options.band) for (let y = 20; y < 210; y++) for (let x = 0; x < 50; x++) img.data[y * W + x] = 205;
  for (let s = 1; s <= 6; s++) {
    const y = lineY(s);
    const cuts = notes.filter((n) => n[0] === s).map((n) => px(n[1]));
    for (let x = 80; x <= 860; x++) {
      if (cuts.some((c) => Math.abs(x - c) <= 14)) continue;
      img.data[y * W + x] = 150;
      img.data[(y + 1) * W + x] = 150;
    }
  }
  const bars = [860, ...(options.bar !== undefined ? [px(options.bar)] : [])];
  for (const bx of bars) for (let y = lineY(1); y <= lineY(6); y++) for (let x = bx; x < bx + 3; x++) img.data[y * W + x] = 140;
  for (const [s, k, fret] of notes) {
    const text = String(fret);
    [...text].forEach((ch, i) => drawDigit(img, ch, px(k) + (i - (text.length - 1) / 2) * 15, lineY(s)));
  }
  return img;
}

/** Cases lues sur chaque corde, avec leur colonne. */
const frets = (rows: Array<{ text: string }>) => rows.map((r) => [...r.text.matchAll(/\d+/g)].map((m) => `${m.index}:${m[0]}`));

describe('Tablature dessinée en image', () => {
  const notes: Array<[number, number, number]> = [
    [6, 0, 3],
    [4, 1, 0],
    [3, 2, 2],
    [2, 3, 1],
    [1, 4, 0],
    [1, 6, 3],
    [2, 6, 1],
    [3, 6, 0],
    [5, 8, 12],
    [1, 8, 10],
    [4, 10, 7],
  ];

  it('cordes, cases et accords retrouvés, une ligne de texte par corde', () => {
    const rows = drawnTabRows(drawnTab(notes), 0);
    expect(rows).toHaveLength(6);
    const read = frets(rows);
    // Chaque corde, dans l'ordre.
    expect(read.map((r) => r.map((x) => x.split(':')[1]))).toEqual([['0', '3', '10'], ['1', '1'], ['2', '0'], ['0', '7'], ['12'], ['3']]);
    // Notes jouées ensemble : même colonne.
    const col = (s: number, i: number) => Number((read[s - 1]?.[i] ?? '').split(':')[0]);
    expect(col(1, 1)).toBe(col(2, 1));
    expect(col(2, 1)).toBe(col(3, 1));
    expect(col(1, 2)).toBe(col(5, 0));
    // Dans l'ordre du temps d'une corde à l'autre.
    expect(col(6, 0)).toBeLessThan(col(4, 0));
    expect(col(4, 0)).toBeLessThan(col(3, 0));
    // Espacement à peu près proportionnel.
    expect(col(1, 2) - col(1, 1)).toBeGreaterThan(col(2, 0) - col(3, 0));
  });

  it('barre au milieu : mesure ; barres de début et de fin ignorées', () => {
    const rows = drawnTabRows(drawnTab(notes, { bar: 7 }), 0);
    const bars = rows.map((r) => [...r.text.slice(1, -1)].flatMap((c, i) => (c === '|' ? [i] : [])));
    expect(new Set(bars.map((b) => b.join(','))).size).toBe(1);
    expect(bars[0]).toHaveLength(1);
    const read = readAsciiTab(
      rows.map((r) => ({ ...r })),
      [],
    );
    expect(read?.bars).toBe(true);
    expect(read?.notes).toBe(notes.length);
  });

  it('bandeau grisé à gauche : les cordes commencent après', () => {
    const plain = frets(drawnTabRows(drawnTab(notes), 0));
    expect(frets(drawnTabRows(drawnTab(notes, { band: true }), 0))).toEqual(plain);
  });

  it('pas de portée dans une image quelconque', () => {
    const noise: GrayImage = { width: 300, height: 200, data: Uint8Array.from({ length: 60000 }, (_, i) => ((i * 7919) % 256 > 128 ? 30 : 230)) };
    expect(drawnTabRows(noise, 0)).toEqual([]);
    const blank: GrayImage = { width: 300, height: 200, data: new Uint8Array(60000).fill(255) };
    expect(drawnTabRows(blank, 0)).toEqual([]);
  });

  it('lue par le lecteur de tablatures : cordes standard, capodastre écrit sur la page', () => {
    const rows = drawnTabRows(drawnTab(notes), 0, { x0: 40, y0: 100, x1: 560, y1: 260 });
    const read = readAsciiTab(rows, [{ text: 'STANDARD TUN CAPO FRET 4', x: 40, x1: 300, y: 60, size: 12, page: 0 }]);
    const part = read?.score.parts[0];
    expect(part?.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(part?.capo).toBe(4);
    expect(read?.notes).toBe(notes.length);
  });
});
