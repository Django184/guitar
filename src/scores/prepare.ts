import { AppError } from '../ui/errors';
import type { ScoreFormat } from './formats';
import { MidiFormatError, parseMidi } from './midi';
import { midiToMusicXml } from './midiToMusicXml';
import { tabifyMusicXml } from './tabify';
import { ZipFormatError, decodeXml, readMxl } from './unzip';

export interface PreparedScore {
  /** Données à donner à alphaTab. */
  data: Uint8Array;
  /** Information à afficher à l'utilisateur (conversion, tablature calculée), ou null. */
  notice: string | null;
}

const MIDI_NOTICE =
  'Partition déduite du fichier MIDI : rythmes arrondis à la double croche et tablature calculée. Vérifiez les doigtés.';
const TAB_NOTICE = 'Ce fichier ne contenait pas de tablature : elle a été calculée. Vérifiez les doigtés.';

/**
 * Prépare un fichier pour alphaTab :
 * - Guitar Pro : tel quel ;
 * - MusicXML (.musicxml, .mxl) : tablature ajoutée si absente ;
 * - MIDI : converti en MusicXML (alphaTab ne lit pas le MIDI).
 */
export async function prepareScore(format: ScoreFormat, bytes: Uint8Array, title: string): Promise<PreparedScore> {
  const encode = (xml: string): Uint8Array => new TextEncoder().encode(xml);
  try {
    switch (format) {
      case 'gp3-5':
      case 'gpx':
      case 'gp7':
        return { data: bytes, notice: null };
      case 'musicxml':
      case 'mxl': {
        const xml = format === 'mxl' ? await readMxl(bytes) : decodeXml(bytes);
        const result = tabifyMusicXml(xml);
        return result.tabbedParts > 0
          ? { data: encode(result.xml), notice: TAB_NOTICE }
          : { data: format === 'mxl' ? encode(xml) : bytes, notice: null };
      }
      case 'midi': {
        const conversion = midiToMusicXml(parseMidi(bytes), title);
        return { data: encode(conversion.xml), notice: MIDI_NOTICE };
      }
    }
  } catch (error) {
    if (error instanceof MidiFormatError || error instanceof ZipFormatError) {
      throw new AppError('file-invalid', `Fichier invalide : ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}.`);
    }
    throw error;
  }
}
