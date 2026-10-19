/** Petit générateur de fichiers MIDI pour les tests. */

export interface TestNote {
  /** Début en noires. */
  beat: number;
  /** Durée en noires. */
  length: number;
  pitch: number;
  channel?: number;
}

export interface TestTrack {
  name?: string;
  program?: number;
  channel?: number;
  notes: TestNote[];
}

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function chunk(id: string, body: number[]): number[] {
  return [...ascii(id), ...u32(body.length), ...body];
}

export function writeMidi(options: {
  ppq?: number;
  bpm?: number;
  timeSignature?: [number, number];
  tracks: TestTrack[];
  /** Utilise le « running status » (statut omis pour les événements consécutifs). */
  runningStatus?: boolean;
}): Uint8Array {
  const ppq = options.ppq ?? 480;
  const bpm = options.bpm ?? 120;
  const [num, den] = options.timeSignature ?? [4, 4];

  const conductor: number[] = [];
  const micros = Math.round(60_000_000 / bpm);
  conductor.push(0, 0xff, 0x51, 3, (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff);
  conductor.push(0, 0xff, 0x58, 4, num, Math.log2(den), 24, 8);
  conductor.push(0, 0xff, 0x2f, 0);

  const tracks = options.tracks.map((track) => {
    const channel = track.channel ?? 0;
    const events: Array<{ tick: number; bytes: number[] }> = [];
    for (const note of track.notes) {
      const ch = note.channel ?? channel;
      const on = Math.round(note.beat * ppq);
      const off = Math.round((note.beat + note.length) * ppq);
      events.push({ tick: on, bytes: [0x90 | ch, note.pitch, 90] });
      // Moitié des relâchements en « note on vélocité 0 », moitié en « note off ».
      events.push({ tick: off, bytes: note.pitch % 2 ? [0x80 | ch, note.pitch, 0] : [0x90 | ch, note.pitch, 0] });
    }
    events.sort((a, b) => a.tick - b.tick || (a.bytes[2] === 0 ? -1 : 1) - (b.bytes[2] === 0 ? -1 : 1));

    const body: number[] = [];
    if (track.name) body.push(0, 0xff, 0x03, track.name.length, ...ascii(track.name));
    if (track.program !== undefined) body.push(0, 0xc0 | channel, track.program);
    let last = 0;
    let status = -1;
    for (const event of events) {
      body.push(...vlq(event.tick - last));
      last = event.tick;
      const [st, ...data] = event.bytes as [number, ...number[]];
      if (options.runningStatus && st === status) body.push(...data);
      else body.push(st, ...data);
      status = st;
    }
    body.push(0, 0xff, 0x2f, 0);
    return chunk('MTrk', body);
  });

  const header = chunk('MThd', [...u16(1), ...u16(tracks.length + 1), ...u16(ppq)]);
  return new Uint8Array([...header, ...chunk('MTrk', conductor), ...tracks.flat()]);
}
