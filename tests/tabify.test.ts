// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { tabifyMusicXml } from '../src/scores/tabify';

const note = (step: string, octave: number, extra = ''): string =>
  `<note>${extra.includes('<chord/>') ? '<chord/>' : ''}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>4</duration>${extra.replace('<chord/>', '')}<type>quarter</type></note>`;

const score = (measures: string, attributes = '<clef><sign>G</sign><line>2</line></clef>'): string =>
  `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitare</part-name></score-part></part-list>` +
  `<part id="P1"><measure number="1"><attributes><divisions>4</divisions>${attributes}</attributes>${measures}</measure></part></score-partwise>`;

const technicals = (xml: string): Array<[number, number]> =>
  [...xml.matchAll(/<string>(\d+)<\/string><fret>(\d+)<\/fret>/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe('Tablature ajoutée aux MusicXML qui n’en ont pas', () => {
  it('mélodie de guitare écrite à l’octave (transposition -12) : cases correctes', () => {
    // Guitare : écrit Mi 3 = son réel Mi 2 (corde 6 à vide).
    const xml = score(note('E', 3) + note('A', 3) + note('E', 5), '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>');
    const result = tabifyMusicXml(xml);
    expect(result.tabbedParts).toBe(1);
    expect(result.xml).toContain('<staff-lines>6</staff-lines>');
    const [low, a, high] = technicals(result.xml);
    expect(low).toEqual([6, 0]);
    expect(a).toEqual([5, 0]);
    expect(high).toEqual([1, 0]);
  });

  it('accord : une corde par note', () => {
    const xml = score(note('C', 4) + note('E', 4, '<chord/>') + note('G', 4, '<chord/>'));
    const positions = technicals(tabifyMusicXml(xml).xml);
    expect(positions).toHaveLength(3);
    expect(new Set(positions.map(([s]) => s)).size).toBe(3);
  });

  it('note liée : même corde et même case que la note d’origine', () => {
    const xml = score(note('A', 4, '<tie type="start"/>') + note('A', 4, '<tie type="stop"/>'));
    const [first, second] = technicals(tabifyMusicXml(xml).xml);
    expect(second).toEqual(first);
  });

  it('fichier déjà doté d’une tablature : inchangé', () => {
    const xml = score('<note><pitch><step>E</step><octave>2</octave></pitch><duration>4</duration><notations><technical><string>6</string><fret>0</fret></technical></notations></note>');
    const result = tabifyMusicXml(xml);
    expect(result.tabbedParts).toBe(0);
    expect(result.xml).toBe(xml);
  });

  it('partie de piano à deux portées : inchangée', () => {
    const xml = score(note('C', 4), '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(tabifyMusicXml(xml).tabbedParts).toBe(0);
  });

  it('notes hors de portée de la guitare : pas de tablature', () => {
    const xml = score(note('C', 1) + note('D', 1) + note('E', 1));
    expect(tabifyMusicXml(xml).tabbedParts).toBe(0);
  });

  it('XML invalide : rendu tel quel (alphaTab signalera l’erreur)', () => {
    expect(tabifyMusicXml('<score-partwise><oops').tabbedParts).toBe(0);
  });
});
