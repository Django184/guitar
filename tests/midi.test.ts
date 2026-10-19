import { describe, expect, it } from 'vitest';
import { MidiFormatError, parseMidi } from '../src/scores/midi';
import { midiToMusicXml, quantizePart, splitDuration } from '../src/scores/midiToMusicXml';
import { writeMidi } from './midiWriter';

const scale = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) => ({ beat: i, length: 1, pitch }));

describe('Lecture MIDI', () => {
  it('tempo, mesure, noms de pistes et notes', () => {
    const song = parseMidi(
      writeMidi({ bpm: 96, timeSignature: [3, 4], tracks: [{ name: 'Guitare', program: 25, notes: scale }] }),
    );
    expect(song.ppq).toBe(480);
    expect(song.tempo).toBe(96);
    expect(song.timeSignature).toEqual({ beats: 3, beatType: 4 });
    expect(song.parts).toHaveLength(1);
    expect(song.parts[0]!.name).toBe('Guitare');
    expect(song.parts[0]!.program).toBe(25);
    expect(song.parts[0]!.notes.map((n) => n.pitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(song.parts[0]!.notes[1]).toMatchObject({ tick: 480, duration: 480 });
  });

  it('« running status » et relâchement par vélocité nulle', () => {
    const song = parseMidi(writeMidi({ runningStatus: true, tracks: [{ notes: scale }] }));
    expect(song.parts[0]!.notes).toHaveLength(8);
  });

  it('la batterie (canal 10) est ignorée', () => {
    const song = parseMidi(
      writeMidi({
        tracks: [
          { name: 'Batterie', channel: 9, notes: [{ beat: 0, length: 1, pitch: 36 }] },
          { name: 'Basse', channel: 1, notes: [{ beat: 0, length: 4, pitch: 40 }] },
        ],
      }),
    );
    expect(song.parts.map((p) => p.name)).toEqual(['Basse']);
  });

  it('fichier tronqué ou sans notes : erreur explicite', () => {
    const bytes = writeMidi({ tracks: [{ notes: scale }] });
    expect(() => parseMidi(bytes.subarray(0, 30))).toThrow(MidiFormatError);
    expect(() => parseMidi(new TextEncoder().encode('MThd'))).toThrow(MidiFormatError);
    expect(() => parseMidi(writeMidi({ tracks: [{ notes: [] }] }))).toThrow(/Aucune note/);
  });
});

describe('Quantification et durées', () => {
  it('figures : noire pointée + croche, ronde, double croche', () => {
    expect(splitDuration(8).map((v) => v.type)).toEqual(['half']);
    expect(splitDuration(7).map((v) => `${v.type}${v.dot ? '.' : ''}`)).toEqual(['quarter.', '16th']);
    expect(splitDuration(16).map((v) => v.type)).toEqual(['whole']);
    expect(splitDuration(0)).toEqual([]);
  });

  it('notes simultanées → accord, chevauchement coupé à la note suivante', () => {
    const song = parseMidi(
      writeMidi({
        tracks: [
          {
            notes: [
              { beat: 0, length: 2, pitch: 48 },
              { beat: 0, length: 1, pitch: 52 },
              { beat: 1, length: 1, pitch: 55 },
            ],
          },
        ],
      }),
    );
    const events = quantizePart(song.parts[0]!, song.ppq);
    expect(events).toEqual([
      { start: 0, length: 4, pitches: [48, 52] },
      { start: 4, length: 4, pitches: [55] },
    ]);
  });

  it('attaques légèrement décalées (jeu humain) ramenées sur la grille', () => {
    const song = parseMidi(writeMidi({ tracks: [{ notes: [{ beat: 1.03, length: 0.97, pitch: 60 }] }] }));
    expect(quantizePart(song.parts[0]!, song.ppq)[0]).toMatchObject({ start: 4, length: 4 });
  });
});

describe('Conversion MIDI → MusicXML', () => {
  const xmlOf = (tracks: Parameters<typeof writeMidi>[0]['tracks'], signature?: [number, number]): string =>
    midiToMusicXml(parseMidi(writeMidi({ tracks, timeSignature: signature })), 'Essai & test').xml;

  it('document partwise avec titre échappé, tempo et chiffrage', () => {
    const xml = xmlOf([{ name: 'Guitare', notes: scale }]);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<work-title>Essai &amp; test</work-title>');
    expect(xml).toContain('<sound tempo="120"/>');
    expect(xml).toContain('<beats>4</beats><beat-type>4</beat-type>');
    expect((xml.match(/<measure /g) ?? []).length).toBe(2);
  });

  it('piste jouable à la guitare : accordage et tablature (corde, case)', () => {
    const xml = xmlOf([{ notes: [{ beat: 0, length: 4, pitch: 40 }] }]);
    expect(xml).toContain('<staff-lines>6</staff-lines>');
    expect(xml).toContain('<clef-octave-change>-1</clef-octave-change>');
    // Mi grave à vide : corde 6 en numérotation MusicXML.
    expect(xml).toContain('<technical><string>6</string><fret>0</fret></technical>');
  });

  it('piste hors tessiture (piano grave) : pas de tablature, clé de fa', () => {
    const xml = xmlOf([{ notes: [{ beat: 0, length: 4, pitch: 24 }, { beat: 4, length: 4, pitch: 28 }] }]);
    expect(xml).not.toContain('<staff-details>');
    expect(xml).toContain('<sign>F</sign>');
  });

  it('note qui traverse la barre de mesure : deux notes liées', () => {
    const xml = xmlOf([{ notes: [{ beat: 3, length: 2, pitch: 60 }] }]);
    expect(xml).toContain('<tie type="start"/>');
    expect(xml).toContain('<tie type="stop"/>');
    expect(xml).toContain('<tied type="start"/>');
  });

  it('chaque mesure totalise exactement sa durée (4/4 et 6/8)', () => {
    for (const signature of [
      [4, 4],
      [6, 8],
    ] as Array<[number, number]>) {
      const melody = [
        { beat: 0, length: 0.75, pitch: 60 },
        { beat: 1.25, length: 2.5, pitch: 62 },
        { beat: 5, length: 0.5, pitch: 64 },
      ];
      const xml = xmlOf([{ notes: melody }], signature);
      const units = (signature[0] * 16) / signature[1];
      const measures = xml.split('<measure ').slice(1);
      expect(measures.length).toBeGreaterThan(0);
      for (const measure of measures) {
        // Durées des notes hors accords (<chord/> partage la durée de la note précédente).
        const notes = measure.split('<note>').slice(1).filter((n) => !n.startsWith('<chord/>'));
        const total = notes.reduce((sum, n) => sum + Number(/<duration>(\d+)<\/duration>/.exec(n)?.[1] ?? 0), 0);
        expect(total).toBe(units);
      }
    }
  });

  it('plusieurs pistes → plusieurs parties', () => {
    const conversion = midiToMusicXml(
      parseMidi(
        writeMidi({
          tracks: [
            { name: 'Guitare 1', channel: 0, notes: scale },
            { name: 'Guitare 2', channel: 1, notes: scale.map((n) => ({ ...n, pitch: n.pitch - 12 })) },
          ],
        }),
      ),
      'Duo',
    );
    expect(conversion.partCount).toBe(2);
    expect(conversion.tabPartCount).toBe(2);
    expect(conversion.xml).toContain('<part id="P2">');
  });
});
