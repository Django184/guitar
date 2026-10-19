import { describe, expect, it } from 'vitest';
import { Fretter, STANDARD_TUNING, isPlayable, playableRatio } from '../src/scores/fretting';

const pitchOf = (pos: { string: number; fret: number }): number => (STANDARD_TUNING[pos.string] as number) + pos.fret;

describe('Placement sur le manche', () => {
  it('cordes à vide : Mi grave, La, Ré, Sol, Si, Mi aigu', () => {
    const fretter = new Fretter();
    [40, 45, 50, 55, 59, 64].forEach((pitch, string) => {
      expect(fretter.assign([pitch])).toEqual([{ string, fret: 0 }]);
    });
  });

  it('chaque position redonne exactement la hauteur demandée', () => {
    const fretter = new Fretter();
    for (let pitch = 40; pitch <= 84; pitch++) {
      const [pos] = fretter.assign([pitch]);
      expect(pos).not.toBeNull();
      expect(pitchOf(pos!)).toBe(pitch);
    }
  });

  it('accord de Do majeur ouvert : six cordes distinctes, positions basses', () => {
    const fretter = new Fretter();
    const chord = [48, 52, 55, 60, 64]; // C3 E3 G3 C4 E4
    const positions = fretter.assign(chord);
    const strings = positions.map((p) => p!.string);
    expect(new Set(strings).size).toBe(chord.length);
    positions.forEach((p, i) => expect(pitchOf(p!)).toBe(chord[i]));
    expect(Math.max(...positions.map((p) => p!.fret))).toBeLessThan(4);
  });

  it('accord trop écarté : notes impossibles laissées sans position, jamais deux notes sur une corde', () => {
    const fretter = new Fretter();
    const positions = fretter.assign([40, 41, 42, 43, 44, 45, 46]);
    const placed = positions.filter((p) => p !== null);
    expect(new Set(placed.map((p) => p!.string)).size).toBe(placed.length);
    expect(placed.length).toBeLessThan(7);
  });

  it('gamme de Sol majeur : jouée en position, sans glisser le long d’une corde', () => {
    const fretter = new Fretter();
    const scale = [55, 57, 59, 60, 62, 64, 66, 67]; // Sol 3 → Sol 4
    const positions = scale.map((pitch) => fretter.assign([pitch])[0]!);
    const fretted = positions.map((p) => p.fret).filter((f) => f > 0);
    expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(4);
    expect(new Set(positions.map((p) => p.string)).size).toBeGreaterThanOrEqual(3);
  });

  it('mélodie aiguë : la main suit sans sauts inutiles', () => {
    const fretter = new Fretter();
    const melody = [69, 71, 72, 74, 72, 71, 69];
    const frets = melody.map((pitch) => fretter.assign([pitch])[0]!.fret);
    for (let i = 1; i < frets.length; i++) {
      expect(Math.abs((frets[i] as number) - (frets[i - 1] as number))).toBeLessThanOrEqual(5);
    }
  });

  it('hauteurs hors de la guitare', () => {
    expect(isPlayable(30)).toBe(false);
    expect(isPlayable(100)).toBe(false);
    expect(new Fretter().assign([30])).toEqual([null]);
    expect(playableRatio([40, 50, 30, 100])).toBe(0.5);
    expect(playableRatio([])).toBe(0);
  });
});
