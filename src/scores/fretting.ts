/**
 * Placement des notes sur le manche (corde + case) pour générer une tablature
 * quand le fichier n'en contient pas (MIDI, MusicXML issu d'un PDF converti).
 *
 * La main gauche couvre quatre cases (une par doigt) à partir de sa position.
 * Pour chaque accord, on cherche l'affectation de cordes distinctes qui minimise :
 * l'écartement des doigts, les cases hors de la position actuelle de la main
 * et la hauteur sur le manche. Les cordes à vide ne coûtent rien.
 * La main ne se déplace que lorsqu'une note sort de sa position.
 */

/** Accordage standard, de la corde 6 (grave) à la corde 1 (aiguë), en hauteurs MIDI. */
export const STANDARD_TUNING: readonly number[] = [40, 45, 50, 55, 59, 64];

export const MAX_FRET = 20;
const MAX_STRETCH = 4;
/** Au-delà, un accord n'est pas jouable par une main : on retire des notes. */
const MAX_NOTES = 6;

export interface FretPosition {
  /** Index de corde : 0 = la plus grave. */
  string: number;
  fret: number;
}

export function isPlayable(pitch: number, tuning: readonly number[] = STANDARD_TUNING, maxFret = MAX_FRET): boolean {
  return tuning.some((open) => pitch - open >= 0 && pitch - open <= maxFret);
}

/** Proportion des hauteurs jouables sur l'instrument (sert à décider si une piste mérite une tablature). */
export function playableRatio(pitches: readonly number[], tuning: readonly number[] = STANDARD_TUNING): number {
  if (pitches.length === 0) return 0;
  return pitches.filter((p) => isPlayable(p, tuning)).length / pitches.length;
}

interface Candidate {
  string: number;
  fret: number;
}

export class Fretter {
  /** Case de l'index : la main couvre les cases hand … hand + 3. */
  private hand = 1;

  constructor(
    private readonly tuning: readonly number[] = STANDARD_TUNING,
    private readonly maxFret = MAX_FRET,
  ) {}

  /**
   * Place un accord (ou une note seule). Le résultat suit l'ordre des hauteurs
   * données ; une note impossible à placer vaut null (elle reste en notation classique).
   */
  assign(pitches: readonly number[]): Array<FretPosition | null> {
    const result: Array<FretPosition | null> = pitches.map(() => null);
    if (pitches.length === 0) return result;

    // Notes retenues : les MAX_NOTES premières par ordre d'importance (basse et mélodie d'abord).
    const order = pitches.map((pitch, index) => ({ pitch, index })).sort((a, b) => a.pitch - b.pitch);
    const kept =
      order.length <= MAX_NOTES
        ? order
        : [order[0], ...order.slice(order.length - (MAX_NOTES - 1))].filter((x): x is { pitch: number; index: number } => !!x);

    const candidates = kept.map(({ pitch }) => this.candidatesFor(pitch));
    // Les notes les plus contraintes d'abord : l'exploration est plus courte.
    const exploreOrder = kept
      .map((_, i) => i)
      .sort((a, b) => (candidates[a]?.length ?? 0) - (candidates[b]?.length ?? 0));

    let best: { cost: number; choice: Array<Candidate | null> } | null = null;
    const choice: Array<Candidate | null> = kept.map(() => null);
    const used = new Set<number>();

    const explore = (depth: number, skipped: number): void => {
      if (best && skipped * 50 > best.cost) return;
      if (depth === exploreOrder.length) {
        const cost = this.cost(choice) + skipped * 50;
        if (!best || cost < best.cost) best = { cost, choice: [...choice] };
        return;
      }
      const slot = exploreOrder[depth] as number;
      for (const candidate of candidates[slot] ?? []) {
        if (used.has(candidate.string)) continue;
        used.add(candidate.string);
        choice[slot] = candidate;
        explore(depth + 1, skipped);
        used.delete(candidate.string);
      }
      choice[slot] = null;
      explore(depth + 1, skipped + 1);
    };
    explore(0, 0);

    const chosen = (best as { cost: number; choice: Array<Candidate | null> } | null)?.choice ?? [];
    kept.forEach(({ index }, i) => {
      const c = chosen[i];
      if (c) result[index] = { string: c.string, fret: c.fret };
    });

    const fretted = chosen.filter((c): c is Candidate => !!c && c.fret > 0).map((c) => c.fret);
    if (fretted.length > 0) {
      const low = Math.min(...fretted);
      const high = Math.max(...fretted);
      if (low < this.hand) this.hand = low;
      else if (high > this.hand + 3) this.hand = Math.max(1, high - 3);
    }
    return result;
  }

  private candidatesFor(pitch: number): Candidate[] {
    const list: Candidate[] = [];
    this.tuning.forEach((open, string) => {
      const fret = pitch - open;
      if (fret >= 0 && fret <= this.maxFret) list.push({ string, fret });
    });
    // Ordre d'exploration : cases proches de la main d'abord (meilleure coupe de l'arbre).
    return list.sort((a, b) => Math.abs(a.fret - this.hand) - Math.abs(b.fret - this.hand));
  }

  private cost(choice: Array<Candidate | null>): number {
    const placed = choice.filter((c): c is Candidate => c !== null);
    const fretted = placed.filter((c) => c.fret > 0).map((c) => c.fret);
    if (fretted.length === 0) return 0; // cordes à vide uniquement : idéal
    const low = Math.min(...fretted);
    const high = Math.max(...fretted);
    const span = high - low;
    // Cases hors de la position actuelle : la main doit se déplacer.
    const outside = fretted.reduce((sum, f) => {
      if (f < this.hand) return sum + (this.hand - f);
      if (f > this.hand + 3) return sum + (f - this.hand - 3);
      return sum;
    }, 0);
    let cost = span * 1.5 + outside * 2.5 + low * 0.1;
    if (span > MAX_STRETCH) cost += 100 + span * 10;
    return cost;
  }
}
