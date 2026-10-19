import { describe, expect, it } from 'vitest';
import { describeFrequency, nearestString, getTuning } from '../src/tuner/notes';
import { PitchStabilizer } from '../src/tuner/stabilizer';
import { Yin, rms } from '../src/tuner/yin';
import { cents, tone } from './signals';

// Taille identique à l'AnalyserNode de l'app (fftSize 4096).
const SIZE = 4096;
const SAMPLE_RATES = [44100, 48000];

const STRINGS: Array<[string, number]> = [
  ['D2', 73.4162],
  ['E2', 82.4069],
  ['A2', 110],
  ['D3', 146.8324],
  ['G3', 195.9977],
  ['B3', 246.9417],
  ['E4', 329.6276],
];

describe('YIN : critère d’acceptation', () => {
  for (const sampleRate of SAMPLE_RATES) {
    it(`un La à 110 Hz s’affiche « A2 » à ±2 cents près (${sampleRate} Hz)`, () => {
      const yin = new Yin({ sampleRate });
      const estimate = yin.detect(tone(110, sampleRate, SIZE));
      expect(estimate).not.toBeNull();
      const note = describeFrequency(estimate!.frequency, 440);
      expect(note.name).toBe('A2');
      expect(Math.abs(note.cents)).toBeLessThan(2);
      const match = nearestString(estimate!.frequency, getTuning('standard'), 440);
      expect(match.index).toBe(1); // corde 5
      expect(Math.abs(match.cents)).toBeLessThan(2);
    });
  }
});

describe('YIN : précision sur les cordes à vide', () => {
  for (const sampleRate of SAMPLE_RATES) {
    const yin = new Yin({ sampleRate });
    for (const [name, frequency] of STRINGS) {
      it(`${name} (${frequency} Hz) à ${sampleRate} Hz, timbre de guitare`, () => {
        const estimate = yin.detect(tone(frequency, sampleRate, SIZE, { offset: 333 }));
        expect(estimate).not.toBeNull();
        expect(describeFrequency(estimate!.frequency).name).toBe(name);
        expect(Math.abs(cents(estimate!.frequency, frequency))).toBeLessThan(0.5);
      });
    }
  }
});

describe('YIN : robustesse aux harmoniques (pas d’erreur d’octave)', () => {
  const sampleRate = 48000;
  const yin = new Yin({ sampleRate });

  it('Mi grave avec fondamentale très faible (micro de téléphone) reste E2', () => {
    const buffer = tone(82.4069, sampleRate, SIZE, { partials: [0.1, 1, 0.9, 0.6, 0.5, 0.3, 0.2, 0.1] });
    const estimate = yin.detect(buffer);
    expect(estimate).not.toBeNull();
    expect(describeFrequency(estimate!.frequency).name).toBe('E2');
  });

  it('Ré grave (Drop D) avec 2e et 3e harmoniques dominants reste D2', () => {
    const buffer = tone(73.4162, sampleRate, SIZE, { partials: [0.2, 1, 1, 0.4, 0.3] });
    expect(describeFrequency(yin.detect(buffer)!.frequency).name).toBe('D2');
  });

  it('note qui s’éteint, avec bruit de fond (~17 dB) : moins de 1,5 cent d’erreur', () => {
    for (const [, frequency] of STRINGS) {
      const buffer = tone(frequency, sampleRate, SIZE, { decay: 0.5, noise: 0.05 });
      const estimate = yin.detect(buffer);
      expect(estimate).not.toBeNull();
      expect(Math.abs(cents(estimate!.frequency, frequency))).toBeLessThan(1.5);
    }
  });

  it('critère d’acceptation en conditions bruitées : A2 à ±2 cents', () => {
    const estimate = yin.detect(tone(110, sampleRate, SIZE, { decay: 0.5, noise: 0.05, offset: 1200 }));
    const note = describeFrequency(estimate!.frequency);
    expect(note.name).toBe('A2');
    expect(Math.abs(note.cents)).toBeLessThan(2);
  });

  it('corde réelle légèrement inharmonique : écart dans la tolérance de ±5 cents', () => {
    const buffer = tone(110, sampleRate, SIZE, { inharmonicity: 0.0001 });
    const estimate = yin.detect(buffer);
    expect(Math.abs(cents(estimate!.frequency, 110))).toBeLessThan(3);
  });
});

describe('YIN : rejet du bruit et du silence', () => {
  const yin = new Yin({ sampleRate: 48000 });

  it('bruit blanc : aucune note', () => {
    const noise = tone(110, 48000, SIZE, { partials: [], noise: 0.1 });
    expect(yin.detect(noise)).toBeNull();
  });

  it('silence : niveau nul', () => {
    expect(rms(new Float32Array(SIZE))).toBe(0);
  });

  it('tampon trop court : null plutôt qu’une valeur fausse', () => {
    expect(yin.detect(new Float32Array(512))).toBeNull();
  });
});

describe('Stabilisation de l’affichage', () => {
  it('ignore une mesure isolée à l’octave', () => {
    const stabilizer = new PitchStabilizer();
    expect(stabilizer.push(110)).toBeNull(); // attend une confirmation
    expect(stabilizer.push(110.1)).toBeCloseTo(110.05, 1);
    stabilizer.push(110);
    const afterGlitch = stabilizer.push(220); // erreur d'octave isolée
    expect(afterGlitch).toBeCloseTo(110, 0);
  });

  it('suit un vrai changement de note après confirmation', () => {
    const stabilizer = new PitchStabilizer();
    [110, 110, 110].forEach((f) => stabilizer.push(f));
    stabilizer.push(146.83);
    expect(stabilizer.push(146.83)).toBeCloseTo(146.83, 1);
  });
});
