/** Notation internationale (A2 = La 2 = 110 Hz pour un diapason à 440 Hz). */
const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const SOLFEGE = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'] as const;

export const A4_MIN = 430;
export const A4_MAX = 450;
export const A4_DEFAULT = 440;

export function clampA4(value: number): number {
  return Math.min(A4_MAX, Math.max(A4_MIN, Math.round(value)));
}

export function midiToFrequency(midi: number, a4 = A4_DEFAULT): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function frequencyToMidi(frequency: number, a4 = A4_DEFAULT): number {
  return 69 + 12 * Math.log2(frequency / a4);
}

/** Écart en cents de `frequency` par rapport à `reference` (positif = trop haut). */
export function centsBetween(frequency: number, reference: number): number {
  return 1200 * Math.log2(frequency / reference);
}

export interface NoteName {
  midi: number;
  letter: string;
  octave: number;
  solfege: string;
  /** Nom complet, ex. « A2 » ou « F♯3 ». */
  name: string;
}

export function noteName(midi: number): NoteName {
  const rounded = Math.round(midi);
  const index = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  const letter = LETTERS[index] ?? '?';
  return { midi: rounded, letter, octave, solfege: SOLFEGE[index] ?? '?', name: `${letter}${octave}` };
}

export interface DetectedNote extends NoteName {
  /** Écart en cents par rapport à la note tempérée la plus proche. */
  cents: number;
}

export function describeFrequency(frequency: number, a4 = A4_DEFAULT): DetectedNote {
  const midi = frequencyToMidi(frequency, a4);
  const note = noteName(midi);
  return { ...note, cents: (midi - note.midi) * 100 };
}

export interface Tuning {
  id: TuningId;
  label: string;
  /** Hauteurs MIDI, de la corde 6 (grave) à la corde 1 (aiguë). */
  strings: readonly number[];
}

export type TuningId = 'standard' | 'drop-d' | 'dadgad' | 'open-g';

export const TUNINGS: readonly Tuning[] = [
  { id: 'standard', label: 'Standard', strings: [40, 45, 50, 55, 59, 64] }, // E2 A2 D3 G3 B3 E4
  { id: 'drop-d', label: 'Drop D', strings: [38, 45, 50, 55, 59, 64] }, // D2 A2 D3 G3 B3 E4
  { id: 'dadgad', label: 'DADGAD', strings: [38, 45, 50, 55, 57, 62] }, // D2 A2 D3 G3 A3 D4
  { id: 'open-g', label: 'Open G', strings: [38, 43, 50, 55, 59, 62] }, // D2 G2 D3 G3 B3 D4
];

export const TUNING_IDS: readonly TuningId[] = TUNINGS.map((t) => t.id);

export function getTuning(id: TuningId): Tuning {
  return TUNINGS.find((t) => t.id === id) ?? (TUNINGS[0] as Tuning);
}

/** Numéro de corde usuel (6 = grave) à partir de l'index dans `strings`. */
export function stringNumber(index: number, tuning: Tuning): number {
  return tuning.strings.length - index;
}

export interface StringMatch {
  index: number;
  midi: number;
  /** Écart en cents par rapport à la corde cible. */
  cents: number;
}

/** Corde de l'accordage la plus proche (en cents) de la fréquence jouée. */
export function nearestString(frequency: number, tuning: Tuning, a4 = A4_DEFAULT): StringMatch {
  let best: StringMatch = { index: 0, midi: tuning.strings[0] ?? 40, cents: Number.POSITIVE_INFINITY };
  tuning.strings.forEach((midi, index) => {
    const cents = centsBetween(frequency, midiToFrequency(midi, a4));
    if (Math.abs(cents) < Math.abs(best.cents)) best = { index, midi, cents };
  });
  return best;
}

/** Écart par rapport à une corde imposée (corde verrouillée par l'utilisateur). */
export function matchString(frequency: number, tuning: Tuning, index: number, a4 = A4_DEFAULT): StringMatch {
  const midi = tuning.strings[index] ?? tuning.strings[0] ?? 40;
  return { index, midi, cents: centsBetween(frequency, midiToFrequency(midi, a4)) };
}
