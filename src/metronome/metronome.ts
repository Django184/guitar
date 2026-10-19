import { audibleTime, setAudioSession, unlockAudio } from '../audio/context';
import { allowSleep, keepAwake } from '../shell/wakeLock';
import { createClickBuffers } from './clicks';
import { type Accent, BeatClock, type Meter, type ScheduledBeat, beatsPerBar, clampBpm } from './scheduler';
import { Ticker } from './ticker';

/** Fenêtre d'anticipation : les clics sont confiés à l'horloge audio 120 ms à l'avance. */
const LOOKAHEAD_S = 0.12;
/** Délai avant le tout premier clic, le temps que le graphe audio démarre. */
const START_DELAY_S = 0.08;

export interface BeatEvent {
  beatInBar: number;
  beats: number;
  accent: Accent;
}

/**
 * Métronome planifié sur l'horloge de l'AudioContext (« A Tale of Two Clocks »).
 * Le Worker réveille la planification ; chaque clic est démarré par
 * `source.start(instant exact)`, à l'échantillon près. Le minuteur peut avoir du
 * retard sans conséquence tant qu'il reste inférieur à la fenêtre d'anticipation.
 */
export class Metronome {
  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private buffers: Record<Accent, AudioBuffer> | null = null;
  private readonly clock = new BeatClock();
  private readonly ticker = new Ticker(() => this.schedule());
  private readonly pending = new Set<AudioBufferSourceNode>();
  private visualQueue: ScheduledBeat[] = [];
  private frame = 0;
  private playing = false;
  private bpmValue: number;
  private meterValue: Meter;
  private readonly beatListeners = new Set<(beat: BeatEvent | null) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(bpm: number, meter: Meter) {
    this.bpmValue = clampBpm(bpm);
    this.meterValue = meter;
  }

  get bpm(): number {
    return this.bpmValue;
  }

  get meter(): Meter {
    return this.meterValue;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** À appeler directement depuis un geste utilisateur (déblocage audio iOS). */
  async start(): Promise<void> {
    if (this.playing) return;
    setAudioSession('playback');
    const ctx = await unlockAudio();
    if (this.ctx !== ctx) {
      this.ctx = ctx;
      this.buffers = createClickBuffers(ctx);
      this.output = new GainNode(ctx, { gain: 0.9 });
      this.output.connect(ctx.destination);
    }
    this.clock.start(ctx.currentTime + START_DELAY_S, this.bpmValue, this.meterValue);
    this.visualQueue = [];
    this.playing = true;
    this.schedule();
    this.ticker.start();
    this.frame = requestAnimationFrame(this.draw);
    keepAwake('metronome');
    this.emitChange();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.ticker.stop();
    cancelAnimationFrame(this.frame);
    // Coupe les clics déjà confiés à l'horloge audio mais pas encore joués.
    for (const source of this.pending) {
      try {
        source.stop();
      } catch {
        // Déjà terminé.
      }
    }
    this.pending.clear();
    this.visualQueue = [];
    allowSleep('metronome');
    this.emitBeat(null);
    this.emitChange();
  }

  toggle(): Promise<void> | void {
    return this.playing ? this.stop() : this.start();
  }

  setBpm(bpm: number): void {
    const next = clampBpm(bpm);
    if (next === this.bpmValue) return;
    this.bpmValue = next;
    if (this.playing) this.clock.setTempo(next);
    this.emitChange();
  }

  setMeter(meter: Meter): void {
    if (meter === this.meterValue) return;
    this.meterValue = meter;
    if (this.playing) this.clock.setMeter(meter);
    this.emitChange();
  }

  /** Relance l'horloge audio si le système l'a suspendue (retour d'arrière-plan, appel). */
  resumeIfInterrupted(): void {
    if (this.playing && this.ctx && this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {
        // Un geste utilisateur sera nécessaire : le prochain toucher relancera le son.
      });
    }
  }

  /** Un clic est entendu (null = arrêt). Synchronisé sur la sortie audio réelle. */
  onBeat(listener: (beat: BeatEvent | null) => void): () => void {
    this.beatListeners.add(listener);
    return () => this.beatListeners.delete(listener);
  }

  /** Tempo, mesure ou état lecture/arrêt modifiés. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Planifie tous les clics qui tombent dans la fenêtre d'anticipation. */
  private schedule(): void {
    const ctx = this.ctx;
    if (!this.playing || !ctx || !this.buffers || !this.output) return;
    // Contexte suspendu ou interrompu (appel entrant sur iOS) : on attend sa reprise.
    if (ctx.state !== 'running') return;

    this.clock.resync(ctx.currentTime + 0.02);
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    while (this.clock.nextTime() < horizon) {
      const beat = this.clock.next();
      const source = new AudioBufferSourceNode(ctx, { buffer: this.buffers[beat.accent] });
      source.connect(this.output);
      source.onended = () => this.pending.delete(source);
      source.start(beat.time);
      this.pending.add(source);
      this.visualQueue.push(beat);
    }
  }

  /** Affiche chaque temps quand il sort réellement du haut-parleur. */
  private readonly draw = (): void => {
    if (!this.playing || !this.ctx) return;
    const now = audibleTime(this.ctx);
    let due: ScheduledBeat | undefined;
    while (this.visualQueue.length > 0 && (this.visualQueue[0] as ScheduledBeat).time <= now) {
      due = this.visualQueue.shift();
    }
    if (due) {
      this.emitBeat({ beatInBar: due.beatInBar, beats: beatsPerBar(this.meterValue), accent: due.accent });
    }
    this.frame = requestAnimationFrame(this.draw);
  };

  private emitBeat(beat: BeatEvent | null): void {
    this.beatListeners.forEach((listener) => listener(beat));
  }

  private emitChange(): void {
    this.changeListeners.forEach((listener) => listener());
  }
}
