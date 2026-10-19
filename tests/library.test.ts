import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, ScoreLibrary, type ScoreEntry } from '../src/scores/library';

let counter = 0;
const entry = (overrides: Partial<ScoreEntry> = {}): ScoreEntry => {
  counter += 1;
  return {
    id: `id-${counter}-${Math.random().toString(36).slice(2)}`,
    fileName: `morceau-${counter}.gp5`,
    title: `Morceau ${counter}`,
    artist: '',
    format: 'gp3-5',
    size: 10,
    addedAt: counter,
    openedAt: counter,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
};

// Node n'a pas d'IndexedDB : implémentation en mémoire conforme à la spécification.
if (typeof indexedDB === 'undefined') (globalThis as { indexedDB?: IDBFactory }).indexedDB = fakeIndexedDB;

describe('Bibliothèque IndexedDB', () => {
  it('ajoute, relit le fichier à l’identique et liste du plus récent au plus ancien', async () => {
    const library = await ScoreLibrary.open();
    const first = entry();
    const second = entry();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await library.add(first, bytes);
    await library.add(second, new Uint8Array([9]));
    const ids = (await library.list()).map((e) => e.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect([...((await library.getFile(first.id)) ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  it('conserve les réglages (vitesse, boucle, sélection)', async () => {
    const library = await ScoreLibrary.open();
    const item = entry();
    await library.add(item, new Uint8Array([1]));
    item.settings = { ...item.settings, speed: 0.5, loop: false, selection: { startBar: 4, startBeat: 0, endBar: 7, endBeat: 3 } };
    await library.update(item);
    const stored = await library.get(item.id);
    expect(stored?.settings.speed).toBe(0.5);
    expect(stored?.settings.selection).toEqual({ startBar: 4, startBeat: 0, endBar: 7, endBeat: 3 });
  });

  it('suppression annulable', async () => {
    const library = await ScoreLibrary.open();
    const item = entry();
    await library.add(item, new Uint8Array([7, 7]));
    const removed = await library.remove(item.id);
    expect(await library.get(item.id)).toBe(undefined);
    await library.add(removed!.entry, removed!.bytes);
    expect([...((await library.getFile(item.id)) ?? [])]).toEqual([7, 7]);
  });

  it('repère un fichier déjà importé (même nom, même taille)', async () => {
    const library = await ScoreLibrary.open();
    const item = entry({ fileName: 'unique.gp', size: 1234 });
    await library.add(item, new Uint8Array([0]));
    expect((await library.findDuplicate('unique.gp', 1234))?.id).toBe(item.id);
    expect(await library.findDuplicate('unique.gp', 99)).toBe(undefined);
  });
});
