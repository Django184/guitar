/**
 * Rythme d'une tablature retrouvé dans des transcriptions : alignement de la tablature sur la
 * meilleure piste de chacune, puis vote des sources retenues.
 */
import type { ScoreEvent } from '../sync/scoreEvents';
import { type Onset, type TrackAlignment, bestAlignment, credible } from './align';
import { type Consensus, type SourceTiming, consensus } from './consensus';
import type { LoadedSource, SourceSong } from './sources';

/** Une transcription confrontée à la tablature. */
export interface AlignedSource {
  label: string;
  song: SourceSong;
  alignment: TrackAlignment | null;
  /** La tablature y est vraiment (sinon : écartée du vote). */
  used: boolean;
}

/** Attaques de la tablature, pour l'alignement. */
export const tabOnsets = (events: readonly ScoreEvent[]): Onset[] => events.map((e) => ({ pitches: e.pitches }));

export async function alignSource(tab: readonly Onset[], source: LoadedSource, yieldNow?: () => Promise<void>): Promise<AlignedSource> {
  const alignment = await bestAlignment(
    tab,
    source.song.tracks.map((t) => ({ onsets: t.onsets, guitar: t.guitar })),
    yieldNow ? { yieldNow } : {},
  );
  return { label: source.label, song: source.song, alignment, used: !!alignment && credible(alignment) };
}

/** Vote des sources retenues. */
export function combine(events: readonly ScoreEvent[], sources: readonly AlignedSource[]): Consensus | null {
  const timings: SourceTiming[] = [];
  for (const s of sources) {
    const a = s.alignment;
    if (!s.used || !a) continue;
    const onsets = s.song.tracks[a.track]?.onsets ?? [];
    timings.push({
      label: s.label,
      weight: Math.max(0.05, a.score - a.control),
      at: Float64Array.from(a.match, (j) => (j >= 0 ? (onsets[j]?.start ?? Number.NaN) : Number.NaN)),
      similarity: a.similarity,
      bars: s.song.bars,
      tempos: s.song.tempos,
    });
  }
  return timings.length
    ? consensus(
        timings,
        events.map((e) => e.start),
      )
    : null;
}

/** Nom de la piste retenue dans une source (affiché). */
export const trackName = (s: AlignedSource): string => (s.alignment ? (s.song.tracks[s.alignment.track]?.name ?? '') : '');
