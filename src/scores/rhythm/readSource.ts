/** Lecture d'une transcription téléchargée ou importée (MIDI, Guitar Pro, MusicXML). */
import { type AlphaTabModule, parseScore } from '../alphatab';
import { sniffFormat } from '../formats';
import { parseMidi } from '../midi';
import { readMxl } from '../unzip';
import { type LoadedSource, songFromMidi, songFromScore } from './sources';

/** Lit une transcription. Lève une erreur si le fichier est illisible. */
export async function readSource(at: AlphaTabModule, bytes: Uint8Array, label: string): Promise<LoadedSource> {
  switch (sniffFormat(bytes)) {
    case 'midi':
      return { label, song: songFromMidi(parseMidi(bytes)) };
    case 'mxl':
      return { label, song: songFromScore(parseScore(at, new TextEncoder().encode(await readMxl(bytes)))) };
    case 'musicxml':
    case 'gp3-5':
    case 'gpx':
    case 'gp7':
      return { label, song: songFromScore(parseScore(at, bytes)) };
    default:
      throw new Error('Format non reconnu');
  }
}
