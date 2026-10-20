/**
 * Sens musical des glyphes, selon la police.
 *
 * - Polices SMuFL (Bravura, Leland, Petaluma, Finale Maestro récent, Sebastian…) :
 *   points de code de la zone privée U+E000–U+F8FF, normalisés par la spécification SMuFL.
 * - Anciennes polices « compatibles Sonata » (Maestro, Opus, Petrucci, Jazz, Engraver…),
 *   utilisées par Finale et Sibelius : caractères latins détournés (« œ » = tête noire…).
 */
import type { Glyph } from './types';

export type HeadKind = 'black' | 'half' | 'whole' | 'breve';
export type RestKind = 'breve' | 'whole' | 'half' | 'quarter' | '8th' | '16th' | '32nd' | '64th' | '128th';
export type ClefSign = 'G' | 'F' | 'C' | 'percussion' | 'tab';

export type MusicSymbol =
  | { type: 'notehead'; head: HeadKind; cross?: boolean }
  | { type: 'rest'; value: RestKind; multiBar?: boolean }
  | { type: 'clef'; sign: ClefSign; octave: number; small?: boolean }
  | { type: 'accidental'; alter: number }
  | { type: 'flag'; beams: number; up: boolean }
  | { type: 'dot' }
  | { type: 'timeDigit'; digit: number }
  | { type: 'timeCommon'; cut: boolean }
  | { type: 'tupletDigit'; digit: number }
  | { type: 'brace' }
  | { type: 'bracket' }
  | { type: 'repeatDots' }
  | { type: 'ottava'; shift: number }
  /** « 8 » ou « 15 » accolé à une clé (clé d'octave composée). */
  | { type: 'clefOctave'; octaves: number }
  | { type: 'other' };

/** Durées en noires. */
export const HEAD_QUARTERS: Record<HeadKind, number> = { breve: 8, whole: 4, half: 2, black: 1 };
export const REST_QUARTERS: Record<RestKind, number> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  '8th': 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
};

const SMUFL: Record<number, MusicSymbol> = {
  // Accolades
  0xe000: { type: 'brace' },
  0xe002: { type: 'bracket' },
  0xe003: { type: 'bracket' },
  0xe004: { type: 'bracket' },
  // Reprises
  0xe040: { type: 'repeatDots' },
  0xe041: { type: 'repeatDots' },
  0xe042: { type: 'repeatDots' },
  0xe043: { type: 'repeatDots' },
  0xe044: { type: 'repeatDots' },
  // Clés
  0xe050: { type: 'clef', sign: 'G', octave: 0 },
  0xe051: { type: 'clef', sign: 'G', octave: -2 },
  0xe052: { type: 'clef', sign: 'G', octave: -1 },
  0xe053: { type: 'clef', sign: 'G', octave: 1 },
  0xe054: { type: 'clef', sign: 'G', octave: 2 },
  0xe055: { type: 'clef', sign: 'G', octave: -1 },
  0xe056: { type: 'clef', sign: 'G', octave: -1 },
  0xe05c: { type: 'clef', sign: 'C', octave: 0 },
  0xe05d: { type: 'clef', sign: 'C', octave: -1 },
  0xe062: { type: 'clef', sign: 'F', octave: 0 },
  0xe063: { type: 'clef', sign: 'F', octave: -2 },
  0xe064: { type: 'clef', sign: 'F', octave: -1 },
  0xe065: { type: 'clef', sign: 'F', octave: 1 },
  0xe066: { type: 'clef', sign: 'F', octave: 2 },
  0xe069: { type: 'clef', sign: 'percussion', octave: 0 },
  0xe06a: { type: 'clef', sign: 'percussion', octave: 0 },
  0xe06d: { type: 'clef', sign: 'tab', octave: 0 },
  0xe06e: { type: 'clef', sign: 'tab', octave: 0 },
  0xe07a: { type: 'clef', sign: 'G', octave: 0, small: true },
  0xe07b: { type: 'clef', sign: 'C', octave: 0, small: true },
  0xe07c: { type: 'clef', sign: 'F', octave: 0, small: true },
  0xe07d: { type: 'clefOctave', octaves: 1 },
  0xe07e: { type: 'clefOctave', octaves: 2 },
  // Chiffrages
  0xe08a: { type: 'timeCommon', cut: false },
  0xe08b: { type: 'timeCommon', cut: true },
  // Têtes de notes
  0xe0a0: { type: 'notehead', head: 'breve' },
  0xe0a1: { type: 'notehead', head: 'breve' },
  0xe0a2: { type: 'notehead', head: 'whole' },
  0xe0a3: { type: 'notehead', head: 'half' },
  0xe0a4: { type: 'notehead', head: 'black' },
  0xe0a6: { type: 'notehead', head: 'breve', cross: true },
  0xe0a7: { type: 'notehead', head: 'whole', cross: true },
  0xe0a8: { type: 'notehead', head: 'half', cross: true },
  0xe0a9: { type: 'notehead', head: 'black', cross: true },
  0xe0b4: { type: 'notehead', head: 'whole', cross: true },
  0xe0b5: { type: 'notehead', head: 'half', cross: true },
  0xe0b6: { type: 'notehead', head: 'black', cross: true },
  0xe0d8: { type: 'notehead', head: 'whole' },
  0xe0d9: { type: 'notehead', head: 'half' },
  0xe0db: { type: 'notehead', head: 'black' },
  0xe0dd: { type: 'notehead', head: 'black' },
  0xe0f5: { type: 'other' },
  0xe0f6: { type: 'other' },
  0xe100: { type: 'notehead', head: 'black' },
  0xe101: { type: 'notehead', head: 'black' },
  0xe102: { type: 'notehead', head: 'whole' },
  0xe103: { type: 'notehead', head: 'half' },
  0xe1d2: { type: 'notehead', head: 'breve' },
  // Point d'augmentation
  0xe1e7: { type: 'dot' },
  // Crochets
  0xe240: { type: 'flag', beams: 1, up: true },
  0xe241: { type: 'flag', beams: 1, up: false },
  0xe242: { type: 'flag', beams: 2, up: true },
  0xe243: { type: 'flag', beams: 2, up: false },
  0xe244: { type: 'flag', beams: 3, up: true },
  0xe245: { type: 'flag', beams: 3, up: false },
  0xe246: { type: 'flag', beams: 4, up: true },
  0xe247: { type: 'flag', beams: 4, up: false },
  0xe248: { type: 'flag', beams: 5, up: true },
  0xe249: { type: 'flag', beams: 5, up: false },
  // Altérations
  0xe260: { type: 'accidental', alter: -1 },
  0xe261: { type: 'accidental', alter: 0 },
  0xe262: { type: 'accidental', alter: 1 },
  0xe263: { type: 'accidental', alter: 2 },
  0xe264: { type: 'accidental', alter: -2 },
  0xe266: { type: 'accidental', alter: 0 },
  0xe267: { type: 'accidental', alter: 0 },
  0xe268: { type: 'accidental', alter: 1 },
  0xe269: { type: 'accidental', alter: -1 },
  // Silences
  0xe4e1: { type: 'rest', value: 'breve' },
  0xe4e2: { type: 'rest', value: 'breve' },
  0xe4e3: { type: 'rest', value: 'whole' },
  0xe4e4: { type: 'rest', value: 'half' },
  0xe4e5: { type: 'rest', value: 'quarter' },
  0xe4e6: { type: 'rest', value: '8th' },
  0xe4e7: { type: 'rest', value: '16th' },
  0xe4e8: { type: 'rest', value: '32nd' },
  0xe4e9: { type: 'rest', value: '64th' },
  0xe4ea: { type: 'rest', value: '128th' },
  0xe4ee: { type: 'rest', value: 'whole', multiBar: true },
  0xe4ef: { type: 'rest', value: 'whole', multiBar: true },
  0xe4f4: { type: 'rest', value: 'whole' },
  0xe4f5: { type: 'rest', value: 'half' },
  // Octaviations
  0xe510: { type: 'ottava', shift: 1 },
  0xe511: { type: 'ottava', shift: 1 },
  0xe512: { type: 'ottava', shift: -1 },
  0xe514: { type: 'ottava', shift: 2 },
  0xe517: { type: 'ottava', shift: -2 },
};

// Chiffres de chiffrage (E080–E089) et de n-olets (E880–E889).
for (let d = 0; d <= 9; d++) {
  SMUFL[0xe080 + d] = { type: 'timeDigit', digit: d };
  SMUFL[0xe880 + d] = { type: 'tupletDigit', digit: d };
}

/** Polices « compatibles Sonata » : correspondance par caractère. */
const LEGACY: Record<string, MusicSymbol> = {
  '&': { type: 'clef', sign: 'G', octave: 0 },
  V: { type: 'clef', sign: 'G', octave: -1 },
  '?': { type: 'clef', sign: 'F', octave: 0 },
  B: { type: 'clef', sign: 'C', octave: 0 },
  '/': { type: 'clef', sign: 'percussion', octave: 0 },
  œ: { type: 'notehead', head: 'black' },
  Ï: { type: 'notehead', head: 'black' },
  '˙': { type: 'notehead', head: 'half' },
  w: { type: 'notehead', head: 'whole' },
  W: { type: 'notehead', head: 'breve' },
  '∑': { type: 'rest', value: 'whole' },
  Ó: { type: 'rest', value: 'half' },
  Œ: { type: 'rest', value: 'quarter' },
  '‰': { type: 'rest', value: '8th' },
  '≈': { type: 'rest', value: '16th' },
  '®': { type: 'rest', value: '32nd' },
  Ù: { type: 'rest', value: '64th' },
  '#': { type: 'accidental', alter: 1 },
  b: { type: 'accidental', alter: -1 },
  n: { type: 'accidental', alter: 0 },
  Ü: { type: 'accidental', alter: 2 },
  º: { type: 'accidental', alter: -2 },
  j: { type: 'flag', beams: 1, up: true },
  J: { type: 'flag', beams: 1, up: false },
  r: { type: 'flag', beams: 2, up: true },
  R: { type: 'flag', beams: 2, up: false },
  k: { type: 'flag', beams: 2, up: true },
  K: { type: 'flag', beams: 2, up: false },
  x: { type: 'flag', beams: 3, up: true },
  X: { type: 'flag', beams: 3, up: false },
  '.': { type: 'dot' },
  c: { type: 'timeCommon', cut: false },
  C: { type: 'timeCommon', cut: true },
  '{': { type: 'brace' },
};
for (let d = 0; d <= 9; d++) LEGACY[String(d)] = { type: 'timeDigit', digit: d };

/** LilyPond (Emmentaler/Feta) : noms de glyphes. */
const FETA: Record<string, MusicSymbol> = {
  'noteheads.sM1': { type: 'notehead', head: 'breve' },
  'noteheads.s0': { type: 'notehead', head: 'whole' },
  'noteheads.s1': { type: 'notehead', head: 'half' },
  'noteheads.s2': { type: 'notehead', head: 'black' },
  'noteheads.s0cross': { type: 'notehead', head: 'whole', cross: true },
  'noteheads.s1cross': { type: 'notehead', head: 'half', cross: true },
  'noteheads.s2cross': { type: 'notehead', head: 'black', cross: true },
  'rests.M1': { type: 'rest', value: 'breve' },
  'rests.M1o': { type: 'rest', value: 'breve' },
  'rests.0': { type: 'rest', value: 'whole' },
  'rests.0o': { type: 'rest', value: 'whole' },
  'rests.1': { type: 'rest', value: 'half' },
  'rests.1o': { type: 'rest', value: 'half' },
  'rests.2': { type: 'rest', value: 'quarter' },
  'rests.2classical': { type: 'rest', value: 'quarter' },
  'rests.3': { type: 'rest', value: '8th' },
  'rests.4': { type: 'rest', value: '16th' },
  'rests.5': { type: 'rest', value: '32nd' },
  'rests.6': { type: 'rest', value: '64th' },
  'rests.7': { type: 'rest', value: '128th' },
  'flags.u3': { type: 'flag', beams: 1, up: true },
  'flags.d3': { type: 'flag', beams: 1, up: false },
  'flags.u4': { type: 'flag', beams: 2, up: true },
  'flags.d4': { type: 'flag', beams: 2, up: false },
  'flags.u5': { type: 'flag', beams: 3, up: true },
  'flags.d5': { type: 'flag', beams: 3, up: false },
  'flags.u6': { type: 'flag', beams: 4, up: true },
  'flags.d6': { type: 'flag', beams: 4, up: false },
  'flags.u7': { type: 'flag', beams: 5, up: true },
  'flags.d7': { type: 'flag', beams: 5, up: false },
  'dots.dot': { type: 'dot' },
  'accidentals.sharp': { type: 'accidental', alter: 1 },
  'accidentals.flat': { type: 'accidental', alter: -1 },
  'accidentals.natural': { type: 'accidental', alter: 0 },
  'accidentals.doublesharp': { type: 'accidental', alter: 2 },
  'accidentals.flatflat': { type: 'accidental', alter: -2 },
  'clefs.G': { type: 'clef', sign: 'G', octave: 0 },
  'clefs.G_change': { type: 'clef', sign: 'G', octave: 0, small: true },
  'clefs.F': { type: 'clef', sign: 'F', octave: 0 },
  'clefs.F_change': { type: 'clef', sign: 'F', octave: 0, small: true },
  'clefs.C': { type: 'clef', sign: 'C', octave: 0 },
  'clefs.C_change': { type: 'clef', sign: 'C', octave: 0, small: true },
  'clefs.percussion': { type: 'clef', sign: 'percussion', octave: 0 },
  'clefs.tab': { type: 'clef', sign: 'tab', octave: 0 },
  'timesig.C44': { type: 'timeCommon', cut: false },
  'timesig.C22': { type: 'timeCommon', cut: true },
  'dots.dotkievan': { type: 'other' },
};
const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** Noms SMuFL des glyphes utiles (polices SMuFL sans table Unicode). */
const SMUFL_NAMES: Record<string, number> = {
  brace: 0xe000,
  bracket: 0xe002,
  repeatDot: 0xe044,
  repeatDots: 0xe043,
  gClef: 0xe050,
  gClef8vb: 0xe052,
  gClef8va: 0xe053,
  fClef: 0xe062,
  fClef8vb: 0xe064,
  cClef: 0xe05c,
  gClefChange: 0xe07a,
  cClefChange: 0xe07b,
  fClefChange: 0xe07c,
  clef8: 0xe07d,
  clef15: 0xe07e,
  unpitchedPercussionClef1: 0xe069,
  '6stringTabClef': 0xe06d,
  '4stringTabClef': 0xe06e,
  timeSigCommon: 0xe08a,
  timeSigCutCommon: 0xe08b,
  noteheadDoubleWhole: 0xe0a0,
  noteheadWhole: 0xe0a2,
  noteheadHalf: 0xe0a3,
  noteheadBlack: 0xe0a4,
  noteheadXBlack: 0xe0a9,
  augmentationDot: 0xe1e7,
  flag8thUp: 0xe240,
  flag8thDown: 0xe241,
  flag16thUp: 0xe242,
  flag16thDown: 0xe243,
  flag32ndUp: 0xe244,
  flag32ndDown: 0xe245,
  flag64thUp: 0xe246,
  flag64thDown: 0xe247,
  accidentalFlat: 0xe260,
  accidentalNatural: 0xe261,
  accidentalSharp: 0xe262,
  accidentalDoubleSharp: 0xe263,
  accidentalDoubleFlat: 0xe264,
  restDoubleWhole: 0xe4e2,
  restWhole: 0xe4e3,
  restHalf: 0xe4e4,
  restQuarter: 0xe4e5,
  rest8th: 0xe4e6,
  rest16th: 0xe4e7,
  rest32nd: 0xe4e8,
  rest64th: 0xe4e9,
  rest128th: 0xe4ea,
  restWholeLegerLine: 0xe4f4,
  restHalfLegerLine: 0xe4f5,
};
for (let d = 0; d <= 9; d++) {
  SMUFL_NAMES[`timeSig${d}`] = 0xe080 + d;
  SMUFL_NAMES[`tuplet${d}`] = 0xe880 + d;
}

/** Point de code SMuFL d'après le nom du glyphe (« uniE0A4 », « noteheadBlack »). */
function smuflFromName(name: string): number | null {
  const uni = /^(?:uni|u)([0-9A-Fa-f]{4,5})$/.exec(name);
  if (uni) {
    const cp = parseInt(uni[1] as string, 16);
    return cp >= 0xe000 && cp <= 0xf8ff ? cp : null;
  }
  return SMUFL_NAMES[name] ?? null;
}

const LEGACY_FONTS = /maestro|opus|petrucci|sonata|jazz(?!.*text)|engraver|november|tamburo|broadway(?!.*copyist text)|reprise|anastasia/i;

/** Police musicale ancienne (et non sa variante de texte). */
export function isLegacyMusicFont(font: string): boolean {
  return LEGACY_FONTS.test(font) && !/text/i.test(font);
}

/** Vrai si le glyphe est dans la zone privée Unicode (SMuFL). */
export function isSmuflGlyph(glyph: Glyph): boolean {
  return glyph.cp >= 0xe000 && glyph.cp <= 0xf8ff;
}

export function isFetaFont(font: string): boolean {
  return /emmentaler|feta|gonville|lilyjazz|cadence/i.test(font);
}

/** Polices dont tous les glyphes sont musicaux (et non du texte). */
export function isMusicFont(glyph: Glyph): boolean {
  return isSmuflGlyph(glyph) || isLegacyMusicFont(glyph.font) || isFetaFont(glyph.font);
}

/** Interprète un glyphe ; null si ce n'est pas un symbole musical reconnu. */
export function classifyGlyph(glyph: Glyph): MusicSymbol | null {
  if (glyph.name) {
    const feta = FETA[glyph.name];
    if (feta) return feta;
    if (glyph.name.startsWith('brace') && isFetaFont(glyph.font)) return { type: 'brace' };
    const cp = smuflFromName(glyph.name);
    if (cp !== null) return SMUFL[cp] ?? { type: 'other' };
  }
  if (isSmuflGlyph(glyph)) return SMUFL[glyph.cp] ?? { type: 'other' };
  if (isFetaFont(glyph.font)) {
    const digit = glyph.name ? DIGIT_NAMES.indexOf(glyph.name) : -1;
    if (digit >= 0) return { type: 'timeDigit', digit };
    if (/^[0-9]$/.test(glyph.text)) return { type: 'timeDigit', digit: Number(glyph.text) };
    return { type: 'other' };
  }
  if (isLegacyMusicFont(glyph.font)) return LEGACY[glyph.text] ?? { type: 'other' };
  return null;
}

/** Chiffre écrit dans une police de texte (n-olets, doigtés, cases de tablature…). */
export function textDigit(glyph: Glyph): number | null {
  if (isMusicFont(glyph)) return null;
  return /^[0-9]$/.test(glyph.text) ? Number(glyph.text) : null;
}
