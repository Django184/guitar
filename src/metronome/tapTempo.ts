import { clampBpm } from './scheduler';

/**
 * Tap tempo : moyenne des derniers intervalles entre tapes.
 * Une pause de plus de 2 s recommence une nouvelle série.
 */
export class TapTempo {
  private taps: number[] = [];

  constructor(
    private readonly maxTaps = 6,
    private readonly resetAfterMs = 2000,
  ) {}

  /** Enregistre une tape (horodatage en ms). Renvoie le tempo dès la 2e tape, sinon null. */
  tap(nowMs: number): number | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && (nowMs - last > this.resetAfterMs || nowMs <= last)) this.taps = [];
    this.taps.push(nowMs);
    if (this.taps.length > this.maxTaps) this.taps.shift();
    if (this.taps.length < 2) return null;

    const first = this.taps[0] as number;
    const newest = this.taps[this.taps.length - 1] as number;
    const averageMs = (newest - first) / (this.taps.length - 1);
    return clampBpm(60000 / averageMs);
  }

  reset(): void {
    this.taps = [];
  }
}
