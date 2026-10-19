import { describe, expect, it } from 'vitest';
import {
  TUNINGS,
  clampA4,
  describeFrequency,
  getTuning,
  matchString,
  midiToFrequency,
  nearestString,
  noteName,
  stringNumber,
} from '../src/tuner/notes';

describe('Noms de notes', () => {
  it('110 Hz = A2 (La), 0 cent', () => {
    const note = describeFrequency(110);
    expect(note.name).toBe('A2');
    expect(note.solfege).toBe('La');
    expect(note.cents).toBeCloseTo(0, 6);
  });

  it('82,41 Hz = E2, 440 Hz = A4, 261,63 Hz = C4', () => {
    expect(describeFrequency(82.41).name).toBe('E2');
    expect(describeFrequency(440).name).toBe('A4');
    expect(describeFrequency(261.63).name).toBe('C4');
  });

  it('dièses en notation internationale et en solfège', () => {
    const note = noteName(46);
    expect(note.name).toBe('A♯2');
    expect(note.solfege).toBe('La♯');
  });

  it('écart en cents : signe et valeur', () => {
    expect(describeFrequency(110 * 2 ** (10 / 1200)).cents).toBeCloseTo(10, 6);
    expect(describeFrequency(110 * 2 ** (-30 / 1200)).cents).toBeCloseTo(-30, 6);
  });
});

describe('Diapason', () => {
  it('borné entre 430 et 450 Hz', () => {
    expect(clampA4(420)).toBe(430);
    expect(clampA4(455)).toBe(450);
    expect(clampA4(441.4)).toBe(441);
  });

  it('avec La 4 = 432 Hz, 432 Hz est un A4 juste et 110 Hz est trop haut', () => {
    expect(describeFrequency(432, 432).cents).toBeCloseTo(0, 6);
    expect(describeFrequency(110, 432).cents).toBeGreaterThan(30);
    expect(midiToFrequency(45, 432)).toBeCloseTo(108, 6);
  });
});

describe('Accordages et corde la plus proche', () => {
  it('les quatre préréglages ont six cordes', () => {
    expect(TUNINGS.map((t) => t.id)).toEqual(['standard', 'drop-d', 'dadgad', 'open-g']);
    TUNINGS.forEach((t) => expect(t.strings).toHaveLength(6));
  });

  it('Standard EADGBE, Drop D, DADGAD, Open G', () => {
    const names = (id: Parameters<typeof getTuning>[0]): string =>
      getTuning(id)
        .strings.map((m) => noteName(m).name)
        .join(' ');
    expect(names('standard')).toBe('E2 A2 D3 G3 B3 E4');
    expect(names('drop-d')).toBe('D2 A2 D3 G3 B3 E4');
    expect(names('dadgad')).toBe('D2 A2 D3 G3 A3 D4');
    expect(names('open-g')).toBe('D2 G2 D3 G3 B3 D4');
  });

  it('corde 6 = Mi grave, corde 1 = Mi aigu', () => {
    const standard = getTuning('standard');
    expect(stringNumber(0, standard)).toBe(6);
    expect(stringNumber(5, standard)).toBe(1);
  });

  it('une corde de La un peu basse est reconnue comme corde 5', () => {
    const match = nearestString(108, getTuning('standard'));
    expect(match.index).toBe(1);
    expect(match.cents).toBeLessThan(-30);
  });

  it('corde fixée : écart mesuré par rapport à elle, même loin', () => {
    const match = matchString(98, getTuning('standard'), 1); // Sol joué, La attendu
    expect(match.cents).toBeCloseTo(-200, 0);
  });
});
