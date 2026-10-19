import { closeMicrophone, openMicrophone } from '../audio/microphone';
import { AppError } from '../ui/errors';
import { Yin, rms } from './yin';

export interface PitchReading {
  frequency: number;
  clarity: number;
  level: number;
}

interface PitchTrackerCallbacks {
  /** Appelée ~25 fois par seconde : une mesure, ou null (silence / son non périodique). */
  onReading: (reading: PitchReading | null) => void;
  /** Le micro s'est arrêté de lui-même (débranché, coupé par le système). */
  onError: (error: AppError) => void;
}

/** Seuil de niveau sous lequel on considère qu'aucune corde ne sonne. */
const SILENCE_RMS = 0.006;
/** Clarté minimale pour accepter une mesure. */
const MIN_CLARITY = 0.85;
/** Intervalle minimal entre deux analyses (ms). */
const ANALYSIS_INTERVAL_MS = 40;

/**
 * Chaîne d'analyse : micro → passe-haut 50 Hz → passe-bas 1,5 kHz → AnalyserNode.
 * Le passe-bas atténue les harmoniques aiguës et rend la fondamentale plus nette.
 * L'analyseur est relié à la sortie via un gain nul : certains navigateurs
 * (Safari) ne font pas tourner un nœud qui n'aboutit pas à la destination.
 */
export class PitchTracker {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(0);
  private yin: Yin | null = null;
  private frame = 0;
  private lastAnalysis = 0;

  constructor(private readonly callbacks: PitchTrackerCallbacks) {}

  get running(): boolean {
    return this.stream !== null;
  }

  async start(ctx: AudioContext): Promise<void> {
    if (this.running) return;
    const stream = await openMicrophone();
    // iOS peut interrompre le contexte en ouvrant le micro : on le relance.
    if (ctx.state !== 'running') await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 50, Q: 0.707 });
    const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1500, Q: 0.707 });
    const analyser = new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0 });
    const mute = new GainNode(ctx, { gain: 0 });
    source.connect(highpass).connect(lowpass).connect(analyser).connect(mute).connect(ctx.destination);

    this.stream = stream;
    this.nodes = [source, highpass, lowpass, analyser, mute];
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    this.yin = new Yin({ sampleRate: ctx.sampleRate });

    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stop();
        this.callbacks.onError(new AppError('mic-disconnected'));
      });
    }

    this.lastAnalysis = 0;
    this.frame = requestAnimationFrame(this.loop);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.nodes.forEach((node) => node.disconnect());
    this.nodes = [];
    this.analyser = null;
    closeMicrophone(this.stream);
    this.stream = null;
  }

  private readonly loop = (now: number): void => {
    if (!this.analyser || !this.yin) return;
    this.frame = requestAnimationFrame(this.loop);
    if (now - this.lastAnalysis < ANALYSIS_INTERVAL_MS) return;
    this.lastAnalysis = now;

    this.analyser.getFloatTimeDomainData(this.buffer);
    const level = rms(this.buffer);
    if (level < SILENCE_RMS) {
      this.callbacks.onReading(null);
      return;
    }
    const estimate = this.yin.detect(this.buffer);
    if (!estimate || estimate.clarity < MIN_CLARITY) {
      this.callbacks.onReading(null);
      return;
    }
    this.callbacks.onReading({ frequency: estimate.frequency, clarity: estimate.clarity, level });
  };
}
