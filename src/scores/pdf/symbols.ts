/**
 * Symboles positionnés : chaque glyphe musical d'une page, avec sa boîte et son sens.
 */
import { classifyGlyph, isMusicFont, type HeadKind, type MusicSymbol, type RestKind, type ClefSign } from './glyphs';
import type { Glyph, PageData } from './types';

interface Placed {
  x: number;
  x1: number;
  y: number;
  size: number;
  glyph: Glyph;
}

export interface HeadSym extends Placed {
  head: HeadKind;
  cross: boolean;
}
export interface RestSym extends Placed {
  value: RestKind;
}
export interface AccidentalSym extends Placed {
  alter: number;
}
export interface FlagSym extends Placed {
  beams: number;
  up: boolean;
}
export interface ClefSym extends Placed {
  sign: ClefSign;
  octave: number;
  small: boolean;
}
export interface DigitSym extends Placed {
  digit: number;
}
export interface TimeCommonSym extends Placed {
  cut: boolean;
}

export interface PageSymbols {
  heads: HeadSym[];
  rests: RestSym[];
  accidentals: AccidentalSym[];
  flags: FlagSym[];
  dots: Placed[];
  clefs: ClefSym[];
  timeDigits: DigitSym[];
  timeCommons: TimeCommonSym[];
  /** Chiffres de n-olets (glyphes musicaux ou chiffres en italique d'une police de texte). */
  tupletDigits: DigitSym[];
  /** Chiffres d'une police de texte non italique (tablature, doigtés…). */
  textDigits: DigitSym[];
  braces: Placed[];
  repeatDots: Placed[];
  /** Texte (titre, tempo, paroles…). */
  text: Glyph[];
}

export function collectSymbols(page: PageData): PageSymbols {
  const out: PageSymbols = {
    heads: [],
    rests: [],
    accidentals: [],
    flags: [],
    dots: [],
    clefs: [],
    timeDigits: [],
    timeCommons: [],
    tupletDigits: [],
    textDigits: [],
    braces: [],
    repeatDots: [],
    text: [],
  };
  const clefOctaves: Array<Placed & { octaves: number }> = [];
  for (const glyph of page.glyphs) {
    const base: Placed = { x: glyph.x, x1: glyph.x + glyph.width, y: glyph.y, size: glyph.size, glyph };
    const sym: MusicSymbol | null = classifyGlyph(glyph);
    if (!sym) {
      if (!isMusicFont(glyph)) {
        out.text.push(glyph);
        if (/^[0-9]$/.test(glyph.text)) {
          const digit = { ...base, digit: Number(glyph.text) };
          if (/italic|oblique/i.test(glyph.font)) out.tupletDigits.push(digit);
          else out.textDigits.push(digit);
        }
      }
      continue;
    }
    switch (sym.type) {
      case 'notehead':
        out.heads.push({ ...base, head: sym.head, cross: !!sym.cross });
        break;
      case 'rest':
        out.rests.push({ ...base, value: sym.value });
        break;
      case 'accidental':
        out.accidentals.push({ ...base, alter: sym.alter });
        break;
      case 'flag':
        out.flags.push({ ...base, beams: sym.beams, up: sym.up });
        break;
      case 'dot':
        out.dots.push(base);
        break;
      case 'clef':
        out.clefs.push({ ...base, sign: sym.sign, octave: sym.octave, small: !!sym.small });
        break;
      case 'timeDigit':
        out.timeDigits.push({ ...base, digit: sym.digit });
        break;
      case 'timeCommon':
        out.timeCommons.push({ ...base, cut: sym.cut });
        break;
      case 'tupletDigit':
        out.tupletDigits.push({ ...base, digit: sym.digit });
        break;
      case 'brace':
      case 'bracket':
        out.braces.push(base);
        break;
      case 'repeatDots':
        out.repeatDots.push(base);
        break;
      case 'clefOctave':
        clefOctaves.push({ ...base, octaves: sym.octaves });
        break;
      default:
    }
  }
  // Clé d'octave dessinée en deux glyphes (clé + « 8 » au-dessous ou au-dessus).
  for (const c of out.clefs) {
    if (c.octave !== 0) continue;
    const near = clefOctaves.find((o) => o.x < c.x1 + 0.1 * c.size && o.x1 > c.x - 0.1 * c.size && Math.abs(o.y - c.y) < 1.6 * c.size);
    if (near) c.octave = near.y > c.y ? -near.octaves : near.octaves;
  }
  return out;
}
