/**
 * Lien entre la partition affichée (modèle alphaTab) et le calage sur un enregistrement :
 * liste des attaques (notes ou accords) dans l'ordre, réécriture d'une tablature avec le
 * rythme retrouvé, points de synchronisation.
 */
import type { Score } from '../alphatab';
import { tabScore, type TabHit, type TabOnset } from '../pdf/asciiTab';
import { toMusicXml } from '../pdf/musicxml';
import { barSyncPoints, type FitEvent, type SyncPoint } from './rhythmFit';

/** Ticks MIDI d'alphaTab par noire. */
const QUARTER = 960;

export interface ScoreEvent {
  /** Mesure (index). */
  bar: number;
  /** Position dans la mesure, en noires. */
  onset: number;
  /** Position depuis le début, en noires. */
  start: number;
  /** Hauteurs MIDI entendues (capodastre compris). */
  pitches: number[];
  /** Cordes (1 = la plus aiguë) et cases, si la partition a une tablature. */
  notes: TabHit[];
}

type Track = Score['tracks'][number];
type Staff = Track['staves'][number];

/** Portée à caler : la tablature si la piste en a une. */
function mainStaff(track: Track): Staff | undefined {
  return track.staves.find((s) => s.showTablature && s.tuning.length > 0) ?? track.staves[0];
}

/** Reprises ou fins alternatives : l'ordre de lecture n'est plus l'ordre écrit. */
export function hasRepeats(score: Score): boolean {
  return score.masterBars.some((mb) => mb.isRepeatStart || mb.repeatCount > 0 || mb.alternateEndings > 0);
}

/** Attaques de la piste, dans l'ordre (voix confondues ; notes liées ignorées). */
export function scoreEvents(score: Score, trackIndex: number): ScoreEvent[] {
  const track = score.tracks[trackIndex];
  const staff = track && mainStaff(track);
  if (!staff) return [];
  const strings = staff.tuning.length;
  const byStart = new Map<number, ScoreEvent>();
  for (const bar of staff.bars) {
    const master = score.masterBars[bar.index];
    if (!master) continue;
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        const notes = beat.notes.filter((n) => !n.isTieDestination);
        if (!notes.length) continue;
        const ticks = master.start + beat.playbackStart;
        let event = byStart.get(ticks);
        if (!event) {
          event = { bar: bar.index, onset: beat.playbackStart / QUARTER, start: ticks / QUARTER, pitches: [], notes: [] };
          byStart.set(ticks, event);
        }
        for (const n of notes) {
          event.pitches.push(n.realValue);
          if (strings > 0 && n.string > 0 && n.fret >= 0) event.notes.push({ string: strings - n.string + 1, fret: n.fret });
        }
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** Événements à dater pour le calcul du rythme. */
export function fitEvents(events: ScoreEvent[], times: Array<number | null>): FitEvent[] {
  return events.map((e, i) => ({ bar: e.bar, onset: e.onset, time: times[i] ?? null }));
}

export function barLength(score: Score): number {
  const mb = score.masterBars[0];
  return mb ? (mb.timeSignatureNumerator * 4) / mb.timeSignatureDenominator : 4;
}

export function barStarts(score: Score): number[] {
  return score.masterBars.map((mb) => mb.start / QUARTER);
}

/** Points de synchronisation d'une partition dont le rythme est juste (positions écrites). */
export function syncFromTimes(score: Score, events: ScoreEvent[], times: Array<number | null>): SyncPoint[] {
  return barSyncPoints(
    events.map((e) => e.start),
    times,
    barStarts(score),
  );
}

/**
 * Tablature réécrite avec le rythme retrouvé : mêmes notes (cordes, cases), nouvelles positions
 * (en noires depuis le début), tempo de l'enregistrement. Renvoie le MusicXML et les débuts
 * de mesure (en noires) de la nouvelle partition.
 */
export function rewriteTab(
  score: Score,
  trackIndex: number,
  events: ScoreEvent[],
  positions: number[],
  tempo: number,
): { xml: string; barStarts: number[] } {
  const track = score.tracks[trackIndex];
  const staff = track && mainStaff(track);
  const master = score.masterBars[0];
  const time = { beats: master?.timeSignatureNumerator ?? 4, beatType: master?.timeSignatureDenominator ?? 4 };
  const length = (time.beats * 4) / time.beatType;
  const first = Math.min(0, ...positions);
  const measures: TabOnset[][] = [];
  events.forEach((e, i) => {
    const pos = (positions[i] as number) - first;
    const bar = Math.floor(pos / length + 1e-9);
    while (measures.length <= bar) measures.push([]);
    const list = measures[bar] as TabOnset[];
    const onset = Math.round((pos - bar * length) * 4) / 4;
    const last = list[list.length - 1];
    if (last && Math.abs(last.onset - onset) < 1e-9) last.notes.push(...e.notes);
    else list.push({ onset, notes: [...e.notes] });
  });
  const rec = tabScore(measures, {
    time,
    tuning: staff ? [...staff.tuning] : [64, 59, 55, 50, 45, 40],
    capo: staff?.capo ?? 0,
    title: score.title,
    artist: score.artist,
    tempo: tempo > 0 ? Math.round(tempo) : null,
  });
  return { xml: toMusicXml(rec), barStarts: measures.map((_, i) => i * length) };
}
