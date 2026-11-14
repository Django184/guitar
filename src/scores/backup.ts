/**
 * Sauvegarde de la bibliothèque : une archive .zip au format commun de l'écosystème
 * (`export.json` dans l'enveloppe `ecosysteme.export`, et un dossier `fichiers/`).
 *
 *   export.json                 enveloppe : app, versions, date, fiches et préférences
 *   fichiers/<id>               contenu de la partition (MusicXML pour un fichier converti)
 *   fichiers/<id>.media         enregistrement audio de référence, s'il y en a un
 *
 * Jamais exportée : la clé YouTube (secret propre à l'appareil).
 * L'import ne remplace rien : une partition déjà présente (même identifiant, ou même nom et même
 * taille de fichier) est laissée telle quelle, une préférence déjà réglée sur l'appareil aussi.
 */
import { makeZip, type ZipInput } from '../shell/zip';
import type { ScoreEntry } from './library';
import { SCHEMA_VERSION, isEntryId, migrateEntry } from './schema';
import { ZipFormatError, readZip } from './unzip';

export const EXPORT_FORMAT = 'ecosysteme.export';
export const EXPORT_FORMAT_VERSION = 1;
export const APP_SLUG = 'pratique-guitare';

/** Préférences exportées (clés sans le préfixe « pg. »). La clé YouTube n'en fait pas partie. */
export const EXPORTED_PREFS = ['theme', 'a4', 'bpm', 'meter', 'tuning', 'rhythmProxy'] as const;

export const PREF_LABELS: Record<(typeof EXPORTED_PREFS)[number], string> = {
  theme: 'thème',
  a4: 'diapason',
  bpm: 'tempo du métronome',
  meter: 'mesure du métronome',
  tuning: 'accordage',
  rhythmProxy: 'proxy des partitions',
};

export interface BackupItem {
  entry: ScoreEntry;
  bytes: Uint8Array;
  media?: Uint8Array;
}

export interface Backup {
  appVersion: string;
  exportedAt: string;
  schemaVersion: number;
  items: BackupItem[];
  preferences: Record<string, unknown>;
  /** Fiches présentes dans export.json mais inutilisables (fichier manquant, fiche invalide). */
  unreadable: number;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** Fichiers Guitar Pro 6 à 8 et .mxl : déjà compressés. */
const STORED_FORMATS = new Set(['gpx', 'gp7', 'mxl']);

const pad = (n: number): string => String(n).padStart(2, '0');

export function backupFileName(now: Date): string {
  return `${APP_SLUG}-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

export async function buildBackup(options: {
  entries: ScoreEntry[];
  files: (id: string) => Promise<{ bytes?: Uint8Array; media?: Uint8Array }>;
  preferences: Record<string, unknown>;
  appVersion: string;
  now?: Date;
}): Promise<{ blob: Blob; fileName: string; count: number }> {
  const now = options.now ?? new Date();
  const zipFiles: ZipInput[] = [];
  const partitions: ScoreEntry[] = [];
  for (const entry of options.entries) {
    if (!isEntryId(entry.id)) continue;
    const { bytes, media } = await options.files(entry.id);
    if (!bytes) continue; // fiche sans fichier : rien à restaurer
    partitions.push(entry);
    zipFiles.push({ name: `fichiers/${entry.id}`, data: bytes, store: !entry.origin && STORED_FORMATS.has(entry.format) });
    if (media) zipFiles.push({ name: `fichiers/${entry.id}.media`, data: media, store: true });
  }
  const preferences: Record<string, unknown> = {};
  for (const key of EXPORTED_PREFS) if (key in options.preferences) preferences[key] = options.preferences[key];

  const envelope = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    app: APP_SLUG,
    appVersion: options.appVersion,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data: { partitions, preferences },
  };
  const json = new TextEncoder().encode(JSON.stringify(envelope, null, 1));
  const blob = await makeZip([{ name: 'export.json', data: json }, ...zipFiles]);
  return { blob, fileName: backupFileName(now), count: partitions.length };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readBackup(bytes: Uint8Array): Promise<Backup> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch (error) {
    if (error instanceof ZipFormatError) throw new BackupError('Ce fichier n’est pas une sauvegarde de Pratique Guitare (archive .zip illisible).');
    throw error;
  }
  const raw = files.get('export.json');
  if (!raw) throw new BackupError('Cette archive ne contient pas de sauvegarde (export.json manquant).');
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new BackupError('La sauvegarde est abîmée (export.json illisible).');
  }
  if (!isRecord(envelope) || envelope.format !== EXPORT_FORMAT) throw new BackupError('Ce fichier n’est pas une sauvegarde au format commun.');
  if (envelope.app !== APP_SLUG) throw new BackupError(`Cette sauvegarde vient d’une autre app (${String(envelope.app)}).`);
  const schemaVersion = envelope.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) throw new BackupError('Version de sauvegarde inconnue.');
  if (schemaVersion > SCHEMA_VERSION) throw new BackupError('Cette sauvegarde vient d’une version plus récente de l’app : mettez l’app à jour, puis réessayez.');
  const data = isRecord(envelope.data) ? envelope.data : {};
  const partitions = Array.isArray(data.partitions) ? data.partitions : [];

  const items: BackupItem[] = [];
  let unreadable = 0;
  for (const rawEntry of partitions) {
    const entry = migrateEntry(rawEntry, schemaVersion);
    const fileBytes = entry ? files.get(`fichiers/${entry.id}`) : undefined;
    if (!entry || !fileBytes) {
      unreadable += 1;
      continue;
    }
    const media = files.get(`fichiers/${entry.id}.media`);
    items.push({ entry, bytes: fileBytes, ...(media ? { media } : {}) });
  }
  const preferences: Record<string, unknown> = {};
  if (isRecord(data.preferences)) {
    for (const key of EXPORTED_PREFS) if (key in data.preferences) preferences[key] = data.preferences[key];
  }
  return {
    appVersion: typeof envelope.appVersion === 'string' ? envelope.appVersion : '?',
    exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt : '',
    schemaVersion,
    items,
    preferences,
    unreadable,
  };
}

export interface ImportPlan {
  add: BackupItem[];
  skipped: ScoreEntry[];
  /** Préférences reprises : seulement celles qui ne sont pas réglées sur cet appareil. */
  preferences: Record<string, unknown>;
  unreadable: number;
}

/** Ce que l'import fera, sans rien écrire. */
export function planImport(backup: Backup, existing: ScoreEntry[], localPreferences: Record<string, unknown>): ImportPlan {
  const ids = new Set(existing.map((e) => e.id));
  const files = new Set(existing.map((e) => `${e.fileName}\u0000${e.size}`));
  const add: BackupItem[] = [];
  const skipped: ScoreEntry[] = [];
  for (const item of backup.items) {
    const fileKey = `${item.entry.fileName}\u0000${item.entry.size}`;
    if (ids.has(item.entry.id) || files.has(fileKey)) skipped.push(item.entry);
    else {
      add.push(item);
      ids.add(item.entry.id);
      files.add(fileKey);
    }
  }
  const preferences: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(backup.preferences)) if (!(key in localPreferences)) preferences[key] = value;
  return { add, skipped, preferences, unreadable: backup.unreadable };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/** Résumé en une ou deux phrases, montré avant d'écrire. */
export function describePlan(plan: ImportPlan): string {
  const parts: string[] = [];
  parts.push(plan.add.length ? `${plural(plan.add.length, 'partition à ajouter', 'partitions à ajouter')}.` : 'Aucune nouvelle partition.');
  if (plan.skipped.length) parts.push(`${plural(plan.skipped.length, 'déjà présente, gardée', 'déjà présentes, gardées')} telle${plan.skipped.length > 1 ? 's' : ''} quelle${plan.skipped.length > 1 ? 's' : ''}.`);
  if (plan.unreadable) parts.push(`${plural(plan.unreadable, 'fiche illisible ignorée', 'fiches illisibles ignorées')}.`);
  const prefs = Object.keys(plan.preferences).map((k) => PREF_LABELS[k as keyof typeof PREF_LABELS] ?? k);
  if (prefs.length) parts.push(`Réglages repris : ${prefs.join(', ')}.`);
  return parts.join(' ');
}
