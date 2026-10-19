import { describe, expect, it } from 'vitest';
import { detectScoreBytes, extensionOf, sniffFormat } from '../src/scores/formats';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function pascal(text: string, padding = 32): Uint8Array {
  const bytes = new Uint8Array(1 + padding);
  bytes[0] = text.length;
  bytes.set(ascii(text), 1);
  return bytes;
}

function zipWith(entryName: string): Uint8Array {
  const header = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(26).fill(0)]);
  const name = ascii(entryName);
  const out = new Uint8Array(header.length + name.length + 16);
  out.set(header);
  out.set(name, header.length);
  return out;
}

describe('Reconnaissance par signature', () => {
  it('Guitar Pro 3 à 5', () => {
    expect(sniffFormat(pascal('FICHIER GUITAR PRO v5.00'))).toBe('gp3-5');
    expect(sniffFormat(pascal('FICHIER GUITAR PRO v3.00'))).toBe('gp3-5');
  });

  it('Guitar Pro 6 (.gpx) et 7/8 (.gp)', () => {
    expect(sniffFormat(ascii('BCFZ\u0000\u0000'))).toBe('gpx');
    expect(sniffFormat(zipWith('Content/score.gpif'))).toBe('gp7');
  });

  it('MusicXML, compressé ou non', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE score-partwise><score-partwise version="4.0"></score-partwise>';
    expect(sniffFormat(ascii(xml))).toBe('musicxml');
    expect(sniffFormat(zipWith('META-INF/container.xml'))).toBe('mxl');
  });

  it('MIDI et PDF', () => {
    expect(sniffFormat(ascii('MThd\u0000\u0000\u0000\u0006'))).toBe('midi');
    expect(sniffFormat(ascii('%PDF-1.7\n'))).toBe('pdf');
  });

  it('contenu inconnu', () => {
    expect(sniffFormat(ascii('Bonjour'))).toBeNull();
    expect(sniffFormat(zipWith('word/document.xml'))).toBeNull();
  });
});

describe('Messages à l’import', () => {
  it('PDF : guidage vers la conversion', () => {
    expect(detectScoreBytes('morceau.pdf', ascii('%PDF-1.4')).kind).toBe('pdf');
  });

  it('fichier valide reconnu même avec une extension fantaisiste', () => {
    expect(detectScoreBytes('morceau.bin', pascal('FICHIER GUITAR PRO v4.06'))).toMatchObject({
      kind: 'score',
      format: 'gp3-5',
    });
  });

  it('extension attendue mais contenu illisible : fichier invalide', () => {
    const result = detectScoreBytes('solo.gp5', ascii('pas du tout guitar pro'));
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.message).toContain('Guitar Pro 3 à 5');
  });

  it('fichier vide : invalide', () => {
    expect(detectScoreBytes('vide.mid', new Uint8Array()).kind).toBe('invalid');
  });

  it('format inconnu : non pris en charge, avec la liste des formats', () => {
    const result = detectScoreBytes('notes.docx', zipWith('word/document.xml'));
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') {
      expect(result.message).toContain('.docx');
      expect(result.message).toContain('MusicXML');
    }
  });

  it('extension en minuscules', () => {
    expect(extensionOf('Solo.GP5')).toBe('gp5');
    expect(extensionOf('sans-extension')).toBe('');
  });
});
