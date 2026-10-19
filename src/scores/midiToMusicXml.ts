/**
 * Conversion MIDI → MusicXML, pour qu'alphaTab affiche et joue un fichier MIDI.
 *
 * Le MIDI décrit des sons, pas une partition : il faut deviner le rythme écrit.
 * On quantifie à la double croche, chaque piste devient une voix unique
 * (les notes qui commencent ensemble forment un accord, une note s'arrête au
 * plus tard au début de la suivante) et les durées sont découpées en figures
 * liées. Les pistes jouables à la guitare reçoivent une tablature.
 * Le résultat est lisible mais approximatif : triolets et voix multiples
 * ne sont pas reconstitués.
 */
import { Fretter, STANDARD_TUNING, playableRatio, type FretPosition } from './fretting';
import type { MidiPart, MidiSong } from './midi';

/** Divisions par noire : l'unité de durée est la double croche. */
const DIVISIONS = 4;
const MAX_PARTS = 16;
const MAX_MEASURES = 2000;
/** Part minimale de notes jouables pour générer une tablature. */
const TAB_THRESHOLD = 0.9;

interface NoteValue {
  units: number;
  type: string;
  dot: boolean;
}

const NOTE_VALUES: readonly NoteValue[] = [
  { units: 16, type: 'whole', dot: false },
  { units: 12, type: 'half', dot: true },
  { units: 8, type: 'half', dot: false },
  { units: 6, type: 'quarter', dot: true },
  { units: 4, type: 'quarter', dot: false },
  { units: 3, type: 'eighth', dot: true },
  { units: 2, type: 'eighth', dot: false },
  { units: 1, type: '16th', dot: false },
];

/** Découpe une durée (en doubles croches) en figures, de la plus longue à la plus courte. */
export function splitDuration(units: number): NoteValue[] {
  const parts: NoteValue[] = [];
  let rest = Math.max(0, Math.round(units));
  while (rest > 0) {
    const value = NOTE_VALUES.find((v) => v.units <= rest) as NoteValue;
    parts.push(value);
    rest -= value.units;
  }
  return parts;
}

export interface QuantizedEvent {
  start: number;
  length: number;
  pitches: number[];
}

/** Quantifie une piste en une suite d'accords sans chevauchement. */
export function quantizePart(part: MidiPart, ppq: number): QuantizedEvent[] {
  const unit = ppq / DIVISIONS;
  const groups = new Map<number, { pitches: Set<number>; end: number }>();
  for (const note of part.notes) {
    const start = Math.round(note.tick / unit);
    const end = Math.max(start + 1, Math.round((note.tick + note.duration) / unit));
    const group = groups.get(start) ?? { pitches: new Set<number>(), end };
    group.pitches.add(note.pitch);
    group.end = Math.max(group.end, end);
    groups.set(start, group);
  }
  const starts = [...groups.keys()].sort((a, b) => a - b);
  return starts.map((start, i) => {
    const group = groups.get(start) as { pitches: Set<number>; end: number };
    const next = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    return {
      start,
      length: Math.max(1, Math.min(group.end, next) - start),
      pitches: [...group.pitches].sort((a, b) => a - b),
    };
  });
}

const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const;
const ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0] as const;

function pitchXml(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const alter = ALTERS[pc] ? `<alter>${ALTERS[pc]}</alter>` : '';
  return `<pitch><step>${STEPS[pc]}</step>${alter}<octave>${octave}</octave></pitch>`;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Caractères de contrôle interdits en XML 1.0.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

interface Piece {
  start: number;
  length: number;
  pitches: number[];
  frets: Array<FretPosition | null> | null;
  tieStop: boolean;
  tieStart: boolean;
}

function noteXml(piece: Piece, value: NoteValue, tieStop: boolean, tieStart: boolean, stringCount: number): string {
  const typeXml = `<type>${value.type}</type>${value.dot ? '<dot/>' : ''}`;
  if (piece.pitches.length === 0) {
    return `<note><rest/><duration>${value.units}</duration><voice>1</voice>${typeXml}</note>`;
  }
  return piece.pitches
    .map((pitch, i) => {
      const fret = piece.frets?.[i] ?? null;
      const ties = `${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}`;
      const notations = [
        tieStop ? '<tied type="stop"/>' : '',
        tieStart ? '<tied type="start"/>' : '',
        fret ? `<technical><string>${stringCount - fret.string}</string><fret>${fret.fret}</fret></technical>` : '',
      ].join('');
      return (
        `<note>${i > 0 ? '<chord/>' : ''}${pitchXml(pitch)}<duration>${value.units}</duration>${ties}` +
        `<voice>1</voice>${typeXml}${notations ? `<notations>${notations}</notations>` : ''}</note>`
      );
    })
    .join('');
}

function measureBodies(
  events: QuantizedEvent[],
  frets: Array<Array<FretPosition | null>> | null,
  measureUnits: number,
  measureCount: number,
  stringCount: number,
): string[] {
  // 1. Pièces : notes et silences découpés aux barres de mesure.
  const pieces: Piece[] = [];
  let cursor = 0;
  const pushSplit = (start: number, length: number, pitches: number[], fretList: Array<FretPosition | null> | null): void => {
    let position = start;
    const end = start + length;
    while (position < end) {
      const barEnd = (Math.floor(position / measureUnits) + 1) * measureUnits;
      const pieceEnd = Math.min(end, barEnd);
      pieces.push({
        start: position,
        length: pieceEnd - position,
        pitches,
        frets: fretList,
        tieStop: pitches.length > 0 && position > start,
        tieStart: pitches.length > 0 && pieceEnd < end,
      });
      position = pieceEnd;
    }
  };
  events.forEach((event, i) => {
    if (event.start >= measureUnits * measureCount) return;
    if (event.start > cursor) pushSplit(cursor, event.start - cursor, [], null);
    const length = Math.min(event.length, measureUnits * measureCount - event.start);
    pushSplit(event.start, length, event.pitches, frets?.[i] ?? null);
    cursor = event.start + length;
  });
  if (cursor < measureUnits * measureCount) pushSplit(cursor, measureUnits * measureCount - cursor, [], null);

  // 2. Répartition par mesure, durées découpées en figures liées.
  const bodies: string[] = Array.from({ length: measureCount }, () => '');
  const restOnly: boolean[] = Array.from({ length: measureCount }, () => true);
  for (const piece of pieces) {
    const index = Math.floor(piece.start / measureUnits);
    if (piece.pitches.length > 0) restOnly[index] = false;
    const values = splitDuration(piece.length);
    bodies[index] += values
      .map((value, i) =>
        noteXml(
          piece,
          value,
          piece.pitches.length > 0 && (i > 0 || piece.tieStop),
          piece.pitches.length > 0 && (i < values.length - 1 || piece.tieStart),
          stringCount,
        ),
      )
      .join('');
  }
  return bodies.map((body, i) =>
    restOnly[i] ? `<note><rest measure="yes"/><duration>${measureUnits}</duration><voice>1</voice></note>` : body,
  );
}

function tuningXml(tuning: readonly number[]): string {
  const lines = tuning
    .map((midi, i) => {
      const pc = midi % 12;
      const alter = ALTERS[pc] ? `<tuning-alter>${ALTERS[pc]}</tuning-alter>` : '';
      return `<staff-tuning line="${i + 1}"><tuning-step>${STEPS[pc]}</tuning-step>${alter}<tuning-octave>${Math.floor(midi / 12) - 1}</tuning-octave></staff-tuning>`;
    })
    .join('');
  return `<staff-details><staff-lines>${tuning.length}</staff-lines>${lines}</staff-details>`;
}

export interface MusicXmlConversion {
  xml: string;
  partCount: number;
  tabPartCount: number;
}

/** Transforme un morceau MIDI analysé en document MusicXML (partwise). */
export function midiToMusicXml(song: MidiSong, title: string): MusicXmlConversion {
  let { beats, beatType } = song.timeSignature;
  let measureUnits = (beats * 16) / beatType;
  if (!Number.isInteger(measureUnits) || measureUnits < 1) {
    beats = 4;
    beatType = 4;
    measureUnits = 16;
  }

  const parts = song.parts.slice(0, MAX_PARTS).map((part) => ({ part, events: quantizePart(part, song.ppq) }));
  const totalUnits = Math.max(1, ...parts.map(({ events }) => {
    const last = events[events.length - 1];
    return last ? last.start + last.length : 0;
  }));
  const measureCount = Math.min(MAX_MEASURES, Math.max(1, Math.ceil(totalUnits / measureUnits)));

  let tabPartCount = 0;
  const partList: string[] = [];
  const partBodies: string[] = [];

  parts.forEach(({ part, events }, index) => {
    const id = `P${index + 1}`;
    const allPitches = events.flatMap((e) => e.pitches);
    const withTab = playableRatio(allPitches) >= TAB_THRESHOLD;
    let frets: Array<Array<FretPosition | null>> | null = null;
    if (withTab) {
      tabPartCount += 1;
      const fretter = new Fretter(STANDARD_TUNING);
      frets = events.map((e) => fretter.assign(e.pitches));
    }

    const sorted = [...allPitches].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 60;
    const clef = withTab
      ? '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>'
      : median >= 60
        ? '<clef><sign>G</sign><line>2</line></clef>'
        : '<clef><sign>F</sign><line>4</line></clef>';

    const program = part.program >= 0 ? part.program + 1 : withTab ? 25 : 1;
    const channel = index >= 9 ? index + 2 : index + 1; // le canal 10 est réservé aux percussions
    partList.push(
      `<score-part id="${id}"><part-name>${escapeXml(part.name)}</part-name>` +
        `<score-instrument id="${id}-I1"><instrument-name>${escapeXml(part.name)}</instrument-name></score-instrument>` +
        `<midi-instrument id="${id}-I1"><midi-channel>${Math.min(16, channel)}</midi-channel><midi-program>${program}</midi-program></midi-instrument>` +
        `</score-part>`,
    );

    const bodies = measureBodies(events, frets, measureUnits, measureCount, STANDARD_TUNING.length);
    const attributes =
      `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>0</fifths></key>` +
      `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>${clef}` +
      `${withTab ? tuningXml(STANDARD_TUNING) : ''}</attributes>`;
    const tempo =
      index === 0
        ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${song.tempo}</per-minute></metronome></direction-type><sound tempo="${song.tempo}"/></direction>`
        : '';
    const measures = bodies
      .map((body, m) => `<measure number="${m + 1}">${m === 0 ? attributes + tempo : ''}${body}</measure>`)
      .join('');
    partBodies.push(`<part id="${id}">${measures}</part>`);
  });

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="4.0">' +
    `<work><work-title>${escapeXml(title)}</work-title></work>` +
    '<identification><encoding><software>Pratique Guitare (conversion MIDI)</software></encoding></identification>' +
    `<part-list>${partList.join('')}</part-list>` +
    partBodies.join('') +
    '</score-partwise>';

  return { xml, partCount: parts.length, tabPartCount };
}
