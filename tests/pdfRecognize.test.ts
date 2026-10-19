import { describe, expect, it } from 'vitest';
import { pitchToMidi, type RecEvent } from '../src/scores/pdf/model';
import { toMusicXml } from '../src/scores/pdf/musicxml';
import { recognize } from '../src/scores/pdf/recognize';
import { inferDurations, newEvent } from '../src/scores/pdf/rhythm';
import { textLines, tuningFromText } from '../src/scores/pdf/tab';
import type { Glyph, PageData, PathItem, Point } from '../src/scores/pdf/types';

/* Pages synthétiques : ce qu'extrait pdf.js d'un PDF exporté par un logiciel de partition. */

const SP = 6; // interligne en points
const SMUFL = 4 * SP; // corps d'une police SMuFL : 1 em = 4 interlignes

function line(x0: number, y0: number, x1: number, y1: number, width = 0.6): PathItem {
  const pts: Point[] = [
    { x: x0, y: y0 },
    { x: x1, y: y1 },
  ];
  return { kind: 'stroke', lineWidth: width, subpaths: [pts], hasCurve: false, box: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) } };
}

function quad(x0: number, x1: number, top0: number, top1: number, thickness: number): PathItem {
  const pts: Point[] = [
    { x: x0, y: top0 },
    { x: x1, y: top1 },
    { x: x1, y: top1 + thickness },
    { x: x0, y: top0 + thickness },
    { x: x0, y: top0 },
  ];
  return { kind: 'fill', lineWidth: 0, subpaths: [pts], hasCurve: false, box: { x0, y0: Math.min(top0, top1), x1, y1: Math.max(top0, top1) + thickness } };
}

function music(cp: number, x: number, y: number, width = 1.18 * SP): Glyph {
  return { text: String.fromCodePoint(cp), cp, font: 'Bravura', x, y, size: SMUFL, width };
}

function text(t: string, x: number, y: number, size = 7, font = 'Helvetica'): Glyph[] {
  return [...t].map((c, i) => ({ text: c, cp: c.codePointAt(0) ?? 0, font, x: x + i * size * 0.55, y, size, width: size * 0.55 }));
}

function page(glyphs: Glyph[], paths: PathItem[]): PageData {
  return { index: 0, width: 400, height: 300, glyphs, paths, imageArea: 0 };
}

function staff(top: number, x0: number, x1: number, lines = 5, sp = SP): PathItem[] {
  return Array.from({ length: lines }, (_, i) => line(x0, top + i * sp, x1, top + i * sp));
}

const midis = (events: RecEvent[]): number[][] =>
  [...events].sort((a, b) => a.onset - b.onset).map((e) => e.notes.map((n) => pitchToMidi(n.pitch)).sort((a, b) => a - b));

describe('Lecture d’une portée de notation (police SMuFL)', () => {
  // Portée : lignes y = 100…124 ; ligne du bas (mi 4) = 124, sol 4 = 118.
  const top = 100;
  const bottom = top + 4 * SP;
  const yOf = (step: number): number => bottom - (step * SP) / 2; // 0 = ligne du bas (mi 4)
  const glyphs: Glyph[] = [
    ...text('Petite étude', 140, 40, 16, 'Times-Bold'),
    music(0xe050, 22, yOf(2), 2.7 * SP), // clé de sol sur la 2e ligne
    music(0xe084, 42, top + SP, 1.7 * SP), // 4
    music(0xe084, 42, top + 3 * SP, 1.7 * SP), // 4
  ];
  const paths: PathItem[] = [...staff(top, 20, 330)];
  const head = (x: number, step: number, cp = 0xe0a4): void => {
    glyphs.push(music(cp, x, yOf(step)));
  };
  const stemUp = (x: number, step: number): PathItem => line(x + 1.18 * SP, yOf(step) - 0.2 * SP, x + 1.18 * SP, yOf(step) - 3.5 * SP, 0.7);
  const stemDown = (x: number, step: number): PathItem => line(x, yOf(step) + 0.2 * SP, x, yOf(step) + 3.5 * SP, 0.7);

  // Mesure 1 : do 5 (noire, hampe en bas), mi 4 (noire), sol 4 – la 4 (croches liées), soupir.
  head(70, 5);
  paths.push(stemDown(70, 5));
  head(100, 0);
  paths.push(stemUp(100, 0));
  head(130, 2);
  head(150, 3);
  paths.push(stemUp(130, 2), stemUp(150, 3));
  paths.push(quad(130 + 1.18 * SP, 150 + 1.18 * SP, yOf(2) - 3.5 * SP, yOf(3) - 3.5 * SP, 0.5 * SP));
  glyphs.push(music(0xe4e5, 175, yOf(4), 1.1 * SP));
  paths.push(line(200, top, 200, bottom, 0.9));
  // Mesure 2 : ronde fa dièse 4.
  glyphs.push(music(0xe262, 225, yOf(1), 1 * SP));
  head(235, 1, 0xe0a2);
  paths.push(line(330, top, 330, bottom, 0.9));

  const { score, stats } = recognize([page(glyphs, paths)]);

  it('structure : une partie, deux mesures en 4/4, titre', () => {
    expect(score.title).toBe('Petite étude');
    expect(score.parts).toHaveLength(1);
    const part = score.parts[0];
    expect(part?.measures).toHaveLength(2);
    expect(part?.measures[0]?.time).toEqual({ beats: 4, beatType: 4 });
    expect(stats.irregular).toBe(0);
  });

  it('hauteurs, durées et altérations', () => {
    const [m1, m2] = score.parts[0]?.measures ?? [];
    expect(midis(m1?.events ?? [])).toEqual([[72], [64], [67], [69], []]);
    expect((m1?.events ?? []).map((e) => e.duration)).toEqual([1, 1, 0.5, 0.5, 1]);
    expect(midis(m2?.events ?? [])).toEqual([[66]]);
    expect(m2?.events[0]?.duration).toBe(4);
  });

  it('MusicXML : divisions, chiffrage, clé, notes', () => {
    const xml = toMusicXml(score);
    expect(xml).toContain('<work-title>Petite étude</work-title>');
    expect(xml).toContain('<time><beats>4</beats><beat-type>4</beat-type></time>');
    expect(xml).toContain('<sign>G</sign><line>2</line>');
    expect(xml).toContain('<step>F</step><alter>1</alter><octave>4</octave>');
    expect(xml.match(/<note>/g)).toHaveLength(6);
    expect(xml).toContain('<rest/>');
  });
});

describe('Lecture d’une tablature sans rythme', () => {
  // Tablature 6 lignes, y = 100…130, cases en Helvetica centrées sur les lignes.
  const top = 100;
  const tsp = 6;
  const glyphs: Glyph[] = [...text('Tuning: D A D G B E', 30, 60, 8)];
  const paths: PathItem[] = [...staff(top, 20, 260, 6, tsp), line(20, top, 20, top + 5 * tsp, 0.9), line(140, top, 140, top + 5 * tsp, 0.9), line(260, top, 260, top + 5 * tsp, 0.9)];
  const fret = (x: number, string: number, value: string): void => {
    glyphs.push(...text(value, x, top + (string - 1) * tsp + 0.36 * 7));
  };
  // Mesure 1 : quatre noires régulières ; mesure 2 : une ronde (accord).
  fret(30, 6, '0');
  fret(57, 5, '2');
  fret(84, 4, '2');
  fret(111, 3, '1');
  fret(160, 6, '0');
  fret(160, 5, '0');
  fret(160, 4, '0');

  const { score } = recognize([page(glyphs, paths)]);

  it('partie de guitare avec accordage lu dans le texte (drop D)', () => {
    const part = score.parts[0];
    expect(part?.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(part?.measures).toHaveLength(2);
  });

  it('hauteurs (accordage + case) et durées déduites de l’espacement', () => {
    const [m1, m2] = score.parts[0]?.measures ?? [];
    expect(midis(m1?.events ?? [])).toEqual([[38], [47], [52], [56]]);
    expect((m1?.events ?? []).map((e) => e.duration)).toEqual([1, 1, 1, 1]);
    expect(midis(m2?.events ?? [])).toEqual([[38, 45, 50]]);
    expect(m2?.events[0]?.duration).toBe(4);
  });

  it('MusicXML : clé de tablature, accordage et cases', () => {
    const xml = toMusicXml(score);
    expect(xml).toContain('<sign>TAB</sign>');
    expect(xml).toContain('<staff-tuning line="1"><tuning-step>D</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>');
    expect(xml).toContain('<technical><string>6</string><fret>0</fret></technical>');
    expect(xml).toContain('<technical><string>3</string><fret>1</fret></technical>');
  });
});

describe('Accordage écrit', () => {
  const lines = (...texts: string[]) => texts.map((t, i) => ({ text: t, x: 0, x1: t.length * 4, y: i * 10, size: 8, page: 0 }));
  it('chiffres cerclés', () => {
    expect(tuningFromText(lines('① = D  ④ = C', '② = A  ⑤ = G', '③ = F  ⑥ = D'), 6)?.tuning).toEqual([62, 57, 53, 48, 43, 38]);
  });
  it('suite de notes, accordages nommés, décalages et capodastre', () => {
    expect(tuningFromText(lines('Tuning D-A-D-G-B-D, Capo 4th fret'), 6)).toEqual({ tuning: [62, 59, 55, 50, 45, 38], capo: 4 });
    expect(tuningFromText(lines('Accordage : DADGAD'), 6)?.tuning).toEqual([62, 57, 55, 50, 45, 38]);
    expect(tuningFromText(lines('Drop D'), 6)?.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(tuningFromText(lines('Tune down 1/2 step'), 6)?.tuning).toEqual([63, 58, 54, 49, 44, 39]);
    expect(tuningFromText(lines('Guitar Tune down 1 step'), 6)?.tuning).toEqual([62, 57, 53, 48, 43, 38]);
    expect(tuningFromText(lines('Allegro moderato'), 6)).toBeNull();
  });
  it('lignes de texte : glyphes regroupés, blancs rétablis', () => {
    const glyphs = text('Capo 2', 10, 20, 8);
    glyphs.splice(4, 1); // l'espace n'est pas un glyphe dessiné
    expect(textLines(glyphs, 0).map((l) => l.text)).toEqual(['Capo 2']);
  });
});

describe('Durées déduites de l’espacement', () => {
  const ev = (x: number) => newEvent('chord', x, x + 5, 0, 'quarter');
  it('blanche puis deux noires (espace proportionnel à la durée^0,6)', () => {
    const events = [ev(0), ev(30), ev(50)];
    inferDurations(events, 70, 4);
    expect(events.map((e) => e.duration)).toEqual([2, 1, 1]);
  });
  it('une seule colonne : toute la mesure', () => {
    const events = [ev(10)];
    inferDurations(events, 90, 3);
    expect(events[0]?.duration).toBe(3);
    expect(events[0]?.type).toBe('half');
    expect(events[0]?.dots).toBe(1);
  });
});
