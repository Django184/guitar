/**
 * Partition reconnue, indépendante du PDF : parties, mesures, voix, accords et silences.
 * Les durées sont en noires, sous forme de fractions exactes (numérateur / dénominateur).
 */

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export const STEPS: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

export type NoteType = 'breve' | 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd' | '64th' | '128th';

export interface Clef {
  sign: 'G' | 'F' | 'C' | 'percussion' | 'TAB';
  /** Ligne de la clé (1 = ligne du bas). */
  line: number;
  octave: number;
}

export interface Pitch {
  step: Step;
  alter: number;
  octave: number;
}

export interface RecNote {
  pitch: Pitch;
  tieStart?: boolean;
  tieStop?: boolean;
  /** Corde (1 = la plus aiguë) et case, lues sur une tablature. */
  string?: number;
  fret?: number;
}

export interface Tuplet {
  actual: number;
  normal: number;
  start?: boolean;
  stop?: boolean;
}

export interface RecEvent {
  /** Début dans la mesure, en noires. */
  onset: number;
  /** Durée réelle, en noires (n-olets compris). */
  duration: number;
  type: NoteType;
  dots: number;
  /** Vide pour un silence. */
  notes: RecNote[];
  measureRest?: boolean;
  tuplet?: Tuplet;
  stem?: 'up' | 'down';
  voice: number;
  /** Portée dans la partie (1, 2…). */
  staff: number;
}

export interface RecMeasure {
  number: number;
  /** Changements (ou première valeur) dans cette mesure. */
  time?: { beats: number; beatType: number; symbol?: 'common' | 'cut' };
  /** Armure par portée (index 0 = portée 1). */
  key?: number;
  clefs?: Array<Clef | undefined>;
  events: RecEvent[];
  repeatStart?: boolean;
  repeatEnd?: boolean;
  barStyle?: 'double' | 'final';
}

export interface RecPart {
  name: string;
  staves: number;
  measures: RecMeasure[];
  /** Accordage (MIDI, corde 1 = la plus aiguë) quand la partie a une tablature. */
  tuning?: number[];
  capo?: number;
}

export interface RecScore {
  title: string;
  composer: string;
  tempo: number | null;
  parts: RecPart[];
}

/** Durée d'une figure, en noires. */
export const TYPE_QUARTERS: Record<NoteType, number> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
};

export function typeFromQuarters(q: number): NoteType | null {
  for (const [type, value] of Object.entries(TYPE_QUARTERS)) if (Math.abs(value - q) < 1e-9) return type as NoteType;
  return null;
}

export function dottedQuarters(type: NoteType, dots: number): number {
  const base = TYPE_QUARTERS[type];
  let total = base;
  let add = base / 2;
  for (let i = 0; i < dots; i++) {
    total += add;
    add /= 2;
  }
  return total;
}

const MIDI_STEP: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchToMidi(p: Pitch): number {
  return (p.octave + 1) * 12 + MIDI_STEP[p.step] + p.alter;
}

/** Index diatonique : do0 = 0, ré0 = 1… */
export function diatonicIndex(p: { step: Step; octave: number }): number {
  return p.octave * 7 + STEPS.indexOf(p.step);
}

export function fromDiatonic(index: number): { step: Step; octave: number } {
  const octave = Math.floor(index / 7);
  return { step: STEPS[index - octave * 7] as Step, octave };
}
