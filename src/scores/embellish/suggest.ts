/**
 * Enrichissement d'une tablature à partir des transcriptions qui la contiennent (celles que le
 * panneau « Rythme » a retrouvées) : basse, notes de l'accord, notes de passage de la mélodie.
 *
 * Chaque note proposée vient d'une source, au même instant (après alignement), et doit rester :
 * - jouable : corde libre, case dans la position de la main (4 cases, 5 en position haute,
 *   d'après les notes voisines), forme tenable à quatre doigts (barré compris), sans pouce ;
 * - cohérente : présente dans la moitié au moins des sources qui couvrent cet instant, sans
 *   frottement d'un demi-ton avec les notes de la tablature, sous la mélodie (qui reste en haut).
 * Basse et accords seulement sur les temps (lisibilité), au plus deux notes ajoutées par temps.
 */
import { shapeCost } from '../fingering/fingering';
import type { TabHit } from '../pdf/asciiTab';
import type { AlignedSource } from '../rhythm/findRhythm';
import type { TimedOnset } from '../rhythm/align';
import type { ScoreEvent } from '../sync/scoreEvents';

export type AddKind = 'bass' | 'chord' | 'passing';

export interface Addition {
  /** Identifiant stable : nature, position, corde. */
  id: string;
  kind: AddKind;
  /** Position, en noires (temps de la tablature). */
  start: number;
  hit: TabHit;
  pitch: number;
  /** Nombre de sources qui ont cette note. */
  support: number;
}

export interface GuitarSetup {
  /** Hauteur à vide de chaque corde, la plus aiguë (corde 1) d'abord. */
  tuning: number[];
  capo: number;
}

/** Case la plus haute proposée. */
const MAX_FRET = 15;
/** Attaques simultanées dans une source : à 1/32 de noire près. */
const SAME = 1 / 32;
/** Grille des notes de passage : la double croche. */
const GRID = 4;

const pcOf = (p: number): number => ((p % 12) + 12) % 12;
const EPS = 1e-6;

/** Frottement d'un demi-ton (ou de septième majeure) avec une note déjà là. */
const clashes = (p: number, others: readonly number[]): boolean => others.some((q) => [1, 11].includes(pcOf(p - q)));

/** Toutes les notes d'une source, par attaque (pistes réunies, sans doublon). */
function sonorities(source: AlignedSource): TimedOnset[] {
  const byStart = new Map<number, Set<number>>();
  for (const track of source.song.tracks) {
    for (const o of track.onsets) {
      const key = Math.round(o.start / SAME);
      const set = byStart.get(key) ?? new Set<number>();
      for (const p of o.pitches) set.add(p);
      byStart.set(key, set);
    }
  }
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([key, set]) => ({ start: key * SAME, pitches: [...set] }));
}

function at(list: TimedOnset[], start: number): number[] {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = (list[mid] as TimedOnset).start;
    if (Math.abs(s - start) <= SAME / 2) return (list[mid] as TimedOnset).pitches;
    if (s < start) lo = mid + 1;
    else hi = mid - 1;
  }
  return [];
}

/** Piste plutôt mélodique (une note à la fois) : ses notes sautées sont des notes de passage. */
function melodic(onsets: readonly TimedOnset[]): boolean {
  const notes = onsets.reduce((sum, o) => sum + o.pitches.length, 0);
  return notes <= onsets.length * 1.2;
}

export function suggest(events: readonly ScoreEvent[], positions: readonly number[], guitar: GuitarSetup, sources: readonly AlignedSource[]): Addition[] {
  const strings = guitar.tuning.length;
  const used = sources.filter((s) => s.used && s.alignment);
  if (!used.length || !strings) return [];
  const pitchOf = (h: TabHit): number => (guitar.tuning[h.string - 1] as number) + h.fret + guitar.capo;
  const lowest = Math.min(...guitar.tuning) + guitar.capo;
  // Forme pour l'optimiseur de doigtés : corde 0 = la plus grave.
  const playable = (hits: readonly TabHit[]): number | null => shapeCost(hits.map((h) => ({ string: strings - h.string, fret: h.fret })), strings);

  /** Cases frettées autour d'un instant (l'événement, sinon ses voisins) : position de la main. */
  const handAround = (indices: number[]): number[] => {
    for (const set of [indices, indices.flatMap((i) => [i - 1, i, i + 1])]) {
      const frets = set.flatMap((i) => events[i]?.notes.map((h) => h.fret).filter((f) => f > 0) ?? []);
      if (frets.length) return frets;
    }
    return [];
  };
  const fits = (fret: number, around: readonly number[]): boolean => {
    if (fret === 0) return true;
    if (!around.length) return fret <= 5;
    const lo = Math.min(fret, ...around);
    const hi = Math.max(fret, ...around);
    return hi - lo <= (lo >= 7 ? 5 : 4);
  };
  /** Meilleure place d'une hauteur dans une forme : corde libre, position de la main, forme tenable. */
  const place = (pitch: number, shape: readonly TabHit[], around: readonly number[], near?: number): { hit: TabHit; cost: number } | null => {
    let best: { hit: TabHit; cost: number } | null = null;
    for (let s = 1; s <= strings; s++) {
      if (shape.some((h) => h.string === s)) continue;
      const fret = pitch - (guitar.tuning[s - 1] as number) - guitar.capo;
      if (fret < 0 || fret > MAX_FRET || !fits(fret, around)) continue;
      const hit = { string: s, fret };
      const cost = playable([...shape, hit]);
      if (cost === null) continue;
      const total = cost + (fret === 0 ? 0 : 0.3) + (near !== undefined ? 0.1 * Math.abs(fret - near) : 0);
      if (!best || total < best.cost) best = { hit, cost: total };
    }
    return best;
  };

  const tables = used.map((s) => sonorities(s));
  const out: Addition[] = [];
  const add = (kind: AddKind, start: number, hit: TabHit, pitch: number, support: number): void => {
    out.push({ id: `${kind}:${start}:${hit.string}`, kind, start, hit, pitch, support });
  };

  // --- Basse et notes de l'accord, sur les temps ---
  events.forEach((ev, i) => {
    const pos = positions[i] as number;
    if (!ev.notes.length || Math.abs(pos - Math.round(pos)) > EPS) return;
    const mine = ev.notes.map(pitchOf);
    const top = Math.max(...mine);
    const low = Math.min(...mine);
    const votes = new Map<number, { count: number; bass: number }>();
    let covering = 0;
    used.forEach((s, k) => {
      const a = s.alignment;
      const j = a?.match[i] ?? -1;
      if (!a || j < 0 || (a.similarity[i] as number) <= 0) return;
      const t = s.song.tracks[a.track]?.onsets[j]?.start;
      if (t === undefined) return;
      const sound = at(tables[k] as TimedOnset[], t).map((p) => p + a.shift);
      if (!sound.length) return;
      covering++;
      const bassPc = pcOf(Math.min(...sound));
      for (const pc of new Set(sound.map(pcOf))) {
        const v = votes.get(pc) ?? { count: 0, bass: 0 };
        v.count++;
        if (pc === bassPc) v.bass++;
        votes.set(pc, v);
      }
    });
    const need = Math.max(1, Math.ceil(covering / 2));
    const mineSet = new Set(mine.map(pcOf));
    const candidates = [...votes.entries()].filter(([pc, v]) => v.count >= need && !mineSet.has(pc) && !clashes(pc, mine));
    if (!candidates.length) return;
    const shape: TabHit[] = [...ev.notes];
    const sounding = [...mine];
    const around = handAround([i]);
    let floor = lowest;
    let added = 0;

    // Basse : la plus grave des sources, au moins une tierce sous la tablature.
    const bass = candidates.filter(([, v]) => v.bass >= need).sort((a, b) => b[1].count - a[1].count)[0];
    if (bass) {
      for (let p = lowest + pcOf(bass[0] - lowest); p <= low - 3; p += 12) {
        const spot = place(p, shape, around);
        if (!spot) continue;
        shape.push(spot.hit);
        sounding.push(p);
        floor = p + 1;
        add('bass', pos, spot.hit, p, bass[1].count);
        added++;
        break;
      }
    }
    // Notes de l'accord : entre la basse et la mélodie, la plus proche de la mélodie d'abord.
    const tones = candidates.filter(([pc]) => pc !== bass?.[0]).sort((a, b) => b[1].count - a[1].count);
    for (const [pc, v] of tones) {
      if (added >= 2) break;
      if (clashes(pc, sounding)) continue;
      for (let p = top - 1; p >= floor; p--) {
        if (pcOf(p) !== pc || sounding.includes(p)) continue;
        const spot = place(p, shape, around);
        if (!spot) continue;
        shape.push(spot.hit);
        sounding.push(p);
        add('chord', pos, spot.hit, p, v.count);
        added++;
        break;
      }
    }
  });

  // --- Notes de passage : celles de la mélodie d'une source entre deux notes consécutives ---
  const passing = new Map<string, { start: number; pitch: number; after: number; count: number }>();
  const pairCover = new Map<number, number>();
  used.forEach((s) => {
    const a = s.alignment;
    const track = a ? s.song.tracks[a.track] : undefined;
    if (!a || !track || !melodic(track.onsets)) return;
    for (let i = 0; i + 1 < events.length; i++) {
      const j1 = a.match[i] as number;
      const j2 = a.match[i + 1] as number;
      if (j1 < 0 || j2 < 0 || (a.similarity[i] as number) <= 0 || (a.similarity[i + 1] as number) <= 0) continue;
      // Cette source couvre les deux notes : elle vote (pour ou contre une note entre elles).
      pairCover.set(i, (pairCover.get(i) ?? 0) + 1);
      if (j2 <= j1 + 1) continue;
      const t1 = (track.onsets[j1] as TimedOnset).start;
      const t2 = (track.onsets[j2] as TimedOnset).start;
      const p1 = positions[i] as number;
      const p2 = positions[i + 1] as number;
      const tops = [events[i], events[i + 1]].map((e) => Math.max(...(e?.notes.map(pitchOf) ?? [0])));
      for (let j = j1 + 1; j < j2; j++) {
        const o = track.onsets[j] as TimedOnset;
        const start = Math.round((p1 + ((o.start - t1) / (t2 - t1)) * (p2 - p1)) * GRID) / GRID;
        if (start < p1 + 1 / GRID - EPS || start > p2 - 1 / GRID + EPS) continue;
        const pitch = Math.max(...o.pitches) + a.shift;
        // Dans le registre de la mélodie : à moins d'une sixte de ses deux voisines.
        if (tops.some((t) => Math.abs(pitch - t) > 9)) continue;
        const key = `${start}:${pitch}`;
        const v = passing.get(key) ?? { start, pitch, after: i, count: 0 };
        v.count++;
        passing.set(key, v);
      }
    }
  });
  const taken = new Set<number>();
  for (const v of [...passing.values()].sort((a, b) => a.start - b.start)) {
    if (v.count < Math.max(1, Math.ceil((pairCover.get(v.after) ?? 1) / 2)) || taken.has(v.start)) continue;
    const prevTop = events[v.after]?.notes.reduce<TabHit | null>((best, h) => (!best || pitchOf(h) > pitchOf(best) ? h : best), null);
    const spot = place(v.pitch, [], handAround([v.after, v.after + 1]), prevTop?.fret);
    if (!spot) continue;
    taken.add(v.start);
    add('passing', v.start, spot.hit, v.pitch, v.count);
  }
  return out.sort((a, b) => a.start - b.start || a.hit.string - b.hit.string);
}

/**
 * Tablature enrichie : les notes ajoutées aux attaques existantes, les notes de passage en
 * attaques nouvelles. Renvoie les attaques et leurs positions, dans l'ordre.
 */
export function applyAdditions(
  events: readonly ScoreEvent[],
  positions: readonly number[],
  additions: readonly Addition[],
  guitar: GuitarSetup,
): { events: ScoreEvent[]; positions: number[] } {
  const pitchOf = (h: TabHit): number => (guitar.tuning[h.string - 1] as number) + h.fret + guitar.capo;
  const merged = events.map((e, i) => ({ event: { ...e, notes: [...e.notes], pitches: [...e.pitches] }, position: positions[i] as number }));
  for (const a of additions) {
    let target = merged.find((m) => Math.abs(m.position - a.start) < EPS);
    if (!target) {
      target = { event: { bar: 0, onset: 0, start: a.start, pitches: [], notes: [] }, position: a.start };
      merged.push(target);
    }
    if (target.event.notes.some((h) => h.string === a.hit.string)) continue;
    target.event.notes.push(a.hit);
    target.event.pitches.push(pitchOf(a.hit));
  }
  merged.sort((x, y) => x.position - y.position);
  return { events: merged.map((m) => m.event), positions: merged.map((m) => m.position) };
}
