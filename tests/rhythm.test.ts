import { describe, expect, it } from 'vitest';
import { type Onset, type TimedOnset, alignOnsets, bestAlignment, credible } from '../src/scores/rhythm/align';
import { type SourceTiming, consensus } from '../src/scores/rhythm/consensus';
import { type AlignedSource, combine } from '../src/scores/rhythm/findRhythm';
import { download, normalizeProxy, parseClaudeAnswer, searchBitMidi, songQuery, titleMatch } from '../src/scores/rhythm/search';
import { type SourceSong, songFromMidi } from '../src/scores/rhythm/sources';
import type { ScoreEvent } from '../src/scores/sync/scoreEvents';

/** Générateur pseudo-aléatoire reproductible. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const SCALE = [0, 2, 4, 5, 7, 9, 11];
const DURATIONS = [0.5, 0.5, 1, 0.25, 0.25, 1.5, 0.75, 2];

/** Mélodie (do majeur, autour du do 4) avec son rythme, en noires depuis 0. */
function melody(length: number, seed: number): TimedOnset[] {
  const rnd = random(seed);
  const out: TimedOnset[] = [];
  let degree = 7;
  let t = 0;
  for (let i = 0; i < length; i++) {
    degree = Math.max(0, Math.min(14, degree + Math.round((rnd() - 0.5) * 4)));
    const pitch = 60 + 12 * Math.floor(degree / 7) + (SCALE[degree % 7] as number) - 12;
    out.push({ start: t, pitches: [pitch] });
    t += DURATIONS[Math.floor(rnd() * DURATIONS.length)] as number;
  }
  return out;
}

/** Accompagnement : accord de do, fa ou sol (grave) sur chaque temps. */
function accompaniment(end: number, seed: number): TimedOnset[] {
  const rnd = random(seed);
  const chords = [
    [36, 43, 48],
    [41, 45, 48],
    [43, 47, 50],
  ];
  const out: TimedOnset[] = [];
  for (let t = 0; t < end; t += 1) out.push({ start: t, pitches: chords[Math.floor(rnd() * 3)] as number[] });
  return out;
}

/** Une piste « piano » : la mélodie et l'accompagnement réunis. */
function piano(mel: TimedOnset[], acc: TimedOnset[], shift = 0, scale = 1): TimedOnset[] {
  const byStart = new Map<number, number[]>();
  for (const o of [...mel, ...acc]) byStart.set(o.start * scale, [...(byStart.get(o.start * scale) ?? []), ...o.pitches.map((p) => p + shift)]);
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, pitches]) => ({ start, pitches }));
}

/** Tablature : un passage de la mélodie, une octave plus bas, au rythme inconnu. */
function tabOf(mel: TimedOnset[], from: number, count: number): Onset[] {
  return mel.slice(from, from + count).map((o) => ({ pitches: o.pitches.map((p) => p - 12) }));
}

function events(tab: Onset[]): ScoreEvent[] {
  return tab.map((o, i) => ({ bar: Math.floor(i / 8), onset: (i % 8) * 0.5, start: i * 0.5, pitches: o.pitches, notes: [] }));
}

const song = (tracks: TimedOnset[][], beats = 4, beatType = 4): SourceSong => ({
  tracks: tracks.map((onsets, i) => ({ name: `Piste ${i + 1}`, guitar: false, onsets })),
  bars: Array.from({ length: 200 }, (_, i) => ({ start: (i * beats * 4) / beatType, beats, beatType })),
  tempos: [{ start: 0, bpm: 132 }],
});

describe('Rythme : alignement de la tablature', () => {
  const mel = melody(160, 3);
  const tab = tabOf(mel, 40, 60);

  it('retrouve chaque note dans la mélodie, une octave plus haut', () => {
    // Notes de la source + décalage = notes de la tablature.
    const a = alignOnsets(tab, mel, -12);
    expect(a).not.toBeNull();
    expect(Array.from(a?.match ?? [])).toEqual(Array.from({ length: 60 }, (_, i) => 40 + i));
    expect(a?.quality).toBeCloseTo(1, 5);
  });

  it('trouve la piste et le décalage dans un morceau à plusieurs pistes (piano transposé)', async () => {
    const acc = accompaniment(200, 5);
    const other = melody(160, 99);
    const a = await bestAlignment(tab, [{ onsets: other }, { onsets: piano(mel, acc, 3) }, { onsets: acc }]);
    expect(a?.track).toBe(1);
    expect(a?.shift).toBe(-15);
    expect(credible(a as NonNullable<typeof a>)).toBe(true);
    expect(a?.match[0]).toBeGreaterThanOrEqual(0);
  });

  it('écarte un autre morceau dans la même tonalité', async () => {
    for (const seed of [11, 12, 13, 14]) {
      const other = melody(200, seed);
      const a = await bestAlignment(tab, [{ onsets: other }, { onsets: piano(other, accompaniment(250, seed), 0) }]);
      expect(a && credible(a)).toBe(false);
    }
  });

  it('tolère quelques fausses notes et notes oubliées dans la tablature', async () => {
    const noisy = tab.filter((_, i) => i % 13 !== 5).map((o, i) => (i % 11 === 3 ? { pitches: [(o.pitches[0] as number) + 1] } : o));
    const a = await bestAlignment(noisy, [{ onsets: mel }]);
    expect(a && credible(a)).toBe(true);
    expect((a?.quality ?? 0) > 0.85).toBe(true);
  });
});

describe('Rythme : vote des sources', () => {
  const timing = (label: string, at: number[], weight = 1, sim = 1): SourceTiming => ({
    label,
    weight,
    at: Float64Array.from(at),
    similarity: Float32Array.from(at, () => sim),
    bars: Array.from({ length: 50 }, (_, i) => ({ start: i * 4, beats: 4, beatType: 4 })),
    tempos: [{ start: 0, bpm: 100 }],
  });
  const original = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];

  it('deux sources d’accord : rythme sûr, place dans la mesure gardée', () => {
    const a = [5, 6, 6.5, 7, 8, 8.5, 9, 10];
    const c = consensus([timing('A', a), timing('B', a.map((x) => x + 16))], original);
    expect(c?.positions).toEqual([1, 2, 2.5, 3, 4, 4.5, 5, 6]);
    expect(c?.counts.sure).toBe(8);
    expect(c?.doubtfulBars).toEqual([]);
    expect(c?.tempo).toBe(100);
  });

  it('ramène une source écrite en valeurs doublées à l’échelle de la plus fiable', () => {
    const a = [4, 5, 5.5, 6, 7, 7.5, 8, 9];
    const doubled = a.map((x) => x * 2);
    const c = consensus([timing('A', a, 1), timing('B', doubled, 0.5)], original);
    expect(c?.positions).toEqual([0, 1, 1.5, 2, 3, 3.5, 4, 5]);
    expect(c?.counts.sure).toBe(8);
  });

  it('majorité de trois sources ; une contradiction à deux est signalée', () => {
    const good = [0, 1, 1.5, 2, 3, 3.5, 4, 5];
    const odd = [0, 1, 1.5, 2, 3, 4, 4.5, 5.5];
    const three = consensus([timing('A', good), timing('B', good), timing('C', odd)], original);
    expect(three?.positions).toEqual(good);
    expect(three?.status[5]).toBe('sure');
    const two = consensus([timing('A', good, 1), timing('C', odd, 0.6)], original);
    expect(two?.positions).toEqual(good);
    expect(two?.status[5]).toBe('disputed');
    expect(two?.doubtfulBars).toEqual([0]);
  });

  it('note introuvable : place déduite de la durée encadrée par la source, mesure signalée', () => {
    const a = [0, 1, NaN, 2, 4, 5, 6, 7];
    const c = consensus([timing('A', a), timing('B', a)], original);
    expect(c?.positions[3]).toBe(2);
    expect(c?.status[2]).toBe('missing');
    expect(c?.doubtfulBars).toEqual([0]);
  });
});

describe('Rythme : de bout en bout (sources lues)', () => {
  it('réécrit les positions de la tablature d’après deux sources', async () => {
    const mel = melody(120, 21);
    const tab = tabOf(mel, 10, 50);
    const truth = mel.slice(10, 60).map((o) => o.start);
    const sources: AlignedSource[] = [];
    for (const [label, s] of [
      ['A', song([mel])],
      ['B', song([piano(mel, accompaniment(200, 2), -2, 2)], 4, 4)],
    ] as const) {
      const alignment = await bestAlignment(
        tab,
        s.tracks.map((t) => ({ onsets: t.onsets })),
      );
      sources.push({ label, song: s, alignment, used: !!alignment && credible(alignment) });
    }
    expect(sources.every((s) => s.used)).toBe(true);
    const c = combine(events(tab), sources);
    const rel = (c?.positions ?? []).map((p) => p - (c?.positions[0] ?? 0));
    expect(rel).toEqual(truth.map((t) => t - (truth[0] as number)));
    // Première note à sa place dans la mesure (4/4).
    expect((c?.positions[0] ?? -1) % 4).toBe((truth[0] as number) % 4);
  });
});

describe('Rythme : sources', () => {
  it('lit un fichier MIDI : attaques groupées, voix du dessus en plus', () => {
    const s = songFromMidi({
      ppq: 480,
      tempo: 90,
      timeSignature: { beats: 3, beatType: 4 },
      parts: [
        {
          name: 'Piano',
          channel: 0,
          program: 0,
          notes: [
            { tick: 0, duration: 480, pitch: 48, velocity: 90 },
            { tick: 10, duration: 480, pitch: 72, velocity: 90 },
            { tick: 480, duration: 480, pitch: 50, velocity: 90 },
            { tick: 480, duration: 480, pitch: 74, velocity: 90 },
          ],
        },
        { name: 'Guitare', channel: 1, program: 25, notes: [{ tick: 960, duration: 480, pitch: 52, velocity: 90 }] },
      ],
    });
    expect(s.tracks.map((t) => t.name)).toEqual(['Piano', 'Piano (dessus)', 'Guitare']);
    expect(s.tracks[0]?.onsets).toEqual([
      { start: 0, pitches: [48, 72] },
      { start: 1, pitches: [50, 74] },
    ]);
    expect(s.tracks[1]?.onsets.map((o) => o.pitches)).toEqual([[72], [74]]);
    expect(s.tracks[2]?.guitar).toBe(true);
    expect(s.bars[0]).toEqual({ start: 0, beats: 3, beatType: 4 });
    expect(s.tempos).toEqual([{ start: 0, bpm: 90 }]);
  });
});

describe('Rythme : recherche', () => {
  it('nettoie le titre d’un fichier', () => {
    expect(songQuery('Megalovania_Tab_v1.1')).toBe('Megalovania');
    expect(songQuery('Partition_-_Made_in_Abyss_-_The_First_Layer_')).toBe('Made in Abyss The First Layer');
    expect(titleMatch('Made in Abyss The First Layer', 'Made In Abyss - The First Layer (Piano)')).toBe(1);
  });

  it('cherche dans BitMidi : noms proches du titre, sans doublon', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return Response.json({
        result: {
          results: [
            { name: 'Undertale - Megalovania.mid', downloadUrl: '/uploads/1.mid' },
            { name: 'Megalovania (remix).mid', downloadUrl: '/uploads/2.mid' },
            { name: 'Sans theme.mid', downloadUrl: '/uploads/3.mid' },
          ],
        },
      });
    }) as unknown as typeof fetch;
    const found = await searchBitMidi('Megalovania_Tab_v1.1', 'Toby Fox', 6, fetchFn);
    expect(found.map((f) => f.url)).toEqual(['https://bitmidi.com/uploads/1.mid', 'https://bitmidi.com/uploads/2.mid']);
    expect(calls[0]).toBe('https://bitmidi.com/api/midi/search?q=Megalovania&pageSize=20');
    expect(calls).toHaveLength(2);
  });

  it('lit la réponse de Claude : JSON, ou à défaut les adresses du texte', () => {
    const json = 'Voici :\n```json\n{"sources":[{"url":"https://www.vgmusic.com/music/x.mid","titre":"Megalovania"},{"url":"https://musescore.com/score/1"}]}\n```';
    expect(parseClaudeAnswer(json)).toEqual([{ title: 'Megalovania', url: 'https://www.vgmusic.com/music/x.mid', source: 'vgmusic.com' }]);
    const text = 'Essaie https://example.org/files/song.gp5, et https://tabs.ultimate-guitar.com/x.';
    expect(parseClaudeAnswer(text)).toEqual([{ title: 'song.gp5', url: 'https://example.org/files/song.gp5', source: 'example.org' }]);
  });

  it('adresse du proxy : https, sans chemin', () => {
    expect(normalizeProxy('pratique-guitare-proxy.jonas.workers.dev/')).toBe('https://pratique-guitare-proxy.jonas.workers.dev');
    expect(normalizeProxy('http://evil.example')).toBeNull();
    expect(normalizeProxy('')).toBeNull();
  });

  it('télécharge BitMidi directement, les autres sites par le proxy', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return new Response(Uint8Array.from([0x4d, 0x54, 0x68, 0x64]));
    }) as unknown as typeof fetch;
    await download('https://bitmidi.com/uploads/1.mid', 'https://p.workers.dev', fetchFn);
    await download('https://example.org/a.mid', 'https://p.workers.dev', fetchFn);
    expect(calls).toEqual(['https://bitmidi.com/uploads/1.mid', 'https://p.workers.dev/fetch?url=https%3A%2F%2Fexample.org%2Fa.mid']);
    await expect(download('https://musescore.com/x', 'https://p.workers.dev', fetchFn)).rejects.toThrow('importez');
  });
});
