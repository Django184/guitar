/**
 * Son d'une vidéo (un enregistrement d'écran, typiquement) : lu directement dans le fichier,
 * sans le rejouer en temps réel.
 *
 * Safari ne décode pas les .mov de l'iPhone avec decodeAudioData (alors qu'il les lit) ; on va
 * donc chercher nous-mêmes la piste AAC dans le conteneur MP4 / QuickTime (boîtes moov → trak →
 * stbl), et on la réécrit en flux ADTS — chaque trame précédée d'un en-tête de 7 octets — que
 * tous les navigateurs savent décoder. Seules les boîtes utiles et les morceaux de son sont lus
 * (File.slice) : une vidéo de plusieurs centaines de Mo ne passe jamais en mémoire.
 * Autre codec ou conteneur : decodeAudioData sur le fichier entier, s'il n'est pas trop gros.
 */
import { decodeAudio } from './media';

/** Lecture d'une plage d'octets du fichier. */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

export const blobReader =
  (blob: Blob): ByteReader =>
  async (offset, length) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

/** Fichier lisible par ce module, mais dont le son n'est pas récupérable ainsi. */
export class VideoAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoAudioError';
  }
}

interface Box {
  type: string;
  /** Début du contenu (après l'en-tête). */
  start: number;
  /** Fin de la boîte. */
  end: number;
}

const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

/** Boîtes contenues dans b[from, to). */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = fourcc(b, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box, type: string): Box | undefined => boxes(b, box.start, box.end).find((x) => x.type === type);

/** Chemin de boîtes (ex. mdia/minf/stbl). */
function path(b: Uint8Array, box: Box, ...types: string[]): Box | undefined {
  let cur: Box | undefined = box;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(b, cur, t);
  }
  return cur;
}

/** Boîte moov, lue seule (elle peut être au début ou à la fin du fichier). */
async function readMoov(read: ByteReader, size: number): Promise<{ b: Uint8Array; moov: Box }> {
  let at = 0;
  let first = true;
  while (at + 8 <= size) {
    const head = await read(at, 16);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let boxSize = view.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (first && !/^(ftyp|moov|mdat|wide|free|skip|pnot|uuid)$/.test(type)) throw new VideoAudioError('Ce fichier n’est pas une vidéo MP4 ou MOV.');
    first = false;
    if (boxSize === 1) {
      boxSize = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      header = 16;
    } else if (boxSize === 0) boxSize = size - at;
    if (boxSize < header) break;
    if (type === 'moov') {
      if (boxSize > 64 * 1024 * 1024) break;
      const b = await read(at, boxSize);
      return { b, moov: { type, start: header, end: b.length } };
    }
    at += boxSize;
  }
  throw new VideoAudioError('Index de la vidéo introuvable (fichier incomplet ?).');
}

/** Longueur d'un descripteur MPEG-4 (1 à 4 octets de 7 bits). */
function descriptor(b: Uint8Array, at: number, end: number): { tag: number; start: number; end: number } | null {
  if (at >= end) return null;
  const tag = b[at] as number;
  let len = 0;
  let i = at + 1;
  for (let n = 0; n < 4 && i < end; n++, i++) {
    const v = b[i] as number;
    len = (len << 7) | (v & 0x7f);
    if (!(v & 0x80)) {
      i++;
      break;
    }
  }
  return { tag, start: i, end: Math.min(end, i + len) };
}

/** AudioSpecificConfig contenu dans une boîte esds. */
function audioSpecificConfig(b: Uint8Array, esds: Box): Uint8Array | null {
  // Boîte « pleine » : 4 octets de version et d'options, puis le descripteur ES (étiquette 3).
  const es = descriptor(b, esds.start + 4, esds.end);
  if (!es || es.tag !== 3) return null;
  let at = es.start + 2;
  const flags = b[at++] as number;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + (b[at] as number);
  if (flags & 0x20) at += 2;
  // Descripteur de configuration du décodeur (4), puis informations propres au décodeur (5).
  const dc = descriptor(b, at, es.end);
  if (!dc || dc.tag !== 4) return null;
  // 0x40 : audio MPEG-4 ; 0x66-0x68 : AAC MPEG-2.
  const objectType = b[dc.start] as number;
  if (objectType !== 0x40 && !(objectType >= 0x66 && objectType <= 0x68)) return null;
  const dsi = descriptor(b, dc.start + 13, dc.end);
  if (!dsi || dsi.tag !== 5) return null;
  return b.subarray(dsi.start, dsi.end);
}

export interface AacConfig {
  /** Profil ADTS (type d'objet audio − 1) : 1 = AAC-LC. */
  profile: number;
  sampleRateIndex: number;
  channels: number;
}

/** Paramètres ADTS d'une configuration AAC ; null si l'ADTS ne peut pas la porter. */
export function parseAacConfig(asc: Uint8Array): AacConfig | null {
  let bit = 0;
  const bits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | (((asc[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    return v;
  };
  let type = bits(5);
  if (type === 31) type = 32 + bits(6);
  const rateIndex = bits(4);
  if (rateIndex === 15) return null;
  const channels = bits(4);
  // HE-AAC (SBR, PS) explicite : on transmet le cœur AAC-LC, que les décodeurs complètent.
  if (type === 5 || type === 29) {
    bits(4);
    type = bits(5);
    if (type === 31) type = 32 + bits(6);
  }
  if (type < 1 || type > 4 || channels < 1 || channels > 7) return null;
  return { profile: type - 1, sampleRateIndex: rateIndex, channels };
}

/** En-tête ADTS (7 octets, sans CRC) d'une trame de `payload` octets. */
export function adtsHeader(config: AacConfig, payload: number): Uint8Array {
  const len = payload + 7;
  const { profile, sampleRateIndex: sr, channels: ch } = config;
  return Uint8Array.of(
    0xff,
    0xf1,
    ((profile & 3) << 6) | ((sr & 15) << 2) | ((ch >> 2) & 1),
    ((ch & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  );
}

interface AudioTrack {
  config: AacConfig;
  /** Position et taille de chaque trame AAC, dans l'ordre. */
  samples: Array<{ offset: number; size: number }>;
}

/** Première piste son AAC de la boîte moov. */
function aacTrack(b: Uint8Array, moov: Box): AudioTrack {
  let other = '';
  for (const trak of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak')) {
    const hdlr = path(b, trak, 'mdia', 'hdlr');
    if (!hdlr || fourcc(b, hdlr.start + 8) !== 'soun') continue;
    const stbl = path(b, trak, 'mdia', 'minf', 'stbl');
    const stsd = stbl && child(b, stbl, 'stsd');
    if (!stbl || !stsd) continue;
    // Description du son : 8 octets d'en-tête de boîte (déjà sautés), 28 octets communs, puis
    // 16 (QuickTime v1) ou 36 (v2) octets de plus ; ensuite viennent les boîtes filles.
    const entry = boxes(b, stsd.start + 8, stsd.end)[0];
    if (!entry) continue;
    if (entry.type !== 'mp4a') {
      other = entry.type.trim();
      continue;
    }
    const version = ((b[entry.start + 8] as number) << 8) | (b[entry.start + 9] as number);
    const skip = 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    // esds directement dans la description (MP4), ou dans une boîte wave (QuickTime).
    const inner = boxes(b, entry.start + skip, entry.end);
    const wave = inner.find((x) => x.type === 'wave');
    const esds = inner.find((x) => x.type === 'esds') ?? (wave && child(b, wave, 'esds'));
    const asc = esds && audioSpecificConfig(b, esds);
    const config = asc && parseAacConfig(asc);
    if (!config) {
      other = 'aac';
      continue;
    }
    return { config, samples: sampleTable(b, stbl) };
  }
  throw new VideoAudioError(other ? `Son de la vidéo dans un format non pris en charge (${other}).` : 'Cette vidéo n’a pas de son.');
}

/** Position de chaque échantillon (trame) d'après les tables stsz, stsc et stco / co64. */
function sampleTable(b: Uint8Array, stbl: Box): Array<{ offset: number; size: number }> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const stsz = child(b, stbl, 'stsz');
  const stsc = child(b, stbl, 'stsc');
  const stco = child(b, stbl, 'stco') ?? child(b, stbl, 'co64');
  if (!stsz || !stsc || !stco) throw new VideoAudioError('Table du son illisible dans cette vidéo.');
  const fixed = view.getUint32(stsz.start + 4);
  const count = view.getUint32(stsz.start + 8);
  // Vidéo fragmentée (moof) : les trames ne sont pas dans moov.
  if (!count) throw new VideoAudioError('Vidéo fragmentée : son non lisible directement.');
  if (!fixed && stsz.start + 12 + count * 4 > stsz.end) throw new VideoAudioError('Table du son tronquée.');
  const sizeOf = (i: number): number => (fixed ? fixed : view.getUint32(stsz.start + 12 + i * 4));
  const wide = stco.type === 'co64';
  const chunks = view.getUint32(stco.start + 4);
  const chunkOffset = (i: number): number =>
    wide ? view.getUint32(stco.start + 8 + i * 8) * 2 ** 32 + view.getUint32(stco.start + 12 + i * 8) : view.getUint32(stco.start + 8 + i * 4);
  const runs = view.getUint32(stsc.start + 4);
  const run = (i: number): { first: number; perChunk: number } => ({
    first: view.getUint32(stsc.start + 8 + i * 12) - 1,
    perChunk: view.getUint32(stsc.start + 12 + i * 12),
  });
  if (!runs || !chunks) throw new VideoAudioError('Table du son vide.');
  const out: Array<{ offset: number; size: number }> = [];
  let r = 0;
  for (let c = 0; c < chunks && out.length < count; c++) {
    while (r + 1 < runs && run(r + 1).first <= c) r++;
    let offset = chunkOffset(c);
    const per = run(r).perChunk;
    for (let s = 0; s < per && out.length < count; s++) {
      const size = sizeOf(out.length);
      out.push({ offset, size });
      offset += size;
    }
  }
  return out;
}

/** Plages contiguës de trames : lues d'un seul tenant. */
function spans(samples: Array<{ offset: number; size: number }>): Array<{ offset: number; size: number; count: number }> {
  const out: Array<{ offset: number; size: number; count: number }> = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last && last.offset + last.size === s.offset && last.size + s.size <= 1024 * 1024) {
      last.size += s.size;
      last.count++;
    } else out.push({ offset: s.offset, size: s.size, count: 1 });
  }
  return out;
}

/** Piste son AAC d'une vidéo MP4 / MOV, réécrite en flux ADTS. */
export async function mp4AudioToAdts(read: ByteReader, size: number): Promise<{ adts: Uint8Array; frames: number; config: AacConfig }> {
  const { b, moov } = await readMoov(read, size);
  const { config, samples } = aacTrack(b, moov);
  const last = samples[samples.length - 1];
  if (!last) throw new VideoAudioError('Cette vidéo n’a pas de son.');
  if (last.offset + last.size > size) throw new VideoAudioError('Vidéo incomplète : le son dépasse la fin du fichier.');
  if (samples.some((s) => s.size + 7 > 8191)) throw new VideoAudioError('Trames de son trop grandes pour être converties.');
  const total = samples.reduce((n, s) => n + s.size + 7, 0);
  const adts = new Uint8Array(total);
  const groups = spans(samples);
  let at = 0;
  let index = 0;
  // Lectures par lots : une quinzaine de plages (1 Mo au plus chacune) à la fois.
  for (let g = 0; g < groups.length; g += 16) {
    const batch = groups.slice(g, g + 16);
    const data = await Promise.all(batch.map((s) => read(s.offset, s.size)));
    batch.forEach((span, k) => {
      const bytes = data[k] as Uint8Array;
      if (bytes.length < span.size) throw new VideoAudioError('Lecture de la vidéo interrompue.');
      let pos = 0;
      for (let n = 0; n < span.count; n++) {
        const s = samples[index++] as { offset: number; size: number };
        adts.set(adtsHeader(config, s.size), at);
        adts.set(bytes.subarray(pos, pos + s.size), at + 7);
        at += s.size + 7;
        pos += s.size;
      }
    });
  }
  return { adts, frames: samples.length, config };
}

/** Taille au-delà de laquelle on ne tente pas de décoder le fichier entier (mémoire du téléphone). */
const WHOLE_FILE_LIMIT = 300 * 1024 * 1024;

export const isVideoFile = (file: { name: string; type: string }): boolean =>
  file.type.startsWith('video/') || /\.(mp4|m4v|mov|qt|3gp|webm|mkv)$/i.test(file.name);

/** Son d'une vidéo, en échantillons mono à `rate` Hz. */
export async function videoAudio(file: Blob, rate: number): Promise<{ samples: Float32Array; sampleRate: number }> {
  let reason: unknown = null;
  try {
    const { adts } = await mp4AudioToAdts(blobReader(file), file.size);
    return await decodeAudio(adts, rate);
  } catch (error) {
    reason = error;
  }
  if (file.size <= WHOLE_FILE_LIMIT) {
    try {
      return await decodeAudio(new Uint8Array(await file.arrayBuffer()), rate);
    } catch {
      // Message de la première tentative, plus parlant.
    }
  }
  if (reason instanceof VideoAudioError) throw reason;
  throw new VideoAudioError('Le son de cette vidéo n’a pas pu être lu par le navigateur.');
}

/** Crête (valeur absolue maximale) d'un signal. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] as number));
  return peak;
}

/**
 * Silence du début et de la fin retiré (enregistrement d'écran : manipulations avant et après
 * la lecture), avec une petite marge.
 */
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.004, margin = 0.3): Float32Array {
  const peak = peakOf(samples);
  if (!peak) return samples;
  const level = Math.max(threshold, peak * 0.01);
  let first = 0;
  while (first < samples.length && Math.abs(samples[first] as number) < level) first++;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last] as number) < level) last--;
  const pad = Math.round(margin * sampleRate);
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + 1 + pad));
}

/** WAV mono 16 bits (crête ramenée à 90 %). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const peak = peakOf(samples);
  const gain = peak > 0 ? 0.9 / peak : 1;
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string): void => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, (samples[i] as number) * gain));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}
