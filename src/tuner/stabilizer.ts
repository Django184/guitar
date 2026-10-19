/**
 * Stabilise l'affichage : médiane glissante des dernières mesures, et
 * confirmation avant tout saut de plus d'un demi-ton (une mesure isolée
 * fausse, typiquement sur l'attaque du médiator, est ignorée).
 */
export class PitchStabilizer {
  private history: number[] = [];
  private candidates: number[] = [];

  constructor(
    private readonly size = 5,
    private readonly jumpSemitones = 0.6,
    private readonly confirmations = 2,
  ) {}

  /** Ajoute une mesure (Hz). Renvoie la fréquence stabilisée, ou null tant qu'elle n'est pas confirmée. */
  push(frequency: number): number | null {
    const midi = 69 + 12 * Math.log2(frequency / 440);

    if (this.history.length > 0 && Math.abs(midi - median(this.history)) <= this.jumpSemitones) {
      this.candidates = [];
      this.history.push(midi);
      if (this.history.length > this.size) this.history.shift();
    } else {
      // Première mesure ou changement de note : il faut des mesures concordantes.
      if (this.candidates.length > 0 && Math.abs(midi - median(this.candidates)) > this.jumpSemitones) {
        this.candidates = [];
      }
      this.candidates.push(midi);
      if (this.candidates.length >= this.confirmations) {
        this.history = this.candidates;
        this.candidates = [];
      }
    }

    if (this.history.length === 0) return null;
    return 440 * 2 ** ((median(this.history) - 69) / 12);
  }

  reset(): void {
    this.history = [];
    this.candidates = [];
  }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
