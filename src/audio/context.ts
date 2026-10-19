import { AppError } from '../ui/errors';

/**
 * Un seul AudioContext pour toute l'app (accordeur, métronome, puis lecteur).
 * iOS exige qu'il soit créé / repris pendant un geste utilisateur :
 * `unlockAudio()` doit être la première instruction d'un gestionnaire de clic.
 */
let context: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

export function getAudioContext(): AudioContext {
  if (context) return context;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) throw new AppError('audio-unsupported');
  context = new Ctor({ latencyHint: 'interactive' });
  return context;
}

/** Démarre (ou reprend) l'AudioContext. À appeler de façon synchrone dans un geste. */
export async function unlockAudio(): Promise<AudioContext> {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') {
    // resume() et le son muet sont lancés dans le même tour d'événement que le geste.
    const resumed = ctx.resume();
    playSilence(ctx);
    await resumed;
  }
  return ctx;
}

/** Les anciens iOS ne débloquent l'audio qu'après un son réellement démarré. */
function playSilence(ctx: AudioContext): void {
  try {
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Sans importance : resume() suffit sur les navigateurs récents.
  }
}

type SessionType = 'auto' | 'playback' | 'play-and-record';

/**
 * API Audio Session (Safari récents ; absente ailleurs, l'appel est alors ignoré).
 * « playback » traite le métronome comme une lecture musicale (haut-parleur) ;
 * « play-and-record » est réservé à l'accordeur, quand le micro est ouvert.
 * Sans cette bascule, iOS peut garder le son sur l'écouteur après l'usage du micro.
 */
export function setAudioSession(type: SessionType): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // API présente mais refusée : le navigateur garde son comportement par défaut.
  }
}

/**
 * Instant (sur l'horloge audio) du son réellement entendu maintenant,
 * latence de sortie comprise. Sert à synchroniser l'affichage avec le son.
 */
export function audibleTime(ctx: AudioContext): number {
  if (typeof ctx.getOutputTimestamp === 'function') {
    const stamp = ctx.getOutputTimestamp();
    if (stamp.contextTime && stamp.performanceTime) {
      return stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
    }
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}
