/**
 * Écriture MusicXML (partwise 4.0) d'une partition reconnue.
 */
import type { Clef, RecEvent, RecMeasure, RecPart, RecScore } from './model';

/** Divisions par noire : divisible par 2⁵, 3², 5 et 7 (n-olets usuels). */
export const DIVISIONS = 10080;

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function divs(quarters: number): number {
  return Math.max(0, Math.round(quarters * DIVISIONS));
}

function clefXml(clef: Clef, number: number | null): string {
  const n = number === null ? '' : ` number="${number}"`;
  const octave = clef.octave ? `<clef-octave-change>${clef.octave}</clef-octave-change>` : '';
  if (clef.sign === 'percussion') return `<clef${n}><sign>percussion</sign></clef>`;
  if (clef.sign === 'TAB') return `<clef${n}><sign>TAB</sign><line>5</line></clef>`;
  return `<clef${n}><sign>${clef.sign}</sign><line>${clef.line}</line>${octave}</clef>`;
}

const PC_STEP = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const PC_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

/** Accordage : MusicXML numérote les lignes depuis le bas (corde la plus grave). */
function staffDetails(tuning: number[], capo: number): string {
  const lines = tuning
    .map((midi, i) => {
      const pc = ((midi % 12) + 12) % 12;
      const alter = PC_ALTER[pc] ? `<tuning-alter>${PC_ALTER[pc]}</tuning-alter>` : '';
      return `<staff-tuning line="${tuning.length - i}"><tuning-step>${PC_STEP[pc]}</tuning-step>${alter}<tuning-octave>${Math.floor(midi / 12) - 1}</tuning-octave></staff-tuning>`;
    })
    .reverse()
    .join('');
  return `<staff-details><staff-lines>${tuning.length}</staff-lines>${lines}${capo ? `<capo>${capo}</capo>` : ''}</staff-details>`;
}

function noteXml(e: RecEvent, staves: number, durationDivs: number): string[] {
  const out: string[] = [];
  const common = (chord: boolean, body: string, tie: { start?: boolean; stop?: boolean }, notations: string[]): string => {
    const parts = ['<note>'];
    if (chord) parts.push('<chord/>');
    parts.push(body);
    parts.push(`<duration>${durationDivs}</duration>`);
    if (tie.stop) parts.push('<tie type="stop"/>');
    if (tie.start) parts.push('<tie type="start"/>');
    parts.push(`<voice>${e.voice}</voice>`);
    if (!e.measureRest) {
      parts.push(`<type>${e.type}</type>`);
      for (let i = 0; i < e.dots; i++) parts.push('<dot/>');
    }
    if (e.tuplet) {
      parts.push(`<time-modification><actual-notes>${e.tuplet.actual}</actual-notes><normal-notes>${e.tuplet.normal}</normal-notes></time-modification>`);
    }
    if (e.stem && e.notes.length) parts.push(`<stem>${e.stem}</stem>`);
    if (staves > 1) parts.push(`<staff>${e.staff}</staff>`);
    if (notations.length) parts.push(`<notations>${notations.join('')}</notations>`);
    parts.push('</note>');
    return parts.join('');
  };
  const tupletNotations = (first: boolean): string[] => {
    if (!e.tuplet || !first) return [];
    const n: string[] = [];
    if (e.tuplet.start) n.push('<tuplet type="start"/>');
    if (e.tuplet.stop) n.push('<tuplet type="stop"/>');
    return n;
  };
  if (!e.notes.length) {
    out.push(common(false, e.measureRest ? '<rest measure="yes"/>' : '<rest/>', {}, tupletNotations(true)));
    return out;
  }
  e.notes.forEach((note, i) => {
    const p = note.pitch;
    const alter = p.alter ? `<alter>${p.alter}</alter>` : '';
    const notations = tupletNotations(i === 0);
    if (note.tieStop) notations.push('<tied type="stop"/>');
    if (note.tieStart) notations.push('<tied type="start"/>');
    if (note.string !== undefined && note.fret !== undefined) {
      notations.push(`<technical><string>${note.string}</string><fret>${note.fret}</fret></technical>`);
    }
    out.push(
      common(i > 0, `<pitch><step>${p.step}</step>${alter}<octave>${p.octave}</octave></pitch>`, { start: note.tieStart, stop: note.tieStop }, notations),
    );
  });
  return out;
}

function measureXml(m: RecMeasure, part: RecPart, first: boolean): string {
  const out: string[] = [`<measure number="${m.number}">`];
  if (m.repeatStart) out.push('<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>');
  const attrs: string[] = [];
  if (first) attrs.push(`<divisions>${DIVISIONS}</divisions>`);
  if (m.key !== undefined || first) attrs.push(`<key><fifths>${m.key ?? 0}</fifths></key>`);
  if (m.time) {
    const symbol = m.time.symbol ? ` symbol="${m.time.symbol}"` : '';
    attrs.push(`<time${symbol}><beats>${m.time.beats}</beats><beat-type>${m.time.beatType}</beat-type></time>`);
  }
  if (first && part.staves > 1) attrs.push(`<staves>${part.staves}</staves>`);
  if (m.clefs) {
    m.clefs.forEach((clef, i) => {
      if (clef) attrs.push(clefXml(clef, part.staves > 1 ? i + 1 : null));
    });
  } else if (first) {
    for (let i = 0; i < part.staves; i++) attrs.push(clefXml({ sign: 'G', line: 2, octave: 0 }, part.staves > 1 ? i + 1 : null));
  }
  if (first && part.tuning) attrs.push(staffDetails(part.tuning, part.capo ?? 0));
  if (attrs.length) out.push(`<attributes>${attrs.join('')}</attributes>`);

  // Une voix après l'autre, avec retour en arrière (backup) entre elles.
  const voices = [...new Set(m.events.map((e) => e.voice))].sort((a, b) => a - b);
  let cursor = 0;
  for (const voice of voices) {
    const events = m.events.filter((e) => e.voice === voice).sort((a, b) => a.onset - b.onset);
    for (const e of events) {
      const start = divs(e.onset);
      if (start < cursor) {
        out.push(`<backup><duration>${cursor - start}</duration></backup>`);
        cursor = start;
      } else if (start > cursor) {
        out.push(`<forward><duration>${start - cursor}</duration><voice>${voice}</voice>${part.staves > 1 ? `<staff>${e.staff}</staff>` : ''}</forward>`);
        cursor = start;
      }
      const d = divs(e.duration);
      out.push(...noteXml(e, part.staves, d));
      cursor += d;
    }
  }
  if (m.repeatEnd) out.push('<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>');
  else if (m.barStyle === 'final') out.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
  else if (m.barStyle === 'double') out.push('<barline location="right"><bar-style>light-light</bar-style></barline>');
  out.push('</measure>');
  return out.join('');
}

export function toMusicXml(score: RecScore): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
  ];
  if (score.title) out.push(`<work><work-title>${esc(score.title)}</work-title></work>`);
  out.push('<identification>');
  if (score.composer) out.push(`<creator type="composer">${esc(score.composer)}</creator>`);
  out.push('<encoding><software>Guitare — import PDF</software></encoding></identification>');
  out.push('<part-list>');
  score.parts.forEach((p, i) => out.push(`<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`));
  out.push('</part-list>');
  score.parts.forEach((part, i) => {
    out.push(`<part id="P${i + 1}">`);
    part.measures.forEach((m, j) => {
      let xml = measureXml(m, part, j === 0);
      if (j === 0 && score.tempo) {
        xml = xml.replace(
          /(<\/attributes>|<measure number="\d+">)/,
          `$1<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`,
        );
      }
      out.push(xml);
    });
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
