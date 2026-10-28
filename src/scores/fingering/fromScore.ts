/**
 * Notes de la tablature affichée (modèle alphaTab) → notes à doigter, et retour.
 * Chaque note a un identifiant stable tant que la partition ne change pas :
 * « mesure:voix:temps:corde ». Une note liée prolonge sa note d'origine (même doigt).
 */
import type { Score } from '../alphatab';
import { type Finger, type FingerNote, fingerNotes } from './fingering';

type Track = Score['tracks'][number];
type Staff = Track['staves'][number];
type Note = Staff['bars'][number]['voices'][number]['beats'][number]['notes'][number];

/** Ticks MIDI d'alphaTab par noire. */
const QUARTER = 960;

/** Portée de tablature de la piste (la première), s'il y en a une. */
export function tabStaff(score: Score, trackIndex: number): Staff | null {
  const track = score.tracks[trackIndex];
  return track?.staves.find((s) => s.showTablature && s.tuning.length > 0) ?? null;
}

export const noteId = (note: Note): string => `${note.beat.voice.bar.index}:${note.beat.voice.index}:${note.beat.index}:${note.string}`;

export interface TabFingering {
  /** Doigt de chaque note (identifiant), 0 pour une corde à vide. */
  fingers: Map<string, Finger>;
  /** Notes de la tablature, par identifiant (pour l'affichage). */
  notes: Map<string, Note>;
}

/** Doigt écrit dans le fichier (Guitar Pro…) : 0 pouce, 1 à 4 ; autre valeur : aucun. */
function writtenFinger(note: Note): Finger | null {
  const f = note.leftHandFinger as number;
  return f === 0 ? 5 : f >= 1 && f <= 4 ? (f as Finger) : null;
}

/**
 * Doigtés de la tablature d'une piste. Doigts imposés : ceux écrits dans le fichier, puis ceux
 * choisis par l'utilisateur (`overrides`, prioritaires).
 */
export function fingerTab(score: Score, trackIndex: number, overrides: ReadonlyMap<string, Finger> = new Map()): TabFingering | null {
  const staff = tabStaff(score, trackIndex);
  if (!staff) return null;
  const strings = staff.tuning.length;
  const notes = new Map<string, Note>();
  const forced = new Map<string, Finger>(overrides);
  const input: FingerNote[] = [];
  const byId = new Map<string, FingerNote>();
  /** Note liée → note d'origine de la chaîne. */
  const root = new Map<string, string>();

  for (const bar of staff.bars) {
    const master = score.masterBars[bar.index];
    if (!master) continue;
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        const start = (master.start + beat.playbackStart) / QUARTER;
        const end = start + beat.playbackDuration / QUARTER;
        for (const note of beat.notes) {
          if (note.string < 1 || note.fret < 0 || note.isDead) continue;
          const id = noteId(note);
          notes.set(id, note);
          const written = writtenFinger(note);
          if (written !== null && !forced.has(id)) forced.set(id, written);
          const origin = note.isTieDestination ? note.tieOrigin : null;
          const originId = origin ? root.get(noteId(origin)) ?? noteId(origin) : null;
          const head = originId ? byId.get(originId) : undefined;
          if (originId && head) {
            // Liaison de prolongation : la note d'origine sonne plus longtemps, même doigt.
            root.set(id, originId);
            head.end = Math.max(head.end, end);
            continue;
          }
          const fn: FingerNote = {
            id,
            string: note.string - 1,
            fret: note.fret,
            start,
            end,
            legato: note.isHammerPullDestination,
            slide: !!note.slideOrigin,
          };
          input.push(fn);
          byId.set(id, fn);
        }
      }
    }
  }

  const fingers = fingerNotes(input, { overrides: forced, strings });
  for (const [id, head] of root) fingers.set(id, fingers.get(head) ?? 0);
  return { fingers, notes };
}
