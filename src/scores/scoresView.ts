import { navigate } from '../shell/router';
import { showToast } from '../shell/toast';
import type { View } from '../shell/view';
import { h } from '../ui/dom';
import { AppError, describeError } from '../ui/errors';
import { type Score, loadAlphaTab, parseScore } from './alphatab';
import { MAX_FILE_BYTES, detectScoreBytes } from './formats';
import {
  DEFAULT_SETTINGS,
  type ScoreEntry,
  ScoreLibrary,
  newEntryId,
  requestPersistentStorage,
} from './library';
import { LibraryView } from './libraryView';
import { pdfGuide } from './pdfGuide';
import { ScorePlayerView } from './playerView';
import { prepareScore } from './prepare';

const NB = ' ';
const SAVE_DELAY_MS = 400;

export interface ScoresView extends View {
  /** Met la lecture en pause (ex. l'accordeur ouvre le micro). */
  pause(): void;
}

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || fileName;
const alert = (message: string): HTMLElement => h('p', { class: 'alert', role: 'alert' }, message);
/** alphaTab remplace les espaces des titres MusicXML par des espaces insécables : on les normalise. */
const cleanText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Écran Partitions : bibliothèque locale (IndexedDB) et lecteur.
 * « #/partitions » affiche la bibliothèque, « #/partitions/<id> » ouvre une partition.
 */
export function createScoresView(): ScoresView {
  let library: ScoreLibrary | null = null;
  let libraryReady: Promise<void> | null = null;
  let storageWarned = false;
  /** Partitions gardées en mémoire quand la bibliothèque n'est pas disponible (navigation privée). */
  const sessionScores = new Map<string, { entry: ScoreEntry; bytes: Uint8Array }>();
  /** Dernière partition analysée, pour ne pas la relire juste après l'import. */
  let parsed: { id: string; score: Score; notice: string | null } | null = null;
  let openId: string | null = null;
  let pendingSave: ScoreEntry | null = null;
  let saveTimer: number | undefined;

  const libraryView = new LibraryView({ onImport: importFile, onDelete: deleteEntry, onRename: renameEntry });
  const player = new ScorePlayerView({
    onBack: () => navigate('partitions'),
    onSettingsChange: scheduleSave,
  });
  player.element.hidden = true;

  const element = h(
    'section',
    { class: 'view view--scores', 'aria-labelledby': 'view-title' },
    libraryView.element,
    player.element,
  );

  // --- Bibliothèque ------------------------------------------------------------

  function ensureLibrary(): Promise<void> {
    libraryReady ??= ScoreLibrary.open()
      .then((opened) => {
        library = opened;
      })
      .catch(() => {
        library = null;
      });
    return libraryReady;
  }

  async function allEntries(): Promise<ScoreEntry[]> {
    await ensureLibrary();
    const stored = library ? await library.list().catch(() => []) : [];
    const session = [...sessionScores.values()].map((s) => s.entry);
    return [...session, ...stored].sort((a, b) => b.openedAt - a.openedAt);
  }

  async function findEntry(id: string): Promise<{ entry: ScoreEntry; bytes: () => Promise<Uint8Array | undefined> } | null> {
    const session = sessionScores.get(id);
    if (session) return { entry: session.entry, bytes: async () => session.bytes };
    await ensureLibrary();
    const entry = library ? await library.get(id) : undefined;
    if (!entry || !library) return null;
    const lib = library;
    return { entry, bytes: () => lib.getFile(id) };
  }

  async function refresh(): Promise<void> {
    libraryView.render(await allEntries());
  }

  function scheduleSave(entry: ScoreEntry): void {
    pendingSave = entry;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, SAVE_DELAY_MS);
  }

  function flushSave(): void {
    window.clearTimeout(saveTimer);
    const entry = pendingSave;
    pendingSave = null;
    if (!entry || sessionScores.has(entry.id) || !library) return;
    library.update(entry).catch(() => {
      // Échec d'enregistrement des réglages : sans conséquence pour la séance en cours.
    });
  }

  // Les réglages en attente sont enregistrés avant que la page ne soit fermée ou masquée.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
  window.addEventListener('pagehide', flushSave);

  // --- Import ------------------------------------------------------------------

  async function importFile(file: File): Promise<void> {
    libraryView.setBusy(true);
    libraryView.showMessage(null);
    try {
      if (file.size > MAX_FILE_BYTES) {
        throw new AppError('file-invalid', `Fichier invalide${NB}: «${NB}${file.name}${NB}» dépasse 50${NB}Mo.`);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        throw new AppError('file-unreadable');
      }

      const detection = detectScoreBytes(file.name, bytes);
      if (detection.kind === 'pdf') {
        libraryView.showMessage(pdfGuide(file.name));
        return;
      }
      if (detection.kind !== 'score') {
        libraryView.showMessage(alert(detection.message));
        return;
      }

      await ensureLibrary();
      const duplicate = library ? await library.findDuplicate(file.name, file.size) : undefined;
      if (duplicate) {
        showToast(`«${NB}${duplicate.title}${NB}» est déjà dans la bibliothèque.`);
        navigate('partitions', duplicate.id);
        return;
      }

      // Le fichier est lu entièrement AVANT d'être enregistré : un fichier illisible n'entre pas dans la bibliothèque.
      const prepared = await prepareScore(detection.format, bytes, baseName(file.name));
      const at = await loadAlphaTab();
      const score = parseScore(at, prepared.data);
      const now = Date.now();
      const entry: ScoreEntry = {
        id: newEntryId(),
        fileName: file.name,
        title: cleanText(score.title) || baseName(file.name),
        artist: cleanText(score.artist),
        format: detection.format,
        size: file.size,
        addedAt: now,
        openedAt: now,
        settings: { ...DEFAULT_SETTINGS },
      };
      parsed = { id: entry.id, score, notice: prepared.notice };

      try {
        if (!library) throw new AppError('storage-unavailable');
        await library.add(entry, bytes);
        void requestPersistentStorage();
      } catch (error) {
        sessionScores.set(entry.id, { entry, bytes });
        if (!storageWarned) {
          storageWarned = true;
          showToast(describeError(error), undefined, 8000);
        }
      }
      navigate('partitions', entry.id);
    } catch (error) {
      libraryView.showMessage(alert(describeError(error)));
    } finally {
      libraryView.setBusy(false);
    }
  }

  // --- Ouverture, suppression, renommage ---------------------------------------

  function showLibrary(): void {
    openId = null;
    player.pause();
    player.element.hidden = true;
    libraryView.element.hidden = false;
    element.classList.remove('is-player');
    void refresh();
  }

  async function openScore(id: string): Promise<void> {
    if (openId === id && !player.element.hidden) return;
    openId = id;
    libraryView.showMessage(null);
    libraryView.element.hidden = true;
    player.element.hidden = false;
    element.classList.add('is-player');

    try {
      const found = await findEntry(id);
      if (!found) {
        navigate('partitions', null, true);
        libraryView.showMessage(alert("Cette partition n'est plus dans la bibliothèque."));
        return;
      }
      const { entry } = found;
      let score: Score;
      let notice: string | null;
      if (parsed?.id === id) {
        ({ score, notice } = parsed);
      } else {
        const bytes = await found.bytes();
        if (!bytes) throw new AppError('file-unreadable');
        const prepared = await prepareScore(entry.format, bytes, entry.title);
        score = parseScore(await loadAlphaTab(), prepared.data);
        notice = prepared.notice;
        parsed = { id, score, notice };
      }
      if (openId !== id) return; // l'utilisateur est reparti entre-temps

      entry.openedAt = Date.now();
      scheduleSave(entry);
      await player.open(entry, score, notice);
    } catch (error) {
      if (openId !== id) return;
      navigate('partitions', null, true);
      libraryView.showMessage(alert(describeError(error)));
    }
  }

  async function deleteEntry(entry: ScoreEntry): Promise<void> {
    const session = sessionScores.get(entry.id);
    sessionScores.delete(entry.id);
    if (parsed?.id === entry.id) parsed = null;
    let removed: { entry: ScoreEntry; bytes: Uint8Array } | null = session ?? null;
    try {
      if (!session && library) removed = await library.remove(entry.id);
    } catch (error) {
      libraryView.showMessage(alert(describeError(error)));
    }
    await refresh();
    showToast(
      `«${NB}${entry.title}${NB}» supprimée.`,
      {
        label: 'Annuler',
        run: () => {
          if (!removed) return;
          const restore = removed;
          const done = session
            ? Promise.resolve(void sessionScores.set(restore.entry.id, restore))
            : (library?.add(restore.entry, restore.bytes) ?? Promise.resolve());
          void done.then(refresh, (error: unknown) => libraryView.showMessage(alert(describeError(error))));
        },
      },
      6000,
    );
  }

  async function renameEntry(entry: ScoreEntry, title: string): Promise<void> {
    entry.title = title;
    try {
      if (!sessionScores.has(entry.id) && library) await library.update(entry);
    } catch (error) {
      libraryView.showMessage(alert(describeError(error)));
    }
    await refresh();
  }

  // Tests de bout en bout : accès au lecteur alphaTab, uniquement avec « ?e2e » dans l'adresse.
  if (new URLSearchParams(location.search).has('e2e')) {
    (window as Window & { __scores?: unknown }).__scores = { debug: () => player.debugHandle() };
  }

  function route(param: string | null): void {
    if (param) void openScore(param);
    else showLibrary();
  }

  return {
    id: 'partitions',
    title: 'Partitions',
    element,
    enter: route,
    update: route,
    leave() {
      player.pause();
      flushSave();
    },
    pause() {
      player.pause();
    },
  };
}
