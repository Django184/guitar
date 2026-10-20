import { describe, expect, it } from 'vitest';
import { alignAudio } from '../src/scores/sync/audioAlign';
import { MediaClock } from '../src/scores/sync/media';
import { barSyncPoints, fitRhythm, scalePositions, type FitEvent } from '../src/scores/sync/rhythmFit';
import { SearchError, parseYouTubeUrl, searchQuery, searchYouTube } from '../src/scores/sync/youtube';

/* Calage d'une tablature sur un enregistrement : rythme, alignement audio, YouTube. */

/** Générateur pseudo-aléatoire reproductible. */
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Motif de Megalovania en doubles croches : ré ré ré' la sol# sol fa ré fa sol. */
const RIFF = [1, 1, 2, 3, 2, 2, 2, 1, 1, 1];

/** Événements tapés : instants (avec imprécision) d'une suite de durées en doubles croches. */
function tapped(durations: number[], bpm: number, options: { barLength: number; barsKnown: boolean; jitter?: number; seed?: number }): { events: FitEvent[]; truth: number[] } {
  const rnd = random(options.seed ?? 1);
  const sixteenth = 60 / bpm / 4;
  let grid = 0;
  let t = 1;
  const events: FitEvent[] = [];
  const truth: number[] = [];
  durations.forEach((d, i) => {
    const pos = grid / 4;
    truth.push(pos);
    const bar = Math.floor(pos / options.barLength);
    // Position actuelle : celle d'une tablature sans rythme (croches régulières), ou la vraie mesure.
    events.push(
      options.barsKnown
        ? { bar, onset: pos - bar * options.barLength, time: t + (rnd() - 0.5) * 2 * (options.jitter ?? 0.015) }
        : { bar: Math.floor(i / 8), onset: (i % 8) * 0.5, time: t + (rnd() - 0.5) * 2 * (options.jitter ?? 0.015) },
    );
    grid += d;
    t += d * sixteenth;
  });
  return { events, truth };
}

describe('Rythme retrouvé à partir des instants', () => {
  it('sans barres de mesure : doubles croches, croche pointée (Megalovania à 120)', () => {
    const { events, truth } = tapped(Array.from({ length: 8 }, () => RIFF).flat(), 120, { barLength: 4, barsKnown: false });
    const fit = fitRhythm(events, { barLength: 4, barsKnown: false });
    expect(fit.positions).toEqual(truth);
    expect(fit.tempo).toBeGreaterThan(115);
    expect(fit.tempo).toBeLessThan(125);
  });

  it('barres connues, 3/4 en croches avec une syncope, tempo qui accélère de 15 %', () => {
    const durations = Array.from({ length: 16 }, (_, i) => (i % 4 === 3 ? [3, 1, 2, 2, 2, 2] : [2, 2, 2, 2, 2, 2])).flat();
    const sixteenth0 = 60 / 75 / 4;
    let grid = 0;
    let t = 0.5;
    const rnd = random(5);
    const events: FitEvent[] = [];
    const truth: number[] = [];
    durations.forEach((d, i) => {
      const pos = grid / 4;
      truth.push(pos);
      const bar = Math.floor(pos / 3);
      // Indice faux (espacement régulier) : seule la mesure est sûre.
      events.push({ bar, onset: 0, time: t + (rnd() - 0.5) * 0.04 });
      grid += d;
      t += d * sixteenth0 * (1 - (0.15 * i) / durations.length);
    });
    const fit = fitRhythm(events, { barLength: 3, barsKnown: true });
    expect(fit.positions).toEqual(truth);
  });

  it('notes non datées : avant la plage inchangées, après décalées comme la dernière datée', () => {
    const { events, truth } = tapped(Array.from({ length: 3 }, () => RIFF).flat(), 120, { barLength: 4, barsKnown: false });
    const partial = events.map((e, i) => (i < 5 || i > 24 ? { ...e, time: null } : e));
    const fit = fitRhythm(partial, { barLength: 4, barsKnown: false });
    expect(fit.timed).toBe(20);
    const orig = partial.map((e) => e.bar * 4 + e.onset);
    expect(fit.positions.slice(0, 5)).toEqual(orig.slice(0, 5));
    // Dans la plage : mêmes écarts que la vérité.
    for (let i = 6; i <= 24; i++) expect((fit.positions[i] as number) - (fit.positions[i - 1] as number)).toBe((truth[i] as number) - (truth[i - 1] as number));
    const shift = (fit.positions[24] as number) - (orig[24] as number);
    expect((fit.positions[25] as number) - (orig[25] as number)).toBeCloseTo(shift, 9);
  });

  it('valeurs doublées ou divisées par deux, points de synchronisation des mesures', () => {
    expect(scalePositions([1, 1.5, 2.25], 2)).toEqual([1, 2, 3.5]);
    expect(scalePositions([0, 1, 2], 0.5)).toEqual([0, 0.5, 1]);
    // Noire = 0,5 s, première note à 1 s, mesures de 4 temps.
    const points = barSyncPoints([0, 1, 2, 3, 4, 6], [1, 1.5, 2, 2.5, 3, 4], [0, 4, 8]);
    expect(points.map((p) => p.millisecondOffset)).toEqual([1000, 3000, 5000]);
    expect(points.every((p) => p.barPosition === 0 && p.barOccurence === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Alignement d'un enregistrement (guitare synthétisée)                */
/* ------------------------------------------------------------------ */

/** Corde pincée (Karplus-Strong). */
function pluck(out: Float32Array, rate: number, start: number, midi: number, seed: number): void {
  const period = Math.max(2, Math.round(rate / (440 * 2 ** ((midi - 69) / 12))));
  const rnd = random(seed);
  const buf = Float32Array.from({ length: period }, () => rnd() * 2 - 1);
  const i0 = Math.round(start * rate);
  for (let n = 0, idx = 0; n < Math.min(out.length - i0, rate * 2); n++) {
    const next = (idx + 1) % period;
    const v = buf[idx] as number;
    buf[idx] = 0.996 * 0.5 * (v + (buf[next] as number));
    out[i0 + n] = (out[i0 + n] as number) + 0.25 * v;
    idx = next;
  }
}

function render(notes: Array<{ time: number; pitches: number[] }>, rate: number, duration: number): Float32Array {
  const out = new Float32Array(Math.round(duration * rate));
  notes.forEach((n, i) => n.pitches.forEach((p, j) => pluck(out, rate, n.time, p, i * 7 + j + 1)));
  const rnd = random(99);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (rnd() - 0.5) * 0.01;
  return out;
}

describe('Alignement d’un enregistrement sur les notes de la tablature', () => {
  const rate = 22050;
  // Arpèges en drop D + capo 2 (accords de deux notes et notes seules), croches à 90.
  const pattern = [[59, 44], [58], [59], [61, 42], [59], [61], [59, 40], [57], [59], [58, 42], [59], [58]];
  const events = Array.from({ length: 3 }, () => pattern).flat().map((pitches) => ({ pitches }));
  const truth = events.map((_, i) => 1.5 + i * (60 / 90 / 2));

  it('chaque note retrouvée à 30 ms près, malgré une introduction', async () => {
    const audio = render(events.map((e, i) => ({ time: truth[i] as number, pitches: e.pitches })), rate, (truth[truth.length - 1] as number) + 2);
    const result = await alignAudio(audio, rate, events);
    expect(result.transpose).toBe(0);
    expect(result.matched).toBeGreaterThan(0.8);
    result.times.forEach((t, i) => expect(Math.abs((t as number) - (truth[i] as number))).toBeLessThan(0.03));
  });

  it('enregistrement transposé (+2 demi-tons) et doubles croches rapides', async () => {
    const fast = truth.map((_, i) => 1 + i * (60 / 130 / 4));
    const audio = render(events.map((e, i) => ({ time: fast[i] as number, pitches: e.pitches.map((p) => p + 2) })), rate, (fast[fast.length - 1] as number) + 2);
    const result = await alignAudio(audio, rate, events);
    expect(result.transpose).toBe(2);
    const good = result.times.filter((t, i) => t !== null && Math.abs(t - (fast[i] as number)) < 0.03).length;
    expect(good).toBeGreaterThanOrEqual(events.length - 1);
  });

  it('enregistrement trop court : aucune note', async () => {
    const result = await alignAudio(new Float32Array(1000), rate, events);
    expect(result.times.every((t) => t === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* YouTube et horloge du lecteur                                       */
/* ------------------------------------------------------------------ */

describe('YouTube', () => {
  it('liens reconnus', () => {
    const id = 'dQw4w9WgXcQ';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}&t=42s`,
      `https://youtu.be/${id}?si=abc`,
      `youtube.com/shorts/${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://music.youtube.com/watch?v=${id}&list=x`,
      id,
    ]) {
      expect(parseYouTubeUrl(url)).toBe(id);
    }
    expect(parseYouTubeUrl('https://vimeo.com/123')).toBeNull();
    expect(parseYouTubeUrl('bonjour')).toBeNull();
  });

  it('recherche construite à partir du titre de la partition', () => {
    expect(searchQuery('Megalovania Tab v1.1')).toBe('Megalovania guitar');
    expect(searchQuery('Made in Abyss : The First Layer - Kevin Penkin')).toBe('Made in Abyss : The First Layer - Kevin Penkin guitar');
    expect(searchQuery('Romance', 'Guitare classique')).toBe('Romance Guitare classique');
  });

  it('résultats de l’API (titres décodés) et erreurs expliquées', async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: { videoId: 'AAAAAAAAAAA' }, snippet: { title: 'Rock &amp; Roll &#39;live&#39;', channelTitle: 'Chaîne', thumbnails: { medium: { url: 'https://i.ytimg.com/a.jpg' } } } },
            { id: { videoId: 'trop-court' }, snippet: { title: 'Invalide' } },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const results = await searchYouTube('rock', 'clé', ok);
    expect(results).toEqual([{ id: 'AAAAAAAAAAA', title: "Rock & Roll 'live'", channel: 'Chaîne', thumbnail: 'https://i.ytimg.com/a.jpg' }]);

    const failing = (reason: string, status = 403) =>
      (async () => new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status })) as unknown as typeof fetch;
    await expect(searchYouTube('x', 'k', failing('quotaExceeded'))).rejects.toMatchObject({ problem: 'quota' });
    await expect(searchYouTube('x', 'k', failing('ipRefererBlocked'))).rejects.toMatchObject({ problem: 'referer' });
    await expect(searchYouTube('x', 'k', failing('keyInvalid', 400))).rejects.toMatchObject({ problem: 'key' });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(searchYouTube('x', 'k', offline)).rejects.toBeInstanceOf(SearchError);
  });

  it('horloge lissée : position extrapolée entre deux relevés espacés', () => {
    let now = 0;
    const clock = new MediaClock(() => now);
    clock.observe(10, false, 1);
    expect(clock.estimate(false, 1)).toBe(10);
    // Lecture : le lecteur ne met sa position à jour que tous les 250 ms.
    clock.observe(10, true, 1);
    now = 100;
    expect(clock.estimate(true, 1)).toBeCloseTo(10.1, 6);
    now = 260;
    clock.observe(10.25, true, 1);
    now = 400;
    expect(clock.estimate(true, 1)).toBeCloseTo(10.39, 6);
    // Vitesse 0,5.
    clock.reset();
    clock.observe(20, false, 0.5);
    clock.observe(20, true, 0.5);
    now = 600;
    expect(clock.estimate(true, 0.5)).toBeCloseTo(20.1, 6);
  });
});
