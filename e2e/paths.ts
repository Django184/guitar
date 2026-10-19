import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Fichiers générés ou téléchargés pour les tests (ignorés par git). */
export const FIXTURES_DIR = path.join(here, 'fixtures');

/** La 110 Hz au timbre de guitare, joué en boucle par le micro simulé de Chromium. */
export const A2_WAV = path.join(FIXTURES_DIR, 'a2-110hz.wav');

/**
 * Partitions Guitar Pro de la suite de tests d'alphaTab (MPL-2.0), téléchargées par la CI
 * (voir .github/workflows/ci.yml). Absentes en local : les tests correspondants sont ignorés.
 */
export const GP_FIXTURES = {
  gp3: path.join(FIXTURES_DIR, 'download', 'effects.gp3'),
  gp5: path.join(FIXTURES_DIR, 'download', 'canon.gp5'),
  gpx: path.join(FIXTURES_DIR, 'download', 'chords.gpx'),
  gp7: path.join(FIXTURES_DIR, 'download', 'serenade.gp'),
};
