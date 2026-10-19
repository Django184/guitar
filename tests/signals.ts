/** Générateurs de signaux synthétiques « type guitare » pour les tests. */

export interface ToneOptions {
  /** Amplitudes des partiels 1, 2, 3… (la guitare a souvent un 2e harmonique plus fort que la fondamentale). */
  partials?: number[];
  /** Constante de temps de décroissance (s). */
  decay?: number;
  /** Amplitude du bruit blanc ajouté. */
  noise?: number;
  /** Coefficient d'inharmonicité des cordes (f_n = n·f0·√(1 + B·n²)). */
  inharmonicity?: number;
  /** Décalage de départ en échantillons (phase quelconque dans la note). */
  offset?: number;
}

export const GUITAR_PARTIALS = [0.5, 1, 0.8, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08];

export function tone(frequency: number, sampleRate: number, length: number, options: ToneOptions = {}): Float32Array {
  const { partials = GUITAR_PARTIALS, decay, noise = 0, inharmonicity = 0, offset = 0 } = options;
  const buffer = new Float32Array(length);
  let seed = 1234567;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < length; i++) {
    const t = (i + offset) / sampleRate;
    let value = 0;
    partials.forEach((amplitude, k) => {
      const n = k + 1;
      const fn = n * frequency * Math.sqrt(1 + inharmonicity * n * n);
      value += amplitude * Math.sin(2 * Math.PI * fn * t + k * 0.7);
    });
    if (decay) value *= Math.exp(-t / decay);
    buffer[i] = 0.2 * value + noise * random();
  }
  return buffer;
}

export const cents = (frequency: number, reference: number): number => 1200 * Math.log2(frequency / reference);
