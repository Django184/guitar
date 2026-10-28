/**
 * Partitions de test générées à la volée (aucun fichier tiers) :
 * une mélodie originale en MusicXML (sans tablature), sa version compressée .mxl,
 * et un fichier MIDI de guitare.
 */
import { writeMidi } from '../tests/midiWriter';
import { makeZip } from '../tests/zip';

export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const STEPS: Record<string, [string, number]> = {
  C: ['C', 0], D: ['D', 0], E: ['E', 0], F: ['F', 0], 'F#': ['F', 1], G: ['G', 0], A: ['A', 0], B: ['B', 0],
};

/** Mélodie originale en Sol majeur, 8 mesures de 4/4 (hauteurs écrites, guitare : sonne une octave plus bas). */
const MELODY: Array<[string, number, 'quarter' | 'half']> = [
  ['G', 4, 'quarter'], ['B', 4, 'quarter'], ['D', 5, 'quarter'], ['B', 4, 'quarter'],
  ['C', 5, 'quarter'], ['E', 5, 'quarter'], ['D', 5, 'half'],
  ['B', 4, 'quarter'], ['A', 4, 'quarter'], ['G', 4, 'quarter'], ['A', 4, 'quarter'],
  ['B', 4, 'half'], ['A', 4, 'half'],
  ['G', 4, 'quarter'], ['F#', 4, 'quarter'], ['E', 4, 'quarter'], ['F#', 4, 'quarter'],
  ['G', 4, 'quarter'], ['A', 4, 'quarter'], ['B', 4, 'half'],
  ['C', 5, 'quarter'], ['B', 4, 'quarter'], ['A', 4, 'quarter'], ['F#', 4, 'quarter'],
  ['G', 4, 'half'], ['G', 3, 'half'],
];

export function guitarMusicXml(title = 'Promenade en Sol'): string {
  const measures: string[] = [];
  let current = '';
  let filled = 0;
  for (const [name, octave, type] of MELODY) {
    const [step, alter] = STEPS[name] as [string, number];
    const duration = type === 'half' ? 8 : 4;
    current +=
      `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
      `<duration>${duration}</duration><voice>1</voice><type>${type}</type>${alter ? '<accidental>sharp</accidental>' : ''}</note>`;
    filled += duration;
    if (filled === 16) {
      measures.push(current);
      current = '';
      filled = 0;
    }
  }
  const attributes =
    '<attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>' +
    '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>' +
    '<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>';
  const body = measures
    .map((notes, i) => `<measure number="${i + 1}">${i === 0 ? attributes + '<sound tempo="100"/>' : ''}${notes}</measure>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' +
    `<score-partwise version="4.0"><work><work-title>${title}</work-title></work>` +
    '<part-list><score-part id="P1"><part-name>Guitare</part-name></score-part></part-list>' +
    `<part id="P1">${body}</part></score-partwise>`
  );
}

export function musicXmlFile(): UploadFile {
  return { name: 'promenade.musicxml', mimeType: 'application/vnd.recordare.musicxml+xml', buffer: Buffer.from(guitarMusicXml()) };
}

export async function mxlFile(): Promise<UploadFile> {
  const container =
    '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles>' +
    '<rootfile full-path="promenade.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
  const zip = await makeZip(
    {
      mimetype: 'application/vnd.recordare.musicxml',
      'META-INF/container.xml': container,
      'promenade.musicxml': guitarMusicXml('Promenade compressée'),
    },
    ['mimetype'],
  );
  return { name: 'promenade.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer: Buffer.from(zip) };
}

export function midiFile(): UploadFile {
  const notes = [];
  // 8 mesures : arpèges de Sol, Do, Ré, Sol (guitare), puis accords plaqués.
  const arpeggios = [
    [43, 50, 55, 59],
    [48, 52, 55, 60],
    [50, 54, 57, 62],
    [43, 47, 50, 55],
  ];
  let beat = 0;
  for (const chord of arpeggios) {
    for (const pitch of chord) notes.push({ beat: beat++, length: 1, pitch });
  }
  for (const chord of arpeggios) {
    for (const pitch of chord) notes.push({ beat, length: 4, pitch });
    beat += 4;
  }
  const bytes = writeMidi({ bpm: 100, tracks: [{ name: 'Guitare acoustique', program: 25, notes }] });
  return { name: 'arpeges.mid', mimeType: 'audio/midi', buffer: Buffer.from(bytes) };
}

// --- Rythme retrouvé dans des transcriptions ----------------------------------------

const STANDARD = [64, 59, 55, 50, 45, 40];

/**
 * Mélodie originale « Promenade du soir » (guitare, accordage standard) : début en noires,
 * et notes [corde (1 = mi aigu), case]. 7 mesures de 4/4.
 */
export const EVENING_WALK: Array<[number, Array<[number, number]>]> = [
  [0, [[1, 0]]], [1, [[1, 3]]], [1.5, [[1, 5]]], [2, [[1, 7]]], [3, [[1, 5]]],
  [4, [[1, 3]]], [4.5, [[1, 0]]], [5, [[2, 3]]], [6, [[1, 0], [6, 0]]],
  [8, [[2, 0]]], [8.5, [[2, 3]]], [9, [[1, 0]]], [10.5, [[1, 3]]], [11, [[1, 5]]],
  [12, [[1, 7]]], [13, [[1, 10]]], [13.5, [[1, 7]]], [14, [[1, 5]]], [15, [[1, 3]]],
  [16, [[1, 5]]], [17.5, [[1, 3]]], [18, [[1, 0]]], [19, [[2, 3]]],
  [20, [[1, 0], [6, 0]]], [21, [[1, 3]]], [22, [[1, 7]]], [23, [[1, 12]]],
  [24, [[1, 0], [6, 0]]],
];

/**
 * La même mélodie en tablature texte (deux lignes de mesures), chiffres régulièrement espacés :
 * le rythme n'y est pas.
 */
export function eveningWalkAscii(): string[] {
  const names = ['e', 'B', 'G', 'D', 'A', 'E'];
  const bars = new Map<number, Array<Array<[number, number]>>>();
  for (const [start, notes] of EVENING_WALK) bars.set(Math.floor(start / 4), [...(bars.get(Math.floor(start / 4)) ?? []), notes]);
  const systems = [[0, 1, 2, 3], [4, 5, 6]];
  return systems.flatMap((system, si) => {
    const lines = names.map((n) => `${n}|`);
    for (const bar of system) {
      for (const notes of bars.get(bar) ?? []) {
        names.forEach((_, s) => {
          const fret = notes.find(([string]) => string === s + 1)?.[1];
          lines[s] += fret === undefined ? '----' : `-${String(fret).padEnd(3, '-')}`;
        });
      }
      names.forEach((_, s) => (lines[s] += '--|'));
    }
    return si ? ['', ...lines] : lines;
  });
}

const walkPitches = EVENING_WALK.map(([, notes]) => notes.map(([s, f]) => (STANDARD[s - 1] as number) + f));
const walkEnds = EVENING_WALK.map(([t], i) => EVENING_WALK[i + 1]?.[0] ?? t + 4);

/**
 * Transcriptions de test du même morceau, au rythme juste :
 * - guitare (MIDI) ;
 * - piano : une octave plus haut, valeurs doublées, accords à la main gauche, deux notes
 *   oubliées et un rythme différent dans la mesure 3 (mesure à vérifier) ;
 * - un autre morceau du même nom, dans la même tonalité (à écarter).
 */
export function eveningWalkSources(): { guitar: UploadFile; piano: UploadFile; other: UploadFile } {
  const guitar = writeMidi({
    bpm: 96,
    tracks: [
      {
        name: 'Guitare',
        program: 25,
        notes: EVENING_WALK.flatMap(([t], i) => (walkPitches[i] as number[]).map((pitch) => ({ beat: t, length: (walkEnds[i] as number) - t, pitch }))),
      },
    ],
  });
  const chords = [[45, 52, 57], [43, 50, 55], [40, 47, 52], [45, 52, 57], [43, 50, 55], [40, 47, 52], [40, 47, 52]];
  const piano = writeMidi({
    bpm: 192,
    tracks: [
      {
        name: 'Piano',
        program: 0,
        notes: [
          ...EVENING_WALK.flatMap(([t], i) =>
            i === 15 || i === 21 ? [] : [{ beat: (i === 12 ? 10 : t) * 2, length: ((walkEnds[i] as number) - t) * 2, pitch: Math.max(...(walkPitches[i] as number[])) + 12 }],
          ),
          ...chords.flatMap((c, bar) => [0, 4].flatMap((o) => c.map((pitch) => ({ beat: bar * 8 + o, length: 4, pitch })))),
        ],
      },
    ],
  });
  let seed = 5;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const scale = [64, 66, 67, 69, 71, 72, 74, 76, 59, 62];
  const other = writeMidi({
    bpm: 120,
    tracks: [{ name: 'Lead', program: 81, notes: Array.from({ length: 60 }, (_, i) => ({ beat: i * 0.5, length: 0.5, pitch: scale[Math.floor(rnd() * scale.length)] as number })) }],
  });
  const file = (name: string, bytes: Uint8Array): UploadFile => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) });
  return { guitar: file('promenade-guitare.mid', guitar), piano: file('promenade-piano.mid', piano), other: file('promenade-remix.mid', other) };
}

/**
 * La même mélodie en tablature « dessinée » (cordes en traits, cases posées dessus, comme les
 * exports de logiciels et de sites), une image par ligne de mesures, dans une page imprimable.
 */
export function eveningWalkDrawnHtml(): string {
  const systems = [[0, 1, 2, 3], [4, 5, 6]];
  const data = JSON.stringify(
    systems.map((bars) => EVENING_WALK.filter(([start]) => bars.includes(Math.floor(start / 4))).map(([start, notes]) => [start - (bars[0] as number) * 4, notes])),
  );
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family: sans-serif">
<h1 style="font-size: 24px">Promenade du soir</h1><p style="font-size: 12px">STANDARD TUNING · CAPO FRET 2</p>
<script>
  for (const events of ${data}) {
    const c = document.createElement('canvas');
    c.width = 1400; c.height = 300;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    const y = (s) => 50 + (s - 1) * 40;
    const x = (t) => 140 + t * 70;
    // Noms de cordes cerclés, à gauche.
    ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ['e', 'B', 'G', 'D', 'A', 'E'].forEach((n, i) => {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(60, y(i + 1), 13, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.fillText(n, 60, y(i + 1) + 1);
    });
    for (let s = 1; s <= 6; s++) {
      const cuts = events.filter(([, notes]) => notes.some(([str]) => str === s)).map(([t]) => x(t));
      ctx.strokeStyle = '#999'; ctx.lineWidth = 3;
      let from = 90;
      for (const cx of [...cuts, 99999]) {
        const to = Math.min(1360, cx - 20);
        if (to > from) { ctx.beginPath(); ctx.moveTo(from, y(s)); ctx.lineTo(to, y(s)); ctx.stroke(); }
        from = cx + 20;
      }
    }
    ctx.fillStyle = '#111'; ctx.fillRect(1360, y(1), 5, y(6) - y(1));
    ctx.font = 'bold 28px sans-serif';
    for (const [t, notes] of events) for (const [s, fret] of notes) ctx.fillText(String(fret), x(t), y(s) + 1);
    const img = document.createElement('img');
    img.src = c.toDataURL('image/png');
    img.style.width = '700px';
    img.style.display = 'block';
    img.style.margin = '12px 0';
    document.body.append(img);
  }
</script></body></html>`;
}
