import type { Accent } from './scheduler';

interface ClickSpec {
  frequency: number;
  gain: number;
}

/**
 * Premier temps : plus aigu (Sol 6, 1568 Hz) et plus fort.
 * Autres temps : Do 6 (1047 Hz), nettement plus doux.
 * Accent secondaire du 6/8 : même hauteur que les temps faibles, plus fort.
 */
const SPECS: Record<Accent, ClickSpec> = {
  strong: { frequency: 1568, gain: 1 },
  medium: { frequency: 1047, gain: 0.72 },
  weak: { frequency: 1047, gain: 0.42 },
};

const DURATION_S = 0.07;

/** Clic synthétisé une fois pour toutes : sinus amorti, attaque franche. */
function renderClick(ctx: BaseAudioContext, { frequency, gain }: ClickSpec): AudioBuffer {
  const length = Math.ceil(DURATION_S * ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const attack = 0.0008;
  const decay = 0.014;
  for (let i = 0; i < length; i++) {
    const t = i / ctx.sampleRate;
    const envelope = Math.min(1, t / attack) * Math.exp(-t / decay);
    const tone = 0.8 * Math.sin(2 * Math.PI * frequency * t) + 0.2 * Math.sin(2 * Math.PI * frequency * 2.01 * t);
    data[i] = gain * envelope * tone;
  }
  return buffer;
}

export function createClickBuffers(ctx: BaseAudioContext): Record<Accent, AudioBuffer> {
  return {
    strong: renderClick(ctx, SPECS.strong),
    medium: renderClick(ctx, SPECS.medium),
    weak: renderClick(ctx, SPECS.weak),
  };
}
