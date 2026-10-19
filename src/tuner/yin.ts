/**
 * Détection de fréquence fondamentale par l'algorithme YIN
 * (de Cheveigné & Kawahara, 2002).
 *
 * Pourquoi YIN plutôt qu'une autocorrélation simple : l'autocorrélation présente
 * des pics de hauteur presque égale à chaque multiple de la période ; sur les
 * cordes graves (Mi grave 82,41 Hz), le 2e harmonique est souvent plus fort que
 * la fondamentale et le pic choisi saute d'une octave. YIN normalise la fonction
 * de différence par sa moyenne cumulée et retient le PREMIER creux sous un seuil
 * absolu, ce qui supprime l'essentiel de ces erreurs d'octave.
 *
 * Étapes : (1) fonction de différence d(τ) ; (2) normalisation par la moyenne
 * cumulée d'(τ) ; (3) premier minimum local sous le seuil ; (4) interpolation
 * parabolique sur d(τ) pour une précision inférieure à l'échantillon
 * (à 110 Hz et 48 kHz, une erreur d'un échantillon vaudrait déjà ~4 cents).
 */

export interface YinOptions {
  sampleRate: number;
  /** Seuil sur d'(τ). Plus bas = plus strict. Défaut 0,15. */
  threshold?: number;
  /** Fréquence minimale cherchée (Hz). Défaut 60 Hz (Ré grave des accordages ouverts = 73,4 Hz). */
  minFrequency?: number;
  /** Fréquence maximale cherchée (Hz). Défaut 1400 Hz (au-delà de la 24e case de la corde aiguë). */
  maxFrequency?: number;
  /** Taille maximale de la fenêtre d'intégration (échantillons). Défaut 3072. */
  maxWindow?: number;
}

export interface PitchEstimate {
  frequency: number;
  /** 1 − d'(τ) au creux retenu : proche de 1 pour un son bien périodique. */
  clarity: number;
}

export class Yin {
  readonly sampleRate: number;
  readonly threshold: number;
  readonly tauMin: number;
  readonly tauMax: number;
  private readonly maxWindow: number;
  private readonly diff: Float64Array;
  private readonly cmnd: Float64Array;

  constructor(options: YinOptions) {
    const { sampleRate, threshold = 0.15, minFrequency = 60, maxFrequency = 1400, maxWindow = 3072 } = options;
    this.sampleRate = sampleRate;
    this.threshold = threshold;
    this.tauMin = Math.max(2, Math.floor(sampleRate / maxFrequency));
    this.tauMax = Math.ceil(sampleRate / minFrequency);
    this.maxWindow = maxWindow;
    this.diff = new Float64Array(this.tauMax + 2);
    this.cmnd = new Float64Array(this.tauMax + 2);
  }

  /** Taille de tampon minimale pour couvrir la fréquence la plus grave. */
  get minBufferSize(): number {
    return this.tauMax * 2 + 1;
  }

  /** Renvoie la fréquence détectée, ou null si le signal n'est pas assez périodique. */
  detect(buffer: Float32Array): PitchEstimate | null {
    const { tauMin, tauMax, threshold, diff, cmnd } = this;
    const window = Math.min(buffer.length - tauMax - 1, this.maxWindow);
    if (window < tauMax) return null;

    diff[0] = 0;
    cmnd[0] = 1;
    let runningSum = 0;
    let best = -1;

    for (let tau = 1; tau <= tauMax + 1; tau++) {
      // (1) Fonction de différence.
      let sum = 0;
      for (let j = 0; j < window; j++) {
        const delta = (buffer[j] as number) - (buffer[j + tau] as number);
        sum += delta * delta;
      }
      diff[tau] = sum;

      // (2) Normalisation par la moyenne cumulée.
      runningSum += sum;
      cmnd[tau] = runningSum > 0 ? (sum * tau) / runningSum : 1;

      // (3) Premier creux sous le seuil, suivi jusqu'à son minimum local.
      if (best < 0) {
        if (tau >= tauMin && (cmnd[tau] as number) < threshold) best = tau;
      } else if ((cmnd[tau] as number) < (cmnd[best] as number)) {
        best = tau;
      } else {
        break; // d(best + 1) est calculé : l'interpolation est possible.
      }
    }

    if (best < 0 || best >= tauMax) return null;

    // (4) Interpolation parabolique autour du creux.
    const left = diff[best - 1] as number;
    const center = diff[best] as number;
    const right = diff[best + 1] as number;
    const curvature = left - 2 * center + right;
    let shift = curvature > 0 ? (left - right) / (2 * curvature) : 0;
    if (shift > 1) shift = 1;
    if (shift < -1) shift = -1;
    const period = best + shift;

    return {
      frequency: this.sampleRate / period,
      clarity: 1 - (cmnd[best] as number),
    };
  }
}

/** Niveau RMS du tampon, pour ignorer le silence et le bruit de fond. */
export function rms(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}
