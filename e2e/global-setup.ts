import fs from 'node:fs';
import { A2_WAV, FIXTURES_DIR } from './paths';

/** WAV mono 16 bits : La 110 Hz avec les harmoniques d'une corde de guitare, léger bruit de fond. */
function writeA2Wav(file: string): void {
  const sampleRate = 48_000;
  const seconds = 20;
  const length = sampleRate * seconds;
  const partials = [0.5, 1, 0.8, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08];
  const pcm = Buffer.alloc(length * 2);
  let seed = 1;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let v = 0;
    partials.forEach((a, k) => {
      v += a * Math.sin(2 * Math.PI * (k + 1) * 110 * t + k * 0.7);
    });
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    v = 0.07 * v + 0.004 * ((seed / 0x7fffffff) * 2 - 1);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

export default function globalSetup(): void {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  if (!fs.existsSync(A2_WAV)) writeA2Wav(A2_WAV);
}
