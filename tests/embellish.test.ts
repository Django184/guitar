import { describe, expect, it } from 'vitest';
import { applyAdditions, suggest } from '../src/scores/embellish/suggest';
import { shapeCost } from '../src/scores/fingering/fingering';
import type { TabHit } from '../src/scores/pdf/asciiTab';
import { type TimedOnset, bestAlignment, credible } from '../src/scores/rhythm/align';
import type { AlignedSource } from '../src/scores/rhythm/findRhythm';
import type { SourceSong } from '../src/scores/rhythm/sources';
import type { ScoreEvent } from '../src/scores/sync/scoreEvents';

const STANDARD = { tuning: [64, 59, 55, 50, 45, 40], capo: 0 };
const pitchOf = (h: TabHit): number => (STANDARD.tuning[h.string - 1] as number) + h.fret;

/** Mélodie de test (corde 1 = mi aigu) : [début, [corde, case]]. 4 mesures de 4/4, mi mineur. */
const MELODY: Array<[number, [number, number]]> = [
  [0, [1, 0]], [1, [1, 3]], [1.5, [1, 5]], [2, [1, 7]], [3, [1, 5]],
  [4, [1, 3]], [5, [1, 0]], [6, [2, 3]], [7, [1, 0]],
  [8, [2, 0]], [9, [2, 3]], [10, [1, 0]], [11, [1, 3]],
  [12, [1, 5]], [13, [1, 3]], [14, [1, 0]], [15, [2, 3]],
];

function tabEvents(melody = MELODY): ScoreEvent[] {
  return melody.map(([start, [string, fret]]) => ({
    bar: Math.floor(start / 4),
    onset: start % 4,
    start,
    notes: [{ string, fret }],
    pitches: [pitchOf({ string, fret })],
  }));
}

/** Accords de la source, par mesure (Mi mineur, Sol, Ré, Mi mineur), sur chaque temps. */
const CHORDS = [
  [40, 47, 52, 55],
  [43, 47, 50, 55],
  [38, 45, 50, 54],
  [40, 47, 52, 55],
];

function sourceSong(withChords: boolean, extraMelody: Array<[number, number]> = []): SourceSong {
  const melody: TimedOnset[] = [...MELODY.map(([start, hit]) => ({ start, pitches: [pitchOf({ string: hit[0], fret: hit[1] })] })), ...extraMelody.map(([start, pitch]) => ({ start, pitches: [pitch] }))].sort(
    (a, b) => a.start - b.start,
  );
  const chords: TimedOnset[] = [];
  if (withChords) CHORDS.forEach((c, bar) => [0, 1, 2, 3].forEach((beat) => chords.push({ start: bar * 4 + beat, pitches: c })));
  return {
    tracks: [
      { name: 'Mélodie', guitar: false, onsets: melody },
      ...(withChords ? [{ name: 'Accords', guitar: false, onsets: chords }] : []),
    ],
    bars: [0, 4, 8, 12].map((start) => ({ start, beats: 4, beatType: 4 })),
    tempos: [{ start: 0, bpm: 100 }],
  };
}

async function aligned(song: SourceSong, events: ScoreEvent[]): Promise<AlignedSource> {
  const alignment = await bestAlignment(
    events.map((e) => ({ pitches: e.pitches })),
    song.tracks.map((t) => ({ onsets: t.onsets, guitar: t.guitar })),
  );
  return { label: 'source', song, alignment, used: !!alignment && credible(alignment) };
}

describe('Enrichissement : propositions', () => {
  it('basse et notes de l’accord sur les temps, jouables, sous la mélodie, sans frottement', async () => {
    const events = tabEvents();
    const source = await aligned(sourceSong(true), events);
    expect(source.used).toBe(true);
    const adds = suggest(events, events.map((e) => e.start), STANDARD, [source]);
    expect(adds.some((a) => a.kind === 'bass')).toBe(true);
    expect(adds.some((a) => a.kind === 'chord')).toBe(true);
    const merged = applyAdditions(events, events.map((e) => e.start), adds, STANDARD);
    merged.events.forEach((e, i) => {
      // Chaque forme se joue telle quelle.
      expect(shapeCost(e.notes.map((h) => ({ string: 6 - h.string, fret: h.fret })))).not.toBeNull();
      const original = events.find((o) => o.start === merged.positions[i]);
      if (!original) return;
      const top = Math.max(...original.pitches);
      for (const a of adds.filter((x) => x.start === original.start)) {
        expect(a.pitch).toBeLessThan(top);
        // Sur un temps, dans l'harmonie de la mesure.
        expect(Number.isInteger(a.start)).toBe(true);
        const chord = (CHORDS[Math.floor(a.start / 4)] as number[]).map((p) => p % 12);
        expect(chord).toContain(a.pitch % 12);
        for (const p of e.pitches) if (p !== a.pitch) expect([1, 11]).not.toContain((((a.pitch - p) % 12) + 12) % 12);
      }
    });
    // Au plus deux notes ajoutées par temps.
    const perStart = new Map<number, number>();
    for (const a of adds) perStart.set(a.start, (perStart.get(a.start) ?? 0) + 1);
    expect(Math.max(...perStart.values())).toBeLessThanOrEqual(2);
  });

  it('notes de passage : celles de la mélodie de la source, entre deux notes de la tablature', async () => {
    const events = tabEvents();
    // La source joue en plus un fa♯ (66) à 3,5 et un ré (62) à 9,5.
    const source = await aligned(sourceSong(false, [[3.5, 66], [9.5, 62]]), events);
    const adds = suggest(events, events.map((e) => e.start), STANDARD, [source]).filter((a) => a.kind === 'passing');
    expect(adds.map((a) => [a.start, a.pitch])).toEqual([
      [3.5, 66],
      [9.5, 62],
    ]);
    const merged = applyAdditions(events, events.map((e) => e.start), adds, STANDARD);
    expect(merged.positions).toContain(3.5);
    expect(merged.events).toHaveLength(events.length + 2);
  });

  it('rien sans source retenue', () => {
    const events = tabEvents();
    expect(suggest(events, events.map((e) => e.start), STANDARD, [])).toEqual([]);
  });

  it('en position haute, pas de note qui forcerait un écart', async () => {
    // Même mélodie une octave plus haut (cases 12 et plus) : la basse ne peut être qu'à vide.
    const high = MELODY.map(([start, [string, fret]]): [number, [number, number]] => [start, [string, fret + 12]]);
    const events = tabEvents(high);
    const song = sourceSong(true);
    song.tracks[0] = { ...(song.tracks[0] as SourceSong['tracks'][number]), onsets: high.map(([start, [s, f]]) => ({ start, pitches: [pitchOf({ string: s, fret: f })] })) };
    const source = await aligned(song, events);
    const adds = suggest(events, events.map((e) => e.start), STANDARD, [source]);
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) {
      // Case à vide, ou dans la position de la main de la note jouée au même instant.
      const own = events.filter((e) => e.start === a.start).flatMap((e) => e.notes.map((h) => h.fret));
      if (a.hit.fret > 0) expect(Math.max(a.hit.fret, ...own) - Math.min(a.hit.fret, ...own)).toBeLessThanOrEqual(5);
    }
  });
});
