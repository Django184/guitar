export type Meter = '2/4' | '3/4' | '4/4' | '6/8';
export type Accent = 'strong' | 'medium' | 'weak';

export const METERS: readonly Meter[] = ['2/4', '3/4', '4/4', '6/8'];
export const MIN_BPM = 30;
export const MAX_BPM = 250;
export const DEFAULT_BPM = 90;

export function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

/** Nombre de clics par mesure. En 6/8, le tempo compte la croche : 6 clics. */
export function beatsPerBar(meter: Meter): number {
  switch (meter) {
    case '2/4':
      return 2;
    case '3/4':
      return 3;
    case '4/4':
      return 4;
    case '6/8':
      return 6;
  }
}

/** Premier temps fort ; en 6/8, 4e croche en accent secondaire (2 temps de 3 croches). */
export function accentFor(meter: Meter, beatInBar: number): Accent {
  if (beatInBar === 0) return 'strong';
  if (meter === '6/8' && beatInBar === 3) return 'medium';
  return 'weak';
}

export interface ScheduledBeat {
  /** Instant du clic, sur l'horloge de l'AudioContext (secondes). */
  time: number;
  beatInBar: number;
  accent: Accent;
}

/**
 * Horloge des temps, sans dérive.
 * Chaque instant est calculé par multiplication depuis une ancre
 * (ancre + n × durée du temps), jamais par additions successives :
 * l'erreur d'arrondi ne s'accumule pas, même après des heures.
 * Un changement de tempo ou de mesure déplace l'ancre au prochain temps.
 */
export class BeatClock {
  private anchorTime = 0;
  private beatsSinceAnchor = 0;
  private secondsPerBeat = 60 / DEFAULT_BPM;
  private beatInBar = 0;
  private meter: Meter = '4/4';

  start(time: number, bpm: number, meter: Meter): void {
    this.anchorTime = time;
    this.beatsSinceAnchor = 0;
    this.secondsPerBeat = 60 / clampBpm(bpm);
    this.meter = meter;
    this.beatInBar = 0;
  }

  /** Instant du prochain temps à planifier. */
  nextTime(): number {
    return this.anchorTime + this.beatsSinceAnchor * this.secondsPerBeat;
  }

  /** Renvoie le prochain temps et avance d'un temps. */
  next(): ScheduledBeat {
    const beat: ScheduledBeat = {
      time: this.nextTime(),
      beatInBar: this.beatInBar,
      accent: accentFor(this.meter, this.beatInBar),
    };
    this.beatsSinceAnchor += 1;
    this.beatInBar = (this.beatInBar + 1) % beatsPerBar(this.meter);
    return beat;
  }

  /** Nouveau tempo à partir du prochain temps (déjà promis à l'ancien tempo). */
  setTempo(bpm: number): void {
    this.anchorTime = this.nextTime();
    this.beatsSinceAnchor = 0;
    this.secondsPerBeat = 60 / clampBpm(bpm);
  }

  /** Nouvelle mesure : le prochain temps devient un premier temps. */
  setMeter(meter: Meter): void {
    this.meter = meter;
    this.beatInBar = 0;
  }

  /**
   * Si le prochain temps est déjà passé (contexte audio suspendu par le système,
   * onglet gelé), on repart de `time` au lieu de jouer une rafale de clics en retard.
   */
  resync(time: number): boolean {
    if (this.nextTime() >= time) return false;
    this.anchorTime = time;
    this.beatsSinceAnchor = 0;
    return true;
  }
}
