/**
 * Enregistrement du micro en échantillons bruts, daté sur l'horloge de la page
 * (performance.now) : permet de retrouver, pour chaque instant enregistré, la position
 * de la vidéo jouée au même moment.
 */
import { closeMicrophone, openMicrophone } from '../../audio/microphone';

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
  /** Instant (performance.now, ms) de l'échantillon i. */
  timeOf: (index: number) => number;
}

const BUFFER = 4096;

export class PcmRecorder {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private chunks: Float32Array[] = [];
  private total = 0;
  /** (instant de réception, nombre d'échantillons reçus) : l'horloge du micro sur celle de la page. */
  private marks: Array<{ at: number; count: number }> = [];
  private sampleRate = 44100;

  async start(ctx: AudioContext, onLevel?: (rms: number) => void): Promise<void> {
    const stream = await openMicrophone();
    if (ctx.state !== 'running') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor : obsolète mais disponible partout (Safari compris), et suffisant ici.
    const processor = ctx.createScriptProcessor(BUFFER, 1, 1);
    const mute = new GainNode(ctx, { gain: 0 });
    this.sampleRate = ctx.sampleRate;
    this.chunks = [];
    this.total = 0;
    this.marks = [];
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      this.chunks.push(Float32Array.from(data));
      this.total += data.length;
      this.marks.push({ at: performance.now(), count: this.total });
      if (onLevel) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += (data[i] as number) ** 2;
        onLevel(Math.sqrt(sum / data.length));
      }
    };
    source.connect(processor).connect(mute).connect(ctx.destination);
    this.stream = stream;
    this.nodes = [source, processor, mute];
  }

  get recording(): boolean {
    return this.stream !== null;
  }

  /** Arrête et renvoie l'enregistrement (null s'il est vide). */
  stop(): Recording | null {
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    closeMicrophone(this.stream);
    this.stream = null;
    if (!this.total) return null;
    const samples = new Float32Array(this.total);
    let at = 0;
    for (const c of this.chunks) {
      samples.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    // Droite instant = a + b × échantillon, ajustée sur les réceptions (elles arrivent juste
    // après la capture ; le décalage fixe restant est la latence d'entrée).
    const marks = this.marks;
    const sampleRate = this.sampleRate;
    const n = marks.length;
    const mx = marks.reduce((s, m) => s + m.count, 0) / n;
    const my = marks.reduce((s, m) => s + m.at, 0) / n;
    let num = 0;
    let den = 0;
    for (const m of marks) {
      num += (m.count - mx) * (m.at - my);
      den += (m.count - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 1000 / sampleRate;
    // Les réceptions sont en retard : la droite passe par la plus précoce.
    let offset = Infinity;
    for (const m of marks) offset = Math.min(offset, m.at - slope * m.count);
    return { samples, sampleRate, timeOf: (index) => offset + slope * index };
  }
}
