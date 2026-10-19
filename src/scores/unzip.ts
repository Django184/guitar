/**
 * Lecture minimale d'une archive ZIP (MusicXML compressé .mxl), avec la
 * décompression native du navigateur (DecompressionStream « deflate-raw »).
 * Seules les méthodes « stockée » et « deflate » sont prises en charge,
 * ce qui couvre les fichiers .mxl produits par MuseScore, Finale, Sibelius ou Audiveris.
 */

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function listEntries(bytes: Uint8Array): ZipEntry[] {
  const data = view(bytes);
  // Fin du répertoire central : signature 0x06054b50, cherchée depuis la fin (commentaire ≤ 64 Ko).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (data.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('Archive ZIP invalide');

  const count = data.getUint16(eocd + 10, true);
  let offset = data.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || data.getUint32(offset, true) !== 0x02014b50) {
      throw new ZipFormatError('Répertoire ZIP invalide');
    }
    const method = data.getUint16(offset + 10, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localHeaderOffset = data.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const data = view(bytes);
  const at = entry.localHeaderOffset;
  if (data.getUint32(at, true) !== 0x04034b50) throw new ZipFormatError('En-tête ZIP invalide');
  const start = at + 30 + data.getUint16(at + 26, true) + data.getUint16(at + 28, true);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new ZipFormatError(`Compression ZIP non prise en charge (${entry.method})`);
}

/** Lit le fichier MusicXML principal d'une archive .mxl et renvoie son texte. */
export async function readMxl(bytes: Uint8Array): Promise<string> {
  const entries = listEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const decoder = new TextDecoder('utf-8');

  let rootPath: string | null = null;
  const container = byName.get('META-INF/container.xml');
  if (container) {
    const text = decoder.decode(await readEntry(bytes, container));
    rootPath = /full-path\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? null;
  }
  const root =
    (rootPath ? byName.get(rootPath) : undefined) ??
    entries.find((e) => !e.name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(e.name));
  if (!root) throw new ZipFormatError('Aucune partition MusicXML dans cette archive');
  return decodeXml(await readEntry(bytes, root));
}

/** Décode un document XML en tenant compte d'une éventuelle marque d'ordre UTF-16. */
export function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}
