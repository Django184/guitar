/**
 * Transcriptions trouvées (MIDI, Guitar Pro, MusicXML) → pistes d'attaques datées, mesures et
 * tempo : ce qu'il faut pour y retrouver la tablature et en lire le rythme.
 */
import type { Score } from '../alphatab';
import type { MidiSong } from '../midi';
import type { TimedOnset } from './align';

/** Ticks MIDI d'alphaTab par noire. */
const QUARTER = 960;

export interface SourceBar {
  /** Début, en noires depuis le début du morceau. */
  start: number;
  beats: number;
  beatType: number;
}

export interface SourceTrack {
  name: string;
  /** Piste de guitare (programme General MIDI 24 à 31, ou tablature). */
  guitar: boolean;
  onsets: TimedOnset[];
}

export interface SourceSong {
  tracks: SourceTrack[];
  bars: SourceBar[];
  /** Changements de tempo (noires par minute), dans l'ordre. */
  tempos: Array<{ start: number; bpm: number }>;
}

/** Transcription lue, avec son nom (affiché). */
export interface LoadedSource {
  label: string;
  song: SourceSong;
}

const isGuitarProgram = (program: number): boolean => program >= 24 && program <= 31;

/** Notes regroupées en attaques : même début, à `tolerance` noire près. */
function group(notes: Array<{ start: number; pitch: number }>, tolerance: number): TimedOnset[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const out: TimedOnset[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n.start - last.start <= tolerance) {
      if (!last.pitches.includes(n.pitch)) last.pitches.push(n.pitch);
    } else {
      out.push({ start: n.start, pitches: [n.pitch] });
    }
  }
  return out;
}

/**
 * Pistes à plusieurs voix (piano, accords) : la voix du dessus en plus, comme piste à part. La
 * mélodie y est souvent seule, et s'y retrouve sans se perdre dans l'accompagnement.
 */
function withTopVoices(tracks: SourceTrack[]): SourceTrack[] {
  const out: SourceTrack[] = [];
  for (const t of tracks) {
    out.push(t);
    const notes = t.onsets.reduce((sum, o) => sum + o.pitches.length, 0);
    if (notes < t.onsets.length * 1.3) continue;
    out.push({ name: `${t.name} (dessus)`, guitar: t.guitar, onsets: t.onsets.map((o) => ({ start: o.start, pitches: [Math.max(...o.pitches)] })) });
  }
  return out;
}

/** Fichier MIDI lu par midi.ts (batterie déjà écartée). */
export function songFromMidi(song: MidiSong): SourceSong {
  const ppq = song.ppq || 480;
  // Petites imprécisions d'un fichier joué au clavier : 1/16 de noire.
  const tolerance = 1 / 16;
  const tracks = song.parts
    .map((part, i) => ({
      name: part.name || `Piste ${i + 1}`,
      guitar: isGuitarProgram(part.program),
      onsets: group(
        part.notes.map((n) => ({ start: n.tick / ppq, pitch: n.pitch })),
        tolerance,
      ),
    }))
    .filter((t) => t.onsets.length > 0);
  const { beats, beatType } = song.timeSignature;
  const length = (beats * 4) / beatType;
  const end = Math.max(0, ...tracks.map((t) => t.onsets[t.onsets.length - 1]?.start ?? 0));
  const bars: SourceBar[] = [];
  for (let start = 0; start <= end + 1e-9; start += length) bars.push({ start, beats, beatType });
  return { tracks: withTopVoices(tracks), bars, tempos: [{ start: 0, bpm: song.tempo || 120 }] };
}

type Track = Score['tracks'][number];
type Staff = Track['staves'][number];

function staffNotes(score: Score, staff: Staff): Array<{ start: number; pitch: number }> {
  const out: Array<{ start: number; pitch: number }> = [];
  for (const bar of staff.bars) {
    const master = score.masterBars[bar.index];
    if (!master) continue;
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        const start = (master.start + beat.playbackStart) / QUARTER;
        for (const note of beat.notes) {
          if (note.isTieDestination || note.isDead) continue;
          out.push({ start, pitch: note.realValue });
        }
      }
    }
  }
  return out;
}

/** Partition lue par alphaTab (Guitar Pro, MusicXML). */
export function songFromScore(score: Score): SourceSong {
  const tracks: SourceTrack[] = [];
  score.tracks.forEach((track, ti) => {
    const staves = track.staves.filter((s) => !s.isPercussion);
    if (!staves.length) return;
    const name = track.name || `Piste ${ti + 1}`;
    const guitar = isGuitarProgram(track.playbackInfo.program) || staves.some((s) => s.showTablature && s.tuning.length > 0);
    const perStaff = staves.map((s) => staffNotes(score, s));
    // Piano (deux portées) : chaque main seule, puis les deux ensemble.
    if (perStaff.length > 1) {
      perStaff.forEach((notes, si) => {
        if (notes.length) tracks.push({ name: `${name} (${si + 1})`, guitar, onsets: group(notes, 0) });
      });
    }
    const all = perStaff.flat();
    if (all.length) tracks.push({ name, guitar, onsets: group(all, 0) });
  });
  const bars: SourceBar[] = score.masterBars.map((mb) => ({
    start: mb.start / QUARTER,
    beats: mb.timeSignatureNumerator,
    beatType: mb.timeSignatureDenominator,
  }));
  const tempos: Array<{ start: number; bpm: number }> = [];
  for (const mb of score.masterBars) {
    for (const a of mb.tempoAutomations) {
      if (a.value > 0) tempos.push({ start: mb.start / QUARTER + a.ratioPosition * (mb.calculateDuration() / QUARTER), bpm: a.value });
    }
  }
  if (!tempos.length || (tempos[0] as { start: number }).start > 0) tempos.unshift({ start: 0, bpm: score.tempo || 120 });
  return { tracks: withTopVoices(tracks), bars, tempos };
}
