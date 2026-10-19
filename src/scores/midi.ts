/**
 * Lecture d'un fichier MIDI standard (SMF format 0 ou 1).
 * alphaTab ne lit pas le MIDI : on en extrait les notes, puis midiToMusicXml.ts
 * les transforme en partition.
 */

export interface MidiNote {
  /** Début, en ticks. */
  tick: number;
  /** Durée, en ticks. */
  duration: number;
  pitch: number;
  velocity: number;
}

export interface MidiPart {
  name: string;
  channel: number;
  /** Programme General MIDI (0–127), -1 si absent. */
  program: number;
  notes: MidiNote[];
}

export interface MidiSong {
  /** Ticks par noire. */
  ppq: number;
  /** Tempo initial en BPM. */
  tempo: number;
  timeSignature: { beats: number; beatType: number };
  parts: MidiPart[];
}

export class MidiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiFormatError';
  }
}

const DRUM_CHANNEL = 9;

class Reader {
  constructor(
    private readonly bytes: Uint8Array,
    readonly end = bytes.length,
    public offset = 0,
  ) {}

  get done(): boolean {
    return this.offset >= this.end;
  }

  u8(): number {
    if (this.offset >= this.end) throw new MidiFormatError('Fin de fichier inattendue');
    return this.bytes[this.offset++] as number;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }

  ascii(length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  /** Quantité à longueur variable (VLQ). */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new MidiFormatError('Longueur variable invalide');
  }

  skip(length: number): void {
    this.offset += length;
    if (this.offset > this.end) throw new MidiFormatError('Fin de fichier inattendue');
  }

  text(length: number): string {
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.skip(length);
    return new TextDecoder('latin1').decode(slice);
  }
}

interface RawTrack {
  name: string;
  /** Notes par canal. */
  channels: Map<number, { program: number; notes: MidiNote[] }>;
  tempo: number | null;
  timeSignature: { beats: number; beatType: number } | null;
}

function readTrack(reader: Reader): RawTrack {
  const track: RawTrack = { name: '', channels: new Map(), tempo: null, timeSignature: null };
  const open = new Map<number, Array<{ tick: number; velocity: number }>>();
  let tick = 0;
  let running = 0;

  const channel = (ch: number): { program: number; notes: MidiNote[] } => {
    let entry = track.channels.get(ch);
    if (!entry) {
      entry = { program: -1, notes: [] };
      track.channels.set(ch, entry);
    }
    return entry;
  };

  const noteOff = (ch: number, pitch: number): void => {
    const key = (ch << 8) | pitch;
    const starts = open.get(key);
    const start = starts?.shift();
    if (!start) return;
    channel(ch).notes.push({ tick: start.tick, duration: Math.max(1, tick - start.tick), pitch, velocity: start.velocity });
  };

  while (!reader.done) {
    tick += reader.vlq();
    let status = reader.u8();
    if (status < 0x80) {
      // Running status : l'octet lu est déjà la première donnée.
      if (!running) throw new MidiFormatError('Statut MIDI manquant');
      reader.offset -= 1;
      status = running;
    }

    if (status === 0xff) {
      const type = reader.u8();
      const length = reader.vlq();
      if (type === 0x03 && !track.name) {
        track.name = reader.text(length).trim();
      } else if (type === 0x51 && length === 3 && track.tempo === null) {
        const microsPerQuarter = (reader.u8() << 16) | (reader.u8() << 8) | reader.u8();
        track.tempo = 60_000_000 / microsPerQuarter;
      } else if (type === 0x58 && length >= 2 && track.timeSignature === null) {
        const beats = reader.u8();
        const beatType = 2 ** reader.u8();
        track.timeSignature = { beats, beatType };
        reader.skip(length - 2);
      } else if (type === 0x2f) {
        reader.skip(length);
        break;
      } else {
        reader.skip(length);
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      reader.skip(reader.vlq());
      continue;
    }

    running = status;
    const kind = status & 0xf0;
    const ch = status & 0x0f;
    switch (kind) {
      case 0x80: {
        const pitch = reader.u8();
        reader.u8();
        noteOff(ch, pitch);
        break;
      }
      case 0x90: {
        const pitch = reader.u8();
        const velocity = reader.u8();
        if (velocity === 0) {
          noteOff(ch, pitch);
        } else {
          const key = (ch << 8) | pitch;
          const starts = open.get(key) ?? [];
          starts.push({ tick, velocity });
          open.set(key, starts);
          channel(ch);
        }
        break;
      }
      case 0xa0:
      case 0xb0:
      case 0xe0:
        reader.skip(2);
        break;
      case 0xc0: {
        const program = reader.u8();
        const entry = channel(ch);
        if (entry.program < 0) entry.program = program;
        break;
      }
      case 0xd0:
        reader.skip(1);
        break;
      default:
        throw new MidiFormatError(`Événement MIDI inconnu (0x${status.toString(16)})`);
    }
  }

  // Notes jamais relâchées : on les termine à la fin de la piste.
  for (const [key, starts] of open) {
    for (const start of starts) {
      channel(key >> 8).notes.push({
        tick: start.tick,
        duration: Math.max(1, tick - start.tick),
        pitch: key & 0xff,
        velocity: start.velocity,
      });
    }
  }
  return track;
}

export function parseMidi(bytes: Uint8Array): MidiSong {
  const reader = new Reader(bytes);
  if (reader.ascii(4) !== 'MThd') throw new MidiFormatError("Ce n'est pas un fichier MIDI");
  const headerLength = reader.u32();
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  reader.skip(headerLength - 6);

  if (format > 1) throw new MidiFormatError('Format MIDI 2 non pris en charge');
  if (division & 0x8000) throw new MidiFormatError('Base de temps SMPTE non prise en charge');
  if (division === 0) throw new MidiFormatError('Résolution MIDI invalide');

  const tracks: RawTrack[] = [];
  for (let i = 0; i < trackCount && !reader.done; i++) {
    const id = reader.ascii(4);
    const length = reader.u32();
    if (id !== 'MTrk') {
      reader.skip(length);
      continue;
    }
    const start = reader.offset;
    const end = Math.min(start + length, bytes.length);
    tracks.push(readTrack(new Reader(bytes, end, start)));
    reader.offset = end;
  }

  const tempo = tracks.find((t) => t.tempo !== null)?.tempo ?? 120;
  const timeSignature = tracks.find((t) => t.timeSignature !== null)?.timeSignature ?? { beats: 4, beatType: 4 };

  const parts: MidiPart[] = [];
  tracks.forEach((track, trackIndex) => {
    const channels = [...track.channels.entries()].filter(([ch, data]) => ch !== DRUM_CHANNEL && data.notes.length > 0);
    for (const [ch, data] of channels) {
      const base = track.name || `Piste ${trackIndex + 1}`;
      parts.push({
        name: channels.length > 1 ? `${base} (canal ${ch + 1})` : base,
        channel: ch,
        program: data.program,
        notes: data.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch),
      });
    }
  });

  if (parts.length === 0) throw new MidiFormatError('Aucune note mélodique dans ce fichier MIDI');
  return { ppq: division, tempo: Math.round(tempo), timeSignature, parts };
}
