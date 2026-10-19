/**
 * Identification des fichiers de partition par leur CONTENU (signature binaire),
 * l'extension ne servant qu'à produire un message d'erreur précis.
 * Pur et sans DOM : testable et réutilisé en Phase 2 avant le chargement alphaTab.
 */
export type ScoreFormat = 'gp3-5' | 'gpx' | 'gp7' | 'musicxml' | 'mxl' | 'midi';

export type Detection =
  | { kind: 'score'; format: ScoreFormat; label: string }
  | { kind: 'pdf' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unsupported'; message: string };

export const FORMAT_LABELS: Record<ScoreFormat, string> = {
  'gp3-5': 'Guitar Pro 3 à 5',
  gpx: 'Guitar Pro 6',
  gp7: 'Guitar Pro 7 ou 8',
  musicxml: 'MusicXML',
  mxl: 'MusicXML compressé',
  midi: 'MIDI',
};

const EXTENSIONS: Record<string, ScoreFormat | 'pdf'> = {
  gp3: 'gp3-5',
  gp4: 'gp3-5',
  gp5: 'gp3-5',
  gpx: 'gpx',
  gp: 'gp7',
  musicxml: 'musicxml',
  xml: 'musicxml',
  mxl: 'mxl',
  mid: 'midi',
  midi: 'midi',
  pdf: 'pdf',
};

/** Valeur de l'attribut `accept` du sélecteur de fichiers. */
export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(',');

export const SUPPORTED_LIST =
  'Guitar Pro (.gp, .gp3, .gp4, .gp5, .gpx), MusicXML (.musicxml, .mxl) et MIDI (.mid)';

/** Taille maximale acceptée : une partition dépasse rarement quelques Mo. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const latin1 = new TextDecoder('latin1');

function startsWith(bytes: Uint8Array, ascii: string, offset = 0): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function decodeText(bytes: Uint8Array): string {
  const head = bytes.subarray(0, 64 * 1024);
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(head);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(head);
  return new TextDecoder('utf-8').decode(head);
}

/** Reconnaît le format d'après les premiers octets. Renvoie null si inconnu. */
export function sniffFormat(bytes: Uint8Array): ScoreFormat | 'pdf' | null {
  // PDF : « %PDF- » dans le premier kilo-octet.
  if (latin1.decode(bytes.subarray(0, 1024)).includes('%PDF-')) return 'pdf';

  // MIDI standard, ou MIDI encapsulé RIFF (RMID).
  if (startsWith(bytes, 'MThd')) return 'midi';
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'RMID', 8)) return 'midi';

  // Guitar Pro 6 : conteneur BCFZ (compressé) ou BCFS.
  if (startsWith(bytes, 'BCFZ') || startsWith(bytes, 'BCFS')) return 'gpx';

  // Guitar Pro 3 à 5 : chaîne Pascal « FICHIER GUITAR PRO vX.YY ».
  const headerLength = bytes[0] ?? 0;
  if (headerLength > 0 && headerLength < 64) {
    const header = latin1.decode(bytes.subarray(1, 1 + headerLength)).toUpperCase();
    if (header.includes('GUITAR PRO') || header.includes('GUITARE PRO')) return 'gp3-5';
  }

  // Archives ZIP : Guitar Pro 7/8 (.gp) ou MusicXML compressé (.mxl).
  if (startsWith(bytes, 'PK\u0003\u0004')) {
    const names = latin1.decode(bytes);
    if (names.includes('Content/score.gpif')) return 'gp7';
    if (names.includes('META-INF/container.xml') || names.includes('application/vnd.recordare.musicxml')) return 'mxl';
    return null;
  }

  // MusicXML non compressé (texte).
  const text = decodeText(bytes);
  if (text.includes('<score-partwise') || text.includes('<score-timewise')) return 'musicxml';

  return null;
}

export function detectScoreBytes(name: string, bytes: Uint8Array): Detection {
  const ext = extensionOf(name);
  const expected = EXTENSIONS[ext];

  if (bytes.length === 0) {
    return { kind: 'invalid', message: `Fichier invalide : « ${name} » est vide.` };
  }

  const sniffed = sniffFormat(bytes);
  if (sniffed === 'pdf') return { kind: 'pdf' };
  if (sniffed) return { kind: 'score', format: sniffed, label: FORMAT_LABELS[sniffed] };

  if (expected === 'pdf') {
    return { kind: 'invalid', message: `Fichier invalide : « ${name} » porte l'extension .pdf mais n'est pas un PDF lisible.` };
  }
  if (expected) {
    return {
      kind: 'invalid',
      message: `Fichier invalide : « ${name} » ne contient pas de données ${FORMAT_LABELS[expected]} lisibles. Il est peut-être corrompu ou mal nommé.`,
    };
  }
  return {
    kind: 'unsupported',
    message: `Format non pris en charge${ext ? ` (.${ext})` : ''}. Formats acceptés : ${SUPPORTED_LIST}.`,
  };
}

/** Lit un fichier choisi par l'utilisateur et l'identifie. */
export async function detectScoreFile(file: File): Promise<Detection> {
  if (file.size > MAX_FILE_BYTES) {
    return { kind: 'invalid', message: `Fichier invalide : « ${file.name} » dépasse 50 Mo.` };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return detectScoreBytes(file.name, bytes);
}
