/**
 * Écriture d'une archive ZIP en mémoire (sauvegarde de la bibliothèque), sans dépendance :
 * compression native du navigateur (CompressionStream « deflate-raw ») ou fichier stocké tel quel.
 * Lue par `readZip` (scores/unzip.ts) et par tout logiciel d'archives. Pas de ZIP64 : 4 Gio au plus.
 */

export interface ZipInput {
  name: string;
  data: Uint8Array;
  /** Fichier déjà compressé (audio, Guitar Pro 6 à 8) : stocké sans recompression. */
  store?: boolean;
}

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 1980-01-01 00:00 en format DOS : la date réelle est dans export.json. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

export async function makeZip(files: ZipInput[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const method = file.store ? 0 : 8;
    const body = method === 8 ? await deflateRaw(file.data) : file.data;
    const crc = crc32(file.data);

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, UTF8_FLAG, true);
    l.setUint16(8, method, true);
    l.setUint16(10, 0, true);
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, file.data.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, UTF8_FLAG, true);
    c.setUint16(10, method, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, file.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local as Uint8Array<ArrayBuffer>, body as Uint8Array<ArrayBuffer>);
    central.push(entry);
    offset += local.length + body.length;
  }

  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as Uint8Array<ArrayBuffer>[]), end], { type: 'application/zip' });
}
