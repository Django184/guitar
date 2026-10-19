import { describe, expect, it } from 'vitest';
import { ZipFormatError, decodeXml, readMxl } from '../src/scores/unzip';
import { makeZip } from './zip';

const SCORE = '<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Étude</work-title></work></score-partwise>';
const CONTAINER =
  '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/etude.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';

describe('MusicXML compressé (.mxl)', () => {
  it('suit META-INF/container.xml jusqu’au fichier principal', async () => {
    const zip = await makeZip({ mimetype: 'application/vnd.recordare.musicxml', 'META-INF/container.xml': CONTAINER, 'score/etude.musicxml': SCORE }, ['mimetype']);
    expect(await readMxl(zip)).toBe(SCORE);
  });

  it('sans container.xml : premier fichier .xml trouvé', async () => {
    const zip = await makeZip({ 'morceau.xml': SCORE });
    expect(await readMxl(zip)).toContain('Étude');
  });

  it('archive invalide ou sans partition : erreur explicite', async () => {
    await expect(readMxl(new TextEncoder().encode('pas une archive'))).rejects.toThrow(ZipFormatError);
    await expect(readMxl(await makeZip({ 'lisez-moi.txt': 'bonjour' }))).rejects.toThrow(/Aucune partition/);
  });

  it('décodage UTF-16 avec marque d’ordre', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<a/>'].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeXml(utf16)).toBe('<a/>');
  });
});
