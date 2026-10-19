import { AppError, microphoneError } from '../ui/errors';

/**
 * Ouvre le micro sans les traitements de la visioconférence :
 * la suppression de bruit et le contrôle de gain écrasent les notes tenues
 * et faussent la détection de hauteur.
 */
export async function openMicrophone(): Promise<MediaStream> {
  if (!window.isSecureContext) throw new AppError('mic-insecure');
  if (!navigator.mediaDevices?.getUserMedia) throw new AppError('mic-unsupported');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (error) {
    throw microphoneError(error);
  }
}

export function closeMicrophone(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
