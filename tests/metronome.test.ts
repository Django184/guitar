import { describe, expect, it } from 'vitest';
import { BeatClock, accentFor, beatsPerBar, clampBpm } from '../src/metronome/scheduler';
import { TapTempo } from '../src/metronome/tapTempo';

describe('Horloge des temps : pas de dérive', () => {
  it('120 BPM pendant 5 minutes : le 600e temps tombe exactement à +300 s', () => {
    const clock = new BeatClock();
    const start = 1.234567;
    clock.start(start, 120, '4/4');
    let last = clock.next();
    let maxError = 0;
    for (let n = 1; n <= 600; n++) {
      last = clock.next();
      maxError = Math.max(maxError, Math.abs(last.time - (start + n * 0.5)));
    }
    expect(last.time - start).toBeCloseTo(300, 9);
    expect(maxError).toBeLessThan(1e-9); // une nanoseconde ; un échantillon à 48 kHz ≈ 20 800 ns
  });

  it('pas d’accumulation d’erreur même après des heures (250 BPM, 3 h)', () => {
    const clock = new BeatClock();
    clock.start(0, 250, '4/4');
    const beats = 250 * 60 * 3;
    let beat = clock.next();
    for (let n = 1; n <= beats; n++) beat = clock.next();
    expect(beat.time).toBeCloseTo(beats * (60 / 250), 6);
  });

  it('changement de tempo : effet au temps suivant, sans saut', () => {
    const clock = new BeatClock();
    clock.start(0, 60, '4/4');
    clock.next(); // t = 0
    clock.next(); // t = 1
    clock.setTempo(120);
    expect(clock.next().time).toBeCloseTo(2, 9); // déjà promis à l'ancien tempo
    expect(clock.next().time).toBeCloseTo(2.5, 9);
    expect(clock.next().time).toBeCloseTo(3, 9);
  });

  it('retard (contexte suspendu) : reprise propre au lieu d’une rafale de clics', () => {
    const clock = new BeatClock();
    clock.start(0, 120, '4/4');
    clock.next();
    expect(clock.resync(10)).toBe(true);
    expect(clock.nextTime()).toBe(10);
    expect(clock.next().time).toBe(10);
    expect(clock.next().time).toBeCloseTo(10.5, 9);
    expect(clock.resync(5)).toBe(false);
  });
});

describe('Mesures et accents', () => {
  it('nombre de temps : 2/4, 3/4, 4/4, 6/8', () => {
    expect(beatsPerBar('2/4')).toBe(2);
    expect(beatsPerBar('3/4')).toBe(3);
    expect(beatsPerBar('4/4')).toBe(4);
    expect(beatsPerBar('6/8')).toBe(6);
  });

  it('premier temps accentué, cycle de mesure respecté', () => {
    const clock = new BeatClock();
    clock.start(0, 100, '3/4');
    const accents = Array.from({ length: 7 }, () => clock.next().accent);
    expect(accents).toEqual(['strong', 'weak', 'weak', 'strong', 'weak', 'weak', 'strong']);
  });

  it('6/8 : accent fort sur 1, secondaire sur 4', () => {
    expect([0, 1, 2, 3, 4, 5].map((b) => accentFor('6/8', b))).toEqual([
      'strong',
      'weak',
      'weak',
      'medium',
      'weak',
      'weak',
    ]);
  });

  it('changement de mesure : le temps suivant devient un premier temps', () => {
    const clock = new BeatClock();
    clock.start(0, 100, '4/4');
    clock.next();
    clock.next();
    clock.setMeter('2/4');
    expect(clock.next()).toMatchObject({ beatInBar: 0, accent: 'strong' });
    expect(clock.next()).toMatchObject({ beatInBar: 1, accent: 'weak' });
    expect(clock.next()).toMatchObject({ beatInBar: 0, accent: 'strong' });
  });
});

describe('Tempo : bornes et tap tempo', () => {
  it('borné entre 30 et 250 BPM, entier', () => {
    expect(clampBpm(10)).toBe(30);
    expect(clampBpm(300)).toBe(250);
    expect(clampBpm(119.6)).toBe(120);
  });

  it('tapes toutes les 500 ms → 120 BPM', () => {
    const tap = new TapTempo();
    expect(tap.tap(1000)).toBeNull();
    expect(tap.tap(1500)).toBe(120);
    expect(tap.tap(2000)).toBe(120);
    expect(tap.tap(2510)).toBe(119);
  });

  it('pause de plus de 2 s : nouvelle série', () => {
    const tap = new TapTempo();
    tap.tap(0);
    tap.tap(1000); // 60 BPM
    expect(tap.tap(5000)).toBeNull();
    expect(tap.tap(5250)).toBe(240);
  });

  it('tempo hors bornes ramené dans la plage', () => {
    const tap = new TapTempo();
    tap.tap(0);
    expect(tap.tap(150)).toBe(250);
  });
});
