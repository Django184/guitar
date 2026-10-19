/**
 * Ajoute une tablature à un MusicXML qui n'en contient pas (partition issue d'un
 * PDF converti, export sans tablature). Pour chaque partie jouable à la guitare,
 * on déclare l'accordage standard et on place chaque note sur une corde et une
 * case. Un fichier qui contient déjà une tablature n'est pas modifié.
 */
import { Fretter, STANDARD_TUNING, playableRatio, type FretPosition } from './fretting';

const TAB_THRESHOLD = 0.9;
const STEP_VALUES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const;
const ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0] as const;

export interface TabifyResult {
  xml: string;
  /** Nombre de parties qui ont reçu une tablature. */
  tabbedParts: number;
}

const child = (el: Element, name: string): Element | null => {
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
};
const children = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const text = (el: Element | null): string => el?.textContent?.trim() ?? '';

/** Hauteur MIDI écrite d'une note (élément <pitch>), ou null pour un silence ou une percussion. */
function writtenPitch(note: Element): number | null {
  const pitch = child(note, 'pitch');
  if (!pitch) return null;
  const step = STEP_VALUES[text(child(pitch, 'step')).toUpperCase()];
  const octave = Number.parseInt(text(child(pitch, 'octave')), 10);
  const alter = Number.parseFloat(text(child(pitch, 'alter')) || '0');
  if (step === undefined || Number.isNaN(octave)) return null;
  return (octave + 1) * 12 + step + Math.round(alter);
}

/** Transposition écrit → réel déclarée par la partie (ex. guitare : une octave plus bas). */
function partTransposition(part: Element): number {
  for (const measure of children(part, 'measure')) {
    for (const attributes of children(measure, 'attributes')) {
      const transpose = child(attributes, 'transpose');
      if (transpose) {
        const chromatic = Number.parseFloat(text(child(transpose, 'chromatic')) || '0');
        const octaves = Number.parseFloat(text(child(transpose, 'octave-change')) || '0');
        return Math.round(chromatic + octaves * 12);
      }
    }
  }
  return 0;
}

function hasMultipleStavesOrPercussion(part: Element): boolean {
  for (const measure of children(part, 'measure')) {
    for (const attributes of children(measure, 'attributes')) {
      if (Number.parseInt(text(child(attributes, 'staves')) || '1', 10) > 1) return true;
      for (const clef of children(attributes, 'clef')) {
        const sign = text(child(clef, 'sign')).toLowerCase();
        if (sign === 'percussion' || sign === 'tab') return true;
      }
    }
  }
  return false;
}

function append(doc: XMLDocument, parent: Element, name: string, value?: string): Element {
  const el = doc.createElementNS(parent.namespaceURI, name);
  if (value !== undefined) el.textContent = value;
  parent.appendChild(el);
  return el;
}

function staffDetails(doc: XMLDocument, parent: Element): Element {
  const details = doc.createElementNS(parent.namespaceURI, 'staff-details');
  append(doc, details, 'staff-lines', String(STANDARD_TUNING.length));
  STANDARD_TUNING.forEach((midi, i) => {
    const tuning = append(doc, details, 'staff-tuning');
    tuning.setAttribute('line', String(i + 1));
    const pc = midi % 12;
    append(doc, tuning, 'tuning-step', STEPS[pc]);
    if (ALTERS[pc]) append(doc, tuning, 'tuning-alter', String(ALTERS[pc]));
    append(doc, tuning, 'tuning-octave', String(Math.floor(midi / 12) - 1));
  });
  return details;
}

/** Insère <staff-details> dans les premiers <attributes> de la partie, après la clé. */
function declareTuning(doc: XMLDocument, part: Element): void {
  const firstMeasure = children(part, 'measure')[0];
  if (!firstMeasure) return;
  let attributes = child(firstMeasure, 'attributes');
  if (!attributes) {
    attributes = doc.createElementNS(part.namespaceURI, 'attributes');
    firstMeasure.insertBefore(attributes, firstMeasure.firstElementChild);
  }
  const details = staffDetails(doc, attributes);
  const anchor = Array.from(attributes.children).find((c) =>
    ['transpose', 'for-part', 'directive', 'measure-style'].includes(c.localName),
  );
  attributes.insertBefore(details, anchor ?? null);
}

function addTechnical(doc: XMLDocument, note: Element, string: number, fret: number): void {
  let notations = child(note, 'notations');
  if (!notations) {
    notations = doc.createElementNS(note.namespaceURI, 'notations');
    // Ordre MusicXML : <notations> avant <lyric>, <play>, <listen>.
    const anchor = Array.from(note.children).find((c) => ['lyric', 'play', 'listen'].includes(c.localName));
    note.insertBefore(notations, anchor ?? null);
  }
  let technical = child(notations, 'technical');
  if (!technical) technical = append(doc, notations, 'technical');
  append(doc, technical, 'string', String(string));
  append(doc, technical, 'fret', String(fret));
}

interface ChordGroup {
  notes: Element[];
  pitches: number[];
}

const hasTie = (note: Element, type: 'start' | 'stop'): boolean =>
  children(note, 'tie').some((tie) => tie.getAttribute('type') === type);

function chordGroups(part: Element, transposition: number): ChordGroup[] {
  const groups: ChordGroup[] = [];
  for (const measure of children(part, 'measure')) {
    for (const note of children(measure, 'note')) {
      const written = writtenPitch(note);
      if (written === null) continue;
      const sounding = written + transposition;
      const last = groups[groups.length - 1];
      if (child(note, 'chord') && last) {
        last.notes.push(note);
        last.pitches.push(sounding);
      } else {
        groups.push({ notes: [note], pitches: [sounding] });
      }
    }
  }
  return groups;
}

export function tabifyMusicXml(xml: string): TabifyResult {
  let doc: XMLDocument;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return { xml, tabbedParts: 0 };
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return { xml, tabbedParts: 0 };
  const root = doc.documentElement;
  if (root.localName !== 'score-partwise') return { xml, tabbedParts: 0 };
  // Tablature déjà présente : on ne touche à rien.
  if (doc.getElementsByTagName('staff-tuning').length > 0 || doc.getElementsByTagName('fret').length > 0) {
    return { xml, tabbedParts: 0 };
  }

  let tabbedParts = 0;
  for (const part of children(root, 'part')) {
    if (hasMultipleStavesOrPercussion(part)) continue;
    const groups = chordGroups(part, partTransposition(part));
    if (groups.length === 0 || playableRatio(groups.flatMap((g) => g.pitches)) < TAB_THRESHOLD) continue;

    const fretter = new Fretter(STANDARD_TUNING);
    // Une note liée à la précédente reste sur la même corde, sinon la liaison se casse.
    const pendingTies = new Map<number, FretPosition | null>();
    for (const group of groups) {
      const positions: Array<FretPosition | null> = group.notes.map(() => null);
      const fresh: number[] = [];
      group.notes.forEach((note, i) => {
        const pitch = group.pitches[i] as number;
        if (hasTie(note, 'stop') && pendingTies.has(pitch)) positions[i] = pendingTies.get(pitch) ?? null;
        else fresh.push(i);
      });
      const assigned = fretter.assign(fresh.map((i) => group.pitches[i] as number));
      fresh.forEach((noteIndex, k) => {
        positions[noteIndex] = assigned[k] ?? null;
      });

      group.notes.forEach((note, i) => {
        const pitch = group.pitches[i] as number;
        const position = positions[i] ?? null;
        if (hasTie(note, 'start')) pendingTies.set(pitch, position);
        else pendingTies.delete(pitch);
        // MusicXML numérote les cordes depuis la plus aiguë (1) ; Fretter depuis la plus grave (0).
        if (position) addTechnical(doc, note, STANDARD_TUNING.length - position.string, position.fret);
      });
    }
    declareTuning(doc, part);
    tabbedParts += 1;
  }

  if (tabbedParts === 0) return { xml, tabbedParts };
  return { xml: new XMLSerializer().serializeToString(doc), tabbedParts };
}
