import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { APP_SLUG, BackupError, buildBackup, describePlan, planImport, readBackup } from '../src/scores/backup';
import { DEFAULT_SETTINGS, ScoreLibrary, type ScoreEntry } from '../src/scores/library';
import { SCHEMA_VERSION, migrateEntry } from '../src/scores/schema';
import { readZip } from '../src/scores/unzip';
import { crc32, makeZip } from '../src/shell/zip';

const entry = (id: string, overrides: Partial<ScoreEntry> = {}): ScoreEntry => ({
  id,
  fileName: `${id}.gp5`,
  title: `Morceau ${id}`,
  artist: 'Artiste',
  format: 'gp3-5',
  size: 3,
  addedAt: 1,
  openedAt: 2,
  settings: { ...DEFAULT_SETTINGS, speed: 0.6 },
  ...overrides,
});

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

describe('Archive ZIP écrite par l’app', () => {
  it('relit chaque fichier à l’identique, compressé ou stocké', async () => {
    const text = new TextEncoder().encode('é'.repeat(5000));
    const binary = Uint8Array.from({ length: 3000 }, (_, i) => (i * 37) % 256);
    const zip = await bytesOf(await makeZip([{ name: 'a/texte.txt', data: text }, { name: 'b.bin', data: binary, store: true }]));
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(['a/texte.txt', 'b.bin']);
    expect(files.get('a/texte.txt')).toEqual(text);
    expect(files.get('b.bin')).toEqual(binary);
  });

  it('calcule le CRC-32 standard', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('Sauvegarde de la bibliothèque', () => {
  it('aller-retour : fiches, fichiers, enregistrement, préférences ; jamais la clé YouTube', async () => {
    const a = entry('a1', { fingers: { '0|1:0:0:2': 3 }, futur: 'champ inconnu gardé' } as Partial<ScoreEntry>);
    const b = entry('b2', { format: 'musicxml', origin: 'pdf', media: { kind: 'audio', name: 'prise.m4a', type: 'audio/mp4', size: 2 } });
    const files: Record<string, { bytes?: Uint8Array; media?: Uint8Array }> = {
      a1: { bytes: new Uint8Array([1, 2, 3]) },
      b2: { bytes: new TextEncoder().encode('<score-partwise/>'), media: new Uint8Array([9, 8]) },
    };
    const { blob, fileName, count } = await buildBackup({
      entries: [a, b],
      files: async (id) => files[id] ?? {},
      preferences: { theme: 'light', a4: 442, youtubeKey: 'secret' },
      appVersion: '1.1.0',
      now: new Date(2026, 10, 14, 10, 0),
    });
    expect(fileName).toBe('pratique-guitare-export-2026-11-14.zip');
    expect(count).toBe(2);

    const zip = await bytesOf(blob);
    const raw = JSON.parse(new TextDecoder().decode((await readZip(zip)).get('export.json')!));
    expect(raw).toMatchObject({ format: 'ecosysteme.export', formatVersion: 1, app: APP_SLUG, appVersion: '1.1.0', schemaVersion: SCHEMA_VERSION });
    expect(JSON.stringify(raw)).not.toContain('secret');

    const backup = await readBackup(zip);
    expect(backup.items.map((i) => i.entry.id)).toEqual(['a1', 'b2']);
    expect(backup.items[0]!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(backup.items[0]!.entry.fingers).toEqual({ '0|1:0:0:2': 3 });
    expect((backup.items[0]!.entry as unknown as Record<string, unknown>).futur).toBe('champ inconnu gardé');
    expect(backup.items[0]!.entry.settings.speed).toBe(0.6);
    expect(backup.items[1]!.media).toEqual(new Uint8Array([9, 8]));
    expect(backup.preferences).toEqual({ theme: 'light', a4: 442 });
    expect(backup.unreadable).toBe(0);
  });

  it('une fiche sans fichier n’est pas exportée', async () => {
    const { count } = await buildBackup({ entries: [entry('x')], files: async () => ({}), preferences: {}, appVersion: '1.1.0' });
    expect(count).toBe(0);
  });

  it('refuse un fichier qui n’est pas une sauvegarde de l’app, ou d’une version plus récente', async () => {
    await expect(readBackup(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(BackupError);
    const envelope = (extra: Record<string, unknown>): Promise<Blob> =>
      makeZip([{ name: 'export.json', data: new TextEncoder().encode(JSON.stringify({ format: 'ecosysteme.export', app: APP_SLUG, schemaVersion: 2, data: {}, ...extra })) }]);
    await expect(readBackup(await bytesOf(await envelope({ app: 'ma-journee' })))).rejects.toThrow(/autre app/);
    await expect(readBackup(await bytesOf(await envelope({ schemaVersion: SCHEMA_VERSION + 1 })))).rejects.toThrow(/plus récente/);
    await expect(readBackup(await bytesOf(await makeZip([{ name: 'autre.txt', data: new Uint8Array([1]) }])))).rejects.toThrow(/export\.json/);
  });

  it('lit une sauvegarde de schéma 1 en la migrant, et compte les fiches inutilisables', async () => {
    const json = {
      format: 'ecosysteme.export',
      app: APP_SLUG,
      schemaVersion: 1,
      data: { partitions: [{ id: 'v1', fileName: 'v1.gp5', title: 'Ancienne', format: 'gp3-5', size: 1, addedAt: 1, openedAt: 1, settings: { speed: 0.5 } }, { id: 'sans-fichier', fileName: 'x', format: 'midi' }, { id: '../evasion', fileName: 'x', format: 'midi' }] },
    };
    const zip = await bytesOf(await makeZip([{ name: 'export.json', data: new TextEncoder().encode(JSON.stringify(json)) }, { name: 'fichiers/v1', data: new Uint8Array([5]) }]));
    const backup = await readBackup(zip);
    expect(backup.items).toHaveLength(1);
    expect(backup.items[0]!.entry.settings).toMatchObject({ speed: 0.5, loop: true, wholeBars: true, trackIndex: 0, selection: null });
    expect(backup.items[0]!.entry.artist).toBe('');
    expect(backup.unreadable).toBe(2);
  });

  it('l’import ne remplace rien : partitions et réglages déjà présents gardés', async () => {
    const backup = {
      appVersion: '1.1.0',
      exportedAt: '',
      schemaVersion: 2,
      unreadable: 0,
      preferences: { theme: 'light', a4: 442 },
      items: [
        { entry: entry('meme-id'), bytes: new Uint8Array([1]) },
        { entry: entry('autre-id', { fileName: 'deja.gp5', size: 7 }), bytes: new Uint8Array([1]) },
        { entry: entry('nouvelle'), bytes: new Uint8Array([1]) },
      ],
    };
    const existing = [entry('meme-id'), entry('locale', { fileName: 'deja.gp5', size: 7 })];
    const plan = planImport(backup, existing, { theme: 'dark' });
    expect(plan.add.map((i) => i.entry.id)).toEqual(['nouvelle']);
    expect(plan.skipped.map((e) => e.id)).toEqual(['meme-id', 'autre-id']);
    expect(plan.preferences).toEqual({ a4: 442 });
    expect(describePlan(plan)).toContain('1 partition à ajouter');
    expect(describePlan(plan)).toContain('diapason');
  });

  it('restaure une sauvegarde dans une bibliothèque vide', async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    const library = await ScoreLibrary.open();
    const item = { entry: entry('restauree'), bytes: new Uint8Array([4, 4]), media: new Uint8Array([7]) };
    await library.add(item.entry, item.bytes, item.media);
    expect(await library.getFiles('restauree')).toEqual({ bytes: new Uint8Array([4, 4]), media: new Uint8Array([7]) });
  });
});

describe('Migrations du schéma', () => {
  it('v1 → v2 : réglages complétés, champs facultatifs mal formés retirés, champs inconnus gardés', () => {
    const migrated = migrateEntry({ id: 'abc', fileName: 'f.mid', format: 'midi', settings: { speed: 3, loop: 'oui' }, media: 'cassé', inconnu: 1 }, 1)!;
    expect(migrated.title).toBe('f.mid');
    expect(migrated.settings).toMatchObject({ speed: 1, loop: true });
    expect('media' in migrated).toBe(false);
    expect((migrated as unknown as Record<string, unknown>).inconnu).toBe(1);
  });

  it('rejouable sans dommage, et refuse une version plus récente', () => {
    const once = migrateEntry(entry('z'), 1)!;
    expect(migrateEntry(once, SCHEMA_VERSION)).toEqual(once);
    expect(migrateEntry(entry('z'), SCHEMA_VERSION + 1)).toBe(null);
    expect(migrateEntry({ id: 'sans-format', fileName: 'x' }, 1)).toBe(null);
  });

  it('migre une base IndexedDB de version 1 à l’ouverture, sans toucher aux fichiers', async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('pratique-guitare', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('entries', { keyPath: 'id' }).put({ id: 'ancienne', fileName: 'a.gp5', title: 'A', artist: '', format: 'gp3-5', size: 1, addedAt: 1, openedAt: 1, settings: { trackIndex: 1 } });
        db.createObjectStore('files').put(new Uint8Array([3, 1]).buffer, 'ancienne');
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const library = await ScoreLibrary.open();
    const migrated = await library.get('ancienne');
    expect(migrated?.settings).toMatchObject({ trackIndex: 1, speed: 1, loop: true, wholeBars: true, selection: null });
    expect(await library.getFile('ancienne')).toEqual(new Uint8Array([3, 1]));
  });
});
