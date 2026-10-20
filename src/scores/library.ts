/**
 * Bibliothèque locale des partitions importées (IndexedDB).
 * Deux magasins : « entries » (métadonnées et réglages, listés rapidement)
 * et « files » (contenu des fichiers, chargé à l'ouverture : la partition sous son id,
 * l'enregistrement audio de référence éventuel sous « <id>:media »).
 */
import { AppError } from '../ui/errors';
import type { ScoreFormat } from './formats';
import type { SyncPoint } from './sync/rhythmFit';

const DB_NAME = 'pratique-guitare';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const FILES = 'files';

/** Passage choisi, repéré par mesures et temps (indices dans la première voix). */
export interface StoredSelection {
  startBar: number;
  startBeat: number;
  endBar: number;
  endBeat: number;
}

export interface ScoreSettings {
  trackIndex: number;
  /** Vitesse de lecture, de 0,25 à 1. */
  speed: number;
  loop: boolean;
  /** Sélection par mesures entières plutôt que par notes. */
  wholeBars: boolean;
  selection: StoredSelection | null;
  /** Lecture avec l'enregistrement de référence (vidéo ou audio) au lieu du synthétiseur. */
  followMedia?: boolean;
}

/** Enregistrement de référence lié à la partition : vidéo YouTube ou fichier audio. */
export type MediaLink =
  | { kind: 'youtube'; id: string; title: string; channel?: string }
  | { kind: 'audio'; name: string; type: string; size: number };

/** Identifiant stable d'un enregistrement (les instants calés s'y rapportent). */
export const mediaKey = (media: MediaLink): string => (media.kind === 'youtube' ? `youtube:${media.id}` : `audio:${media.name}:${media.size}`);

/** Calage de la partition sur un enregistrement. */
export interface ScoreSync {
  /** mediaKey() de l'enregistrement. */
  media: string;
  /** Instant (s) de chaque note de la partition, dans l'ordre ; null si inconnu. */
  times: Array<number | null>;
  /** Débuts de mesure ↔ instants (ms), pour suivre l'enregistrement pendant la lecture. */
  points: SyncPoint[];
}

export interface ScoreEntry {
  id: string;
  fileName: string;
  title: string;
  artist: string;
  format: ScoreFormat;
  /**
   * Fichier d'origine converti par l'app (le magasin garde alors le MusicXML obtenu) :
   * « pdf » partition lue dans un PDF, « pdf-tab » tablature texte (rythme déduit de l'espacement).
   */
  origin?: 'pdf' | 'pdf-tab';
  /** Tablature texte : ses barres de mesure étaient écrites (les mesures sont donc fiables). */
  tabBars?: boolean;
  /** Enregistrement de référence. */
  media?: MediaLink;
  sync?: ScoreSync;
  size: number;
  addedAt: number;
  openedAt: number;
  settings: ScoreSettings;
}

export const DEFAULT_SETTINGS: ScoreSettings = {
  trackIndex: 0,
  speed: 1,
  loop: true,
  wholeBars: true,
  selection: null,
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction annulée', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

function storageError(error: unknown): AppError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') return new AppError('storage-full');
  return new AppError('storage-unavailable');
}

export class ScoreLibrary {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<ScoreLibrary> {
    if (typeof indexedDB === 'undefined') throw new AppError('storage-unavailable');
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      };
      return new ScoreLibrary(await request(req));
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Partitions, de la plus récemment ouverte à la plus ancienne. */
  async list(): Promise<ScoreEntry[]> {
    const tx = this.db.transaction(ENTRIES, 'readonly');
    const entries = await request(tx.objectStore(ENTRIES).getAll() as IDBRequest<ScoreEntry[]>);
    return entries.sort((a, b) => b.openedAt - a.openedAt || b.addedAt - a.addedAt);
  }

  async get(id: string): Promise<ScoreEntry | undefined> {
    const tx = this.db.transaction(ENTRIES, 'readonly');
    return request(tx.objectStore(ENTRIES).get(id) as IDBRequest<ScoreEntry | undefined>);
  }

  async getFile(id: string): Promise<Uint8Array | undefined> {
    const tx = this.db.transaction(FILES, 'readonly');
    const data = await request(tx.objectStore(FILES).get(id) as IDBRequest<ArrayBuffer | undefined>);
    return data ? new Uint8Array(data) : undefined;
  }

  /** Même nom et même taille : très probablement le même fichier, déjà importé. */
  async findDuplicate(fileName: string, size: number): Promise<ScoreEntry | undefined> {
    return (await this.list()).find((e) => e.fileName === fileName && e.size === size);
  }

  async add(entry: ScoreEntry, bytes: Uint8Array, media?: Uint8Array): Promise<void> {
    try {
      const tx = this.db.transaction([ENTRIES, FILES], 'readwrite');
      tx.objectStore(ENTRIES).put(entry);
      // Copie dans un ArrayBuffer propre : le tampon d'origine peut être plus grand que la vue.
      tx.objectStore(FILES).put(bytes.slice().buffer, entry.id);
      if (media) tx.objectStore(FILES).put(media.slice().buffer, mediaFileKey(entry.id));
      await done(tx);
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Enregistrement audio de référence (null : le supprimer). */
  async setMedia(id: string, bytes: Uint8Array | null): Promise<void> {
    try {
      const tx = this.db.transaction(FILES, 'readwrite');
      if (bytes) tx.objectStore(FILES).put(bytes.slice().buffer, mediaFileKey(id));
      else tx.objectStore(FILES).delete(mediaFileKey(id));
      await done(tx);
    } catch (error) {
      throw storageError(error);
    }
  }

  getMedia(id: string): Promise<Uint8Array | undefined> {
    return this.getFile(mediaFileKey(id));
  }

  async update(entry: ScoreEntry): Promise<void> {
    try {
      const tx = this.db.transaction(ENTRIES, 'readwrite');
      tx.objectStore(ENTRIES).put(entry);
      await done(tx);
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Supprime une partition et renvoie de quoi annuler la suppression. */
  async remove(id: string): Promise<{ entry: ScoreEntry; bytes: Uint8Array; media?: Uint8Array } | null> {
    const entry = await this.get(id);
    const bytes = await this.getFile(id);
    const media = await this.getMedia(id);
    const tx = this.db.transaction([ENTRIES, FILES], 'readwrite');
    tx.objectStore(ENTRIES).delete(id);
    tx.objectStore(FILES).delete(id);
    tx.objectStore(FILES).delete(mediaFileKey(id));
    await done(tx);
    return entry && bytes ? { entry, bytes, ...(media ? { media } : {}) } : null;
  }
}

/** Demande au navigateur de ne pas effacer la bibliothèque en cas de manque de place. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Facultatif : sans persistance, le navigateur garde tout de même les données en temps normal.
  }
}

const mediaFileKey = (id: string): string => `${id}:media`;

export function newEntryId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
