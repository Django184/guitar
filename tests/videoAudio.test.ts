import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VideoAudioError,
  adtsHeader,
  encodeWav,
  isVideoFile,
  mp4AudioToAdts,
  parseAacConfig,
  trimSilence,
  type ByteReader,
} from '../src/scores/sync/videoAudio';

/*
 * Son d'une vidéo lu directement dans le conteneur MP4 / MOV (enregistrement d'écran importé).
 * Vidéos de test produites par FFmpeg à partir de sons synthétisés (aucun contenu tiers) :
 * - ecran-tablature.mov : QuickTime, index (moov) à la fin, image + son AAC stéréo 44,1 kHz,
 *   393 trames — la tablature de test des e2e jouée à la guitare synthétisée ;
 * - son-court.mp4 : MP4 « faststart » (index au début), AAC mono 22,05 kHz, 23 trames ;
 * - fragmente.mp4 : MP4 fragmenté (trames hors de l'index).
 */
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Lecteur sur un tableau d'octets, qui compte ce qui est lu. */
function reader(bytes: Uint8Array): { read: ByteReader; calls: () => number } {
  let calls = 0;
  return {
    read: async (offset, length) => {
      calls++;
      return bytes.slice(offset, offset + length);
    },
    calls: () => calls,
  };
}

/** Trames d'un flux ADTS (en-têtes vérifiés). */
function adtsFrames(adts: Uint8Array): Array<{ profile: number; rateIndex: number; channels: number; length: number }> {
  const frames = [];
  let at = 0;
  while (at < adts.length) {
    expect(adts[at]).toBe(0xff);
    expect((adts[at + 1] as number) & 0xf6).toBe(0xf0);
    const b2 = adts[at + 2] as number;
    const b3 = adts[at + 3] as number;
    const length = ((b3 & 3) << 11) | ((adts[at + 4] as number) << 3) | ((adts[at + 5] as number) >> 5);
    frames.push({ profile: b2 >> 6, rateIndex: (b2 >> 2) & 15, channels: ((b2 & 1) << 2) | (b3 >> 6), length });
    expect(length).toBeGreaterThan(7);
    at += length;
  }
  expect(at).toBe(adts.length);
  return frames;
}

describe('Son d’une vidéo MP4 / MOV', () => {
  it('QuickTime (iPhone) avec l’index à la fin : toutes les trames AAC, en ADTS', async () => {
    const bytes = fixture('ecran-tablature.mov');
    const { adts, frames, config } = await mp4AudioToAdts(reader(bytes).read, bytes.length);
    expect(config).toEqual({ profile: 1, sampleRateIndex: 4, channels: 2 });
    expect(frames).toBe(393);
    const parsed = adtsFrames(adts);
    expect(parsed).toHaveLength(393);
    expect(parsed.every((f) => f.profile === 1 && f.rateIndex === 4 && f.channels === 2)).toBe(true);
    // Le son seul : nettement moins que la vidéo entière (image, index).
    expect(adts.length - 393 * 7).toBeLessThan(bytes.length);
  });

  it('MP4 avec l’index au début, mono 22,05 kHz', async () => {
    const bytes = fixture('son-court.mp4');
    const { adts, frames, config } = await mp4AudioToAdts(reader(bytes).read, bytes.length);
    expect(config).toEqual({ profile: 1, sampleRateIndex: 7, channels: 1 });
    expect(frames).toBe(23);
    expect(adtsFrames(adts)).toHaveLength(23);
  });

  it('lit par morceaux (jamais tout le fichier d’un coup)', async () => {
    const bytes = fixture('ecran-tablature.mov');
    const r = reader(bytes);
    let largest = 0;
    const read: ByteReader = async (offset, length) => {
      largest = Math.max(largest, length);
      return r.read(offset, length);
    };
    await mp4AudioToAdts(read, bytes.length);
    expect(largest).toBeLessThan(bytes.length / 2);
  });

  it('vidéo fragmentée, fichier qui n’est pas une vidéo, vidéo tronquée : erreurs claires', async () => {
    const frag = fixture('fragmente.mp4');
    await expect(mp4AudioToAdts(reader(frag).read, frag.length)).rejects.toThrow(/fragmentée/);
    const text = new TextEncoder().encode('Ceci n’est pas une vidéo, simplement du texte.');
    await expect(mp4AudioToAdts(reader(text).read, text.length)).rejects.toBeInstanceOf(VideoAudioError);
    const mov = fixture('ecran-tablature.mov');
    const cut = mov.slice(0, 30000);
    await expect(mp4AudioToAdts(reader(cut).read, cut.length)).rejects.toThrow(/incomplet/);
  });

  it('configuration AAC : AAC-LC, HE-AAC (cœur AAC-LC transmis), formats que l’ADTS ne porte pas', () => {
    // AAC-LC, 44,1 kHz (indice 4), stéréo : 00010 0100 0010 000
    expect(parseAacConfig(Uint8Array.of(0x12, 0x10))).toEqual({ profile: 1, sampleRateIndex: 4, channels: 2 });
    // HE-AAC explicite : SBR (5), 24 kHz (6), stéréo, extension 48 kHz (3), puis AAC-LC (2).
    // 00101 0110 0010 0011 00010 → 0x2B 0x11 0x88 (bits complétés par des zéros)
    expect(parseAacConfig(Uint8Array.of(0x2b, 0x11, 0x88))).toEqual({ profile: 1, sampleRateIndex: 6, channels: 2 });
    // Fréquence explicite (indice 15) : impossible en ADTS.
    expect(parseAacConfig(Uint8Array.of(0x17, 0x80, 0x00, 0x00, 0x00))).toBeNull();
  });

  it('en-tête ADTS', () => {
    // AAC-LC, 44,1 kHz, stéréo, 100 octets de données (trame de 107 octets).
    expect(Array.from(adtsHeader({ profile: 1, sampleRateIndex: 4, channels: 2 }, 100))).toEqual([0xff, 0xf1, 0x50, 0x80, 0x0d, 0x7f, 0xfc]);
  });

  it('reconnaît les vidéos par leur type ou leur extension', () => {
    expect(isVideoFile({ name: 'RPReplay_Final1698.MP4', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'trim.mov', type: 'video/quicktime' })).toBe(true);
    expect(isVideoFile({ name: 'morceau.m4a', type: 'audio/mp4' })).toBe(false);
    expect(isVideoFile({ name: 'morceau.mp3', type: 'audio/mpeg' })).toBe(false);
  });
});

describe('Son gardé : silence retiré, WAV mono', () => {
  it('retire le silence du début et de la fin, avec une marge', () => {
    const rate = 1000;
    const x = new Float32Array(5000);
    for (let i = 2000; i < 3000; i++) x[i] = Math.sin(i / 3) * 0.5;
    const trimmed = trimSilence(x, rate, 0.004, 0.3);
    // 1 s de son, plus 0,3 s de chaque côté (à un échantillon près : passages par zéro).
    expect(Math.abs(trimmed.length - 1600)).toBeLessThan(10);
  });

  it('WAV 16 bits lisible : en-tête et crête à 90 %', () => {
    const wav = encodeWav(Float32Array.of(0, 0.5, -0.25), 32000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe('WAVEfmt ');
    expect(view.getUint32(24, true)).toBe(32000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(46, true)).toBe(Math.round(0.9 * 32767));
    expect(view.getInt16(48, true)).toBe(Math.round(-0.45 * 32767));
  });
});
