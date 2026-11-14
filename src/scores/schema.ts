/**
 * Version du schéma de la bibliothèque et migrations des fiches de partition (`ScoreEntry`).
 * Fonctions pures, rejouables sans dommage, qui gardent les champs qu'elles ne connaissent pas.
 * Servent à l'ouverture de la base (IndexedDB, `onupgradeneeded`) et à l'import d'une sauvegarde.
 *
 * Historique :
 * - 1 : schéma d'origine (2026-10-19). Huit champs ajoutés ensuite sans changer de version
 *   (`origin`, `tabBars`, `fingers`, `rhythm`, `media`, `sync`, `settings.followMedia`, `settings.fingering`),
 *   tous facultatifs.
 * - 2 : version déclarée (1.1.0). Fiche validée, réglages de lecture complétés par les valeurs par défaut,
 *   champs facultatifs mal formés retirés plutôt que de faire échouer la lecture.
 */
import type { ScoreFormat } from './formats';
import type { ScoreEntry, ScoreSettings } from './library';

export const SCHEMA_VERSION = 2;

const FORMATS: readonly ScoreFormat[] = ['gp3-5', 'gpx', 'gp7', 'musicxml', 'mxl', 'midi'];

/** Identifiant sûr (aussi utilisé comme nom de fichier dans une sauvegarde). */
export const isEntryId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const SETTINGS_DEFAULTS: ScoreSettings = {
  trackIndex: 0,
  speed: 1,
  loop: true,
  wholeBars: true,
  selection: null,
};

function migrateSettings(raw: unknown): ScoreSettings {
  const s = isRecord(raw) ? raw : {};
  const selection = isRecord(s.selection) && ['startBar', 'startBeat', 'endBar', 'endBeat'].every((k) => isFiniteNumber((s.selection as Record<string, unknown>)[k]))
    ? (s.selection as unknown as ScoreSettings['selection'])
    : null;
  const out: ScoreSettings & Record<string, unknown> = {
    ...s,
    trackIndex: isFiniteNumber(s.trackIndex) && s.trackIndex >= 0 ? Math.floor(s.trackIndex) : SETTINGS_DEFAULTS.trackIndex,
    speed: isFiniteNumber(s.speed) ? Math.min(1, Math.max(0.25, s.speed)) : SETTINGS_DEFAULTS.speed,
    loop: typeof s.loop === 'boolean' ? s.loop : SETTINGS_DEFAULTS.loop,
    wholeBars: typeof s.wholeBars === 'boolean' ? s.wholeBars : SETTINGS_DEFAULTS.wholeBars,
    selection,
  };
  if ('followMedia' in out && typeof out.followMedia !== 'boolean') delete out.followMedia;
  if ('fingering' in out && typeof out.fingering !== 'boolean') delete out.fingering;
  return out;
}

/** Étape 1 → 2. Renvoie null si la fiche est inutilisable (identité ou format manquants). */
function v1ToV2(raw: Record<string, unknown>): ScoreEntry | null {
  if (!isEntryId(raw.id) || typeof raw.fileName !== 'string') return null;
  if (typeof raw.format !== 'string' || !(FORMATS as readonly string[]).includes(raw.format)) return null;
  const now = Date.now();
  const out: Record<string, unknown> = {
    ...raw,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : raw.fileName,
    artist: typeof raw.artist === 'string' ? raw.artist : '',
    size: isFiniteNumber(raw.size) && raw.size >= 0 ? raw.size : 0,
    addedAt: isFiniteNumber(raw.addedAt) ? raw.addedAt : now,
    openedAt: isFiniteNumber(raw.openedAt) ? raw.openedAt : isFiniteNumber(raw.addedAt) ? raw.addedAt : now,
    settings: migrateSettings(raw.settings),
  };
  if ('origin' in out && out.origin !== 'pdf' && out.origin !== 'pdf-tab') delete out.origin;
  if ('tabBars' in out && typeof out.tabBars !== 'boolean') delete out.tabBars;
  if ('fingers' in out && !isRecord(out.fingers)) delete out.fingers;
  if ('rhythm' in out && !(isRecord(out.rhythm) && Array.isArray(out.rhythm.sources) && Array.isArray(out.rhythm.doubtfulBars))) delete out.rhythm;
  if ('media' in out && !(isRecord(out.media) && (out.media.kind === 'youtube' || out.media.kind === 'audio'))) delete out.media;
  if ('sync' in out && !(isRecord(out.sync) && Array.isArray(out.sync.times) && Array.isArray(out.sync.points))) delete out.sync;
  return out as unknown as ScoreEntry;
}

const STEPS: Record<number, (raw: Record<string, unknown>) => ScoreEntry | null> = {
  1: v1ToV2,
};

/**
 * Met une fiche lue dans une version `from` à la version courante.
 * Une version inconnue ou plus récente que l'app renvoie null : la fiche n'est jamais réécrite.
 */
export function migrateEntry(raw: unknown, from: number): ScoreEntry | null {
  if (!isRecord(raw) || !Number.isInteger(from) || from < 1 || from > SCHEMA_VERSION) return null;
  let current: Record<string, unknown> | null = raw;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = STEPS[v];
    if (!step || !current) return null;
    current = step(current) as unknown as Record<string, unknown> | null;
  }
  // Déjà à la version courante : on revalide quand même (import d'une sauvegarde).
  return current ? v1ToV2(current) : null;
}
