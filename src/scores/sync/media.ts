/**
 * Enregistrement de référence joué à côté de la partition : vidéo YouTube ou fichier audio.
 * Les deux lecteurs exposent la même interface, avec une horloge précise (au centième de seconde
 * près) : le lecteur YouTube ne donne sa position que par à-coups.
 */

export type MediaState = 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export interface ReferenceMedia {
  readonly element: HTMLElement;
  /** Durée (s), 0 tant qu'elle est inconnue. */
  readonly duration: number;
  readonly playing: boolean;
  /** Position estimée maintenant (s). */
  currentTime(): number;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  playbackRate: number;
  /** Volume, de 0 à 1. */
  volume: number;
  onState(listener: (state: MediaState, message?: string) => void): void;
  destroy(): void;
}

/**
 * Horloge lissée : la position brute n'avance que par paliers (lecteur YouTube : ~4 fois par
 * seconde). Entre deux relevés, on extrapole au rythme de lecture ; chaque relevé arrive en
 * retard, l'estimation la plus haute des derniers relevés est donc la plus juste.
 */
export class MediaClock {
  private samples: Array<{ media: number; at: number }> = [];
  private lastRaw = NaN;
  private wasPlaying = false;
  private startAt = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Relevé de la position brute (à appeler souvent pendant la lecture). */
  observe(raw: number, playing: boolean, rate: number): void {
    const at = this.now();
    const started = playing && !this.wasPlaying;
    this.wasPlaying = playing;
    if (!playing) {
      // À l'arrêt, la position brute est exacte.
      this.samples = [{ media: raw, at }];
      this.lastRaw = raw;
      return;
    }
    if (started) {
      // Au départ, le son ne suit pas tout de suite l'événement « lecture » : on attend le
      // premier changement de position (en extrapolant d'ici là depuis la position de départ).
      this.samples = [];
      this.lastRaw = raw;
      this.startAt = at;
      return;
    }
    if (raw === this.lastRaw) return;
    const last = this.samples[this.samples.length - 1];
    // Saut (recherche, boucle) : on repart de zéro.
    if (last && Math.abs(raw - (last.media + ((at - last.at) / 1000) * rate)) > 0.5) this.samples = [];
    this.lastRaw = raw;
    this.samples.push({ media: raw, at });
    if (this.samples.length > 8) this.samples.shift();
  }

  estimate(playing: boolean, rate: number): number {
    if (!this.samples.length) {
      if (Number.isNaN(this.lastRaw)) return 0;
      return playing && this.wasPlaying ? this.lastRaw + ((this.now() - this.startAt) / 1000) * rate : this.lastRaw;
    }
    if (!playing) return (this.samples[this.samples.length - 1] as { media: number }).media;
    const at = this.now();
    let best = -Infinity;
    for (const s of this.samples) best = Math.max(best, s.media + ((at - s.at) / 1000) * rate);
    return best;
  }

  reset(): void {
    this.samples = [];
    this.lastRaw = NaN;
    this.wasPlaying = false;
  }
}

/** Fichier audio de l'utilisateur, lu par un élément <audio>. */
export class AudioFileMedia implements ReferenceMedia {
  readonly element: HTMLAudioElement;
  private readonly url: string;
  private listeners: Array<(state: MediaState, message?: string) => void> = [];

  constructor(bytes: Uint8Array, type: string) {
    this.url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: type || 'audio/mpeg' }));
    this.element = document.createElement('audio');
    this.element.className = 'media__audio';
    this.element.controls = true;
    this.element.preload = 'auto';
    this.element.src = this.url;
    const emit = (state: MediaState, message?: string): void => this.listeners.forEach((l) => l(state, message));
    this.element.addEventListener('loadedmetadata', () => emit('ready'));
    this.element.addEventListener('play', () => emit('playing'));
    this.element.addEventListener('pause', () => emit(this.element.ended ? 'ended' : 'paused'));
    this.element.addEventListener('error', () => emit('error', 'Ce fichier audio ne peut pas être lu par le navigateur.'));
  }

  get duration(): number {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0;
  }

  get playing(): boolean {
    return !this.element.paused && !this.element.ended;
  }

  currentTime(): number {
    return this.element.currentTime;
  }

  play(): void {
    void this.element.play().catch(() => {
      // Lecture refusée (pas de geste) : l'utilisateur relancera.
    });
  }

  pause(): void {
    this.element.pause();
  }

  seek(seconds: number): void {
    this.element.currentTime = Math.max(0, seconds);
  }

  get playbackRate(): number {
    return this.element.playbackRate;
  }

  set playbackRate(rate: number) {
    this.element.playbackRate = rate;
  }

  get volume(): number {
    return this.element.volume;
  }

  set volume(value: number) {
    this.element.volume = Math.min(1, Math.max(0, value));
  }

  onState(listener: (state: MediaState, message?: string) => void): void {
    this.listeners.push(listener);
  }

  destroy(): void {
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
    URL.revokeObjectURL(this.url);
    this.listeners = [];
  }
}

/** Fréquence de décodage : l'analyse n'utilise que les fréquences sous 5 kHz. */
const DECODE_RATE = 22050;

/**
 * Décode un fichier audio en échantillons mono (moyenne des canaux), rééchantillonnés à 22 050 Hz.
 * Contexte hors ligne : aucun périphérique audio n'est ouvert (la lecture en cours n'est pas gênée).
 */
export async function decodeAudio(bytes: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
  const Offline =
    window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Offline(1, 1, DECODE_RATE);
  const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i] = (samples[i] as number) + (data[i] as number) / buffer.numberOfChannels;
  }
  return { samples, sampleRate: buffer.sampleRate };
}
