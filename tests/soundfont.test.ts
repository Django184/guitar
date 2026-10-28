import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Banque de sons livrée (public/sons/) : GeneralUser GS 2.0.3, préparée pour le synthétiseur
 * d'alphaTab 1.8.4 par scripts/sf2-to-sf3.py. Ce que ce synthétiseur exige est vérifié ici :
 * - blocs RIFF de taille paire (son analyseur ne saute pas l'octet de remplissage) ;
 * - échantillons mono compressés (type 0x11 : il ignore les échantillons stéréo) ;
 * - aucun générateur d'adresse (décalage de début ignoré en SF3, valeurs additionnées) ;
 * - aucune atténuation ni accord dans une zone globale (il les additionne à ceux des zones) ;
 * - les 128 instruments General MIDI et la batterie standard présents.
 */
const FILE = new URL('../public/sons/generaluser-gs-2.0.3.sf3', import.meta.url);
const bytes = readFileSync(FILE);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const id = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

interface Chunk {
  id: string;
  start: number;
  size: number;
}

function chunks(start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  for (let at = start; at + 8 <= end; ) {
    const size = view.getUint32(at + 4, true);
    out.push({ id: id(at), start: at + 8, size });
    at += 8 + size;
  }
  return out;
}

const top = chunks(12, bytes.length);
const lists = new Map(top.map((c) => [id(c.start), c]));
const sub = (list: string, name: string): Chunk => {
  const l = lists.get(list) as Chunk;
  return chunks(l.start + 4, l.start + l.size).find((c) => c.id === name) as Chunk;
};
const table = (name: string, size: number): number[] => {
  const c = sub('pdta', name);
  return Array.from({ length: c.size / size }, (_, i) => c.start + i * size);
};

describe('Banque de sons livrée (GeneralUser GS pour alphaTab)', () => {
  it('SF3 : en-tête, version 3.1, blocs de taille paire', () => {
    expect(id(0)).toBe('RIFF');
    expect(id(8)).toBe('sfbk');
    expect(view.getUint32(4, true) + 8).toBe(bytes.length);
    const ifil = sub('INFO', 'ifil');
    expect([view.getUint16(ifil.start, true), view.getUint16(ifil.start + 2, true)]).toEqual([3, 1]);
    for (const list of ['INFO', 'sdta', 'pdta']) {
      const l = lists.get(list) as Chunk;
      expect(l.size % 2).toBe(0);
      for (const c of chunks(l.start + 4, l.start + l.size)) expect(c.size % 2, `${list}/${c.id}`).toBe(0);
    }
    expect(bytes.length).toBeLessThan(16 * 1024 * 1024);
  });

  it('échantillons mono en Ogg Vorbis, rangés dans le bloc smpl, boucles cohérentes', () => {
    const smpl = sub('sdta', 'smpl');
    const headers = table('shdr', 46).slice(0, -1);
    expect(headers.length).toBeGreaterThan(1000);
    for (const at of headers) {
      const start = view.getUint32(at + 20, true);
      const end = view.getUint32(at + 24, true);
      expect(view.getUint16(at + 44, true)).toBe(0x11);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(smpl.size);
      expect(id(smpl.start + start)).toBe('OggS');
      expect(view.getUint32(at + 28, true)).toBeLessThanOrEqual(view.getUint32(at + 32, true));
    }
  });

  it('zones prêtes pour alphaTab : ni décalage d’adresse, ni valeur additive dans une zone globale', () => {
    const igen = table('igen', 4).map((at) => [view.getUint16(at, true), view.getInt16(at + 2, true)] as const);
    const address = new Set([0, 1, 2, 3, 4, 12, 45, 50]);
    // (Le dernier enregistrement, terminal, vaut toujours 0 / 0.)
    expect(igen.slice(0, -1).filter(([op]) => address.has(op))).toEqual([]);
    const ibag = table('ibag', 4).map((at) => view.getUint16(at, true));
    const inst = table('inst', 22).map((at) => view.getUint16(at + 20, true));
    for (let i = 0; i < inst.length - 1; i++) {
      const first = ibag[inst[i] as number] as number;
      const next = ibag[(inst[i] as number) + 1] as number;
      const gens = igen.slice(first, next);
      const global = !gens.length || (gens[gens.length - 1] as readonly number[])[0] !== 53;
      if (global) expect(gens.filter(([op]) => op === 48 || op === 51 || op === 52)).toEqual([]);
    }
  });

  it('les 128 instruments General MIDI et la batterie standard', () => {
    const presets = new Set(table('phdr', 38).slice(0, -1).map((at) => `${view.getUint16(at + 22, true)}:${view.getUint16(at + 20, true)}`));
    for (let p = 0; p < 128; p++) expect(presets.has(`0:${p}`), `programme ${p}`).toBe(true);
    expect(presets.has('128:0')).toBe(true);
  });
});
