import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ScoreEntry } from '../src/scores/library';
import { barAt, parseResume, resumeLabel, stepTarget, withPoint } from '../src/scores/resume';

const entry = (settings: Partial<ScoreEntry['settings']> = {}): ScoreEntry =>
  ({
    id: 'a',
    fileName: 'a.gp',
    title: 'Romance',
    artist: '',
    format: 'gp7',
    size: 1,
    addedAt: 0,
    openedAt: 0,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  }) as ScoreEntry;

describe('Reprendre où j’en étais', () => {
  it('positions relues avec tolérance, les plus anciennes oubliées', () => {
    expect(parseResume({ a: { tick: 960, bar: 1, at: 5 }, b: { tick: -1, bar: 0, at: 1 }, c: 'x' })).toEqual({ a: { tick: 960, bar: 1, at: 5 } });
    expect(parseResume([1, 2])).toEqual({});
    let map = {};
    for (let i = 0; i < 4; i++) map = withPoint(map, `p${i}`, { tick: i, bar: 0, at: i }, 2);
    expect(Object.keys(map).sort()).toEqual(['p2', 'p3']);
  });

  it('mesure d’une position et mesure visée par ← →', () => {
    const starts = [0, 3840, 7680, 11520];
    expect(barAt(starts, 0)).toBe(0);
    expect(barAt(starts, 3840)).toBe(1);
    expect(barAt(starts, 9000)).toBe(2);
    expect(stepTarget(starts, 3840, 1, 480)).toBe(2);
    expect(stepTarget(starts, 11520, 1, 480)).toBe(3); // dernière mesure : on y reste
    expect(stepTarget(starts, 3900, -1, 480)).toBe(0); // près du début : mesure précédente
    expect(stepTarget(starts, 5000, -1, 480)).toBe(1); // loin du début : début de la mesure en cours
    expect(stepTarget(starts, 100, -1, 480)).toBe(0);
    expect(stepTarget([], 100, 1, 480)).toBe(0);
  });

  it('ligne « Reprendre » : passage et vitesse, sinon mesure de la dernière position', () => {
    expect(resumeLabel(entry(), undefined)).toBeNull();
    expect(resumeLabel(entry(), { tick: 0, bar: 0, at: 1 })).toBeNull();
    expect(resumeLabel(entry(), { tick: 9000, bar: 2, at: 1 })).toBe('Reprendre : mesure 3');
    expect(resumeLabel(entry({ speed: 0.7, selection: { startBar: 11, startBeat: 0, endBar: 19, endBeat: 3 } }), { tick: 0, bar: 4, at: 1 })).toBe(
      'Reprendre : mesures 12–20, 70 %',
    );
    expect(resumeLabel(entry({ selection: { startBar: 4, startBeat: 0, endBar: 4, endBeat: 1 } }), undefined)).toBe('Reprendre : mesure 5');
  });
});
