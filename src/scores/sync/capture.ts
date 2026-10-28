/**
 * Son de l'onglet (ordinateur, Chrome ou Edge) : le navigateur transmet directement à l'app ce
 * que joue la page, vidéo YouTube intégrée comprise. Ni micro, ni haut-parleurs : le son est
 * capté avant la carte son (on peut même couper le volume de l'ordinateur).
 * Rien n'est enregistré dans un fichier : les échantillons servent à l'analyse, puis sont oubliés.
 */

interface UADataLike {
  brands?: Array<{ brand: string }>;
  mobile?: boolean;
}

const ua = (): string => navigator.userAgent;

/** iPhone, iPad (y compris iPadOS qui se présente comme un Mac) ou iPod. */
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(ua()) || (/Macintosh/.test(ua()) && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  return /Android/i.test(ua());
}

/**
 * Le son d'un onglet ne peut être partagé que par les navigateurs Chromium sur ordinateur :
 * Safari et Firefox partagent l'image sans le son, et les téléphones ne partagent rien.
 */
export function canCaptureTab(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return false;
  if (isIOS() || isAndroid()) return false;
  const data = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  if (data?.mobile) return false;
  if (data?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))) return true;
  return /\b(Chrome|Chromium|Edg)\//.test(ua()) && !/Mobile/.test(ua());
}

/** Partage refusé ou impossible : message à afficher tel quel. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

/**
 * Demande le son de cet onglet. À appeler pendant le geste de l'utilisateur (clic), sans attente
 * préalable : le navigateur l'exige pour afficher sa demande de partage.
 */
export async function openTabAudio(): Promise<MediaStream> {
  if (!canCaptureTab()) throw new CaptureError('Ce navigateur ne partage pas le son d’un onglet : utilisez Chrome ou Edge sur ordinateur.');
  // Options propres à Chrome : proposer directement cet onglet, avec son son.
  const options = {
    video: { frameRate: { max: 1 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    systemAudio: 'include',
    surfaceSwitching: 'exclude',
  } as DisplayMediaStreamOptions;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new CaptureError('Partage annulé : l’écoute a besoin du son de cet onglet.');
    }
    throw new CaptureError('Le son de l’onglet ne peut pas être capté sur ce navigateur.');
  }
  // L'image ne sert pas : la piste reste ouverte (l'arrêter pourrait couper le son), mais inactive.
  stream.getVideoTracks().forEach((t) => (t.enabled = false));
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError('Le son n’a pas été partagé : recommencez en laissant cochée l’option « Partager aussi l’audio de l’onglet ».');
  }
  return stream;
}
