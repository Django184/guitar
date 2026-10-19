/**
 * Partitions de test générées à la volée (aucun fichier tiers) :
 * une mélodie originale en MusicXML (sans tablature), sa version compressée .mxl,
 * et un fichier MIDI de guitare.
 */
import { writeMidi } from '../tests/midiWriter';
import { makeZip } from '../tests/zip';

export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const STEPS: Record<string, [string, number]> = {
  C: ['C', 0], D: ['D', 0], E: ['E', 0], F: ['F', 0], 'F#': ['F', 1], G: ['G', 0], A: ['A', 0], B: ['B', 0],
};

/** Mélodie originale en Sol majeur, 8 mesures de 4/4 (hauteurs écrites, guitare : sonne une octave plus bas). */
const MELODY: Array<[string, number, 'quarter' | 'half']> = [
  ['G', 4, 'quarter'], ['B', 4, 'quarter'], ['D', 5, 'quarter'], ['B', 4, 'quarter'],
  ['C', 5, 'quarter'], ['E', 5, 'quarter'], ['D', 5, 'half'],
  ['B', 4, 'quarter'], ['A', 4, 'quarter'], ['G', 4, 'quarter'], ['A', 4, 'quarter'],
  ['B', 4, 'half'], ['A', 4, 'half'],
  ['G', 4, 'quarter'], ['F#', 4, 'quarter'], ['E', 4, 'quarter'], ['F#', 4, 'quarter'],
  ['G', 4, 'quarter'], ['A', 4, 'quarter'], ['B', 4, 'half'],
  ['C', 5, 'quarter'], ['B', 4, 'quarter'], ['A', 4, 'quarter'], ['F#', 4, 'quarter'],
  ['G', 4, 'half'], ['G', 3, 'half'],
];

export function guitarMusicXml(title = 'Promenade en Sol'): string {
  const measures: string[] = [];
  let current = '';
  let filled = 0;
  for (const [name, octave, type] of MELODY) {
    const [step, alter] = STEPS[name] as [string, number];
    const duration = type === 'half' ? 8 : 4;
    current +=
      `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
      `<duration>${duration}</duration><voice>1</voice><type>${type}</type>${alter ? '<accidental>sharp</accidental>' : ''}</note>`;
    filled += duration;
    if (filled === 16) {
      measures.push(current);
      current = '';
      filled = 0;
    }
  }
  const attributes =
    '<attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>' +
    '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>' +
    '<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>';
  const body = measures
    .map((notes, i) => `<measure number="${i + 1}">${i === 0 ? attributes + '<sound tempo="100"/>' : ''}${notes}</measure>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' +
    `<score-partwise version="4.0"><work><work-title>${title}</work-title></work>` +
    '<part-list><score-part id="P1"><part-name>Guitare</part-name></score-part></part-list>' +
    `<part id="P1">${body}</part></score-partwise>`
  );
}

export function musicXmlFile(): UploadFile {
  return { name: 'promenade.musicxml', mimeType: 'application/vnd.recordare.musicxml+xml', buffer: Buffer.from(guitarMusicXml()) };
}

export async function mxlFile(): Promise<UploadFile> {
  const container =
    '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles>' +
    '<rootfile full-path="promenade.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
  const zip = await makeZip(
    {
      mimetype: 'application/vnd.recordare.musicxml',
      'META-INF/container.xml': container,
      'promenade.musicxml': guitarMusicXml('Promenade compressée'),
    },
    ['mimetype'],
  );
  return { name: 'promenade.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer: Buffer.from(zip) };
}

export function midiFile(): UploadFile {
  const notes = [];
  // 8 mesures : arpèges de Sol, Do, Ré, Sol (guitare), puis accords plaqués.
  const arpeggios = [
    [43, 50, 55, 59],
    [48, 52, 55, 60],
    [50, 54, 57, 62],
    [43, 47, 50, 55],
  ];
  let beat = 0;
  for (const chord of arpeggios) {
    for (const pitch of chord) notes.push({ beat: beat++, length: 1, pitch });
  }
  for (const chord of arpeggios) {
    for (const pitch of chord) notes.push({ beat, length: 4, pitch });
    beat += 4;
  }
  const bytes = writeMidi({ bpm: 100, tracks: [{ name: 'Guitare acoustique', program: 25, notes }] });
  return { name: 'arpeges.mid', mimeType: 'audio/midi', buffer: Buffer.from(bytes) };
}
