/**
 * Réglages › Sauvegarde : export de la bibliothèque dans un fichier .zip, et import d'une sauvegarde
 * avec un résumé avant toute écriture. Rien n'est remplacé (voir scores/backup.ts).
 */
import { BackupError, EXPORTED_PREFS, buildBackup, describePlan, planImport, readBackup, type ImportPlan } from '../scores/backup';
import { ScoreLibrary, requestPersistentStorage } from '../scores/library';
import { h } from '../ui/dom';
import { readPrefs, writePrefs } from './storage';

const NB = ' ';
const fr = (text: string): string => text.replace(/ ([:;!?»])/g, `${NB}$1`).replace(/« /g, `«${NB}`);

/** La bibliothèque a changé hors de l'écran Partitions (import d'une sauvegarde). */
export const LIBRARY_CHANGE = 'librarychange';

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: fileName, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  // Laisse au navigateur le temps de lire le fichier avant de libérer l'adresse.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const describe = (error: unknown): string =>
  error instanceof BackupError ? error.message : fr('La sauvegarde n’a pas pu être lue. Réessayez, ou choisissez un autre fichier.');

export function backupRows(): HTMLElement {
  const exportBtn = h('button', { type: 'button', class: 'btn btn--small', 'data-testid': 'backup-export' }, 'Exporter');
  const importBtn = h('button', { type: 'button', class: 'btn btn--small', 'data-testid': 'backup-import' }, 'Importer');
  const input = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, 'data-testid': 'backup-file' });
  const status = h('p', { class: 'row__hint', role: 'status', 'data-testid': 'backup-status' });
  const confirm = h('button', { type: 'button', class: 'btn btn--small btn--primary', 'data-testid': 'backup-confirm' }, 'Importer');
  const cancel = h('button', { type: 'button', class: 'btn btn--small' }, 'Annuler');
  const confirmLine = h('div', { class: 'field-line', hidden: true }, confirm, cancel);
  let pending: ImportPlan | null = null;

  const setStatus = (text: string, alert = false): void => {
    status.setAttribute('role', alert ? 'alert' : 'status');
    status.textContent = text;
  };
  const busy = (on: boolean): void => {
    exportBtn.disabled = on;
    importBtn.disabled = on;
    confirm.disabled = on;
  };
  const reset = (): void => {
    pending = null;
    confirmLine.hidden = true;
  };

  exportBtn.addEventListener('click', () => {
    void (async () => {
      reset();
      busy(true);
      setStatus('Préparation de la sauvegarde…');
      try {
        const library = await ScoreLibrary.open();
        const entries = await library.list();
        const { blob, fileName, count } = await buildBackup({
          entries,
          files: (id) => library.getFiles(id),
          preferences: readPrefs(EXPORTED_PREFS),
          appVersion: __APP_SEMVER__,
        });
        download(blob, fileName);
        setStatus(fr(`${count}${NB}partition${count > 1 ? 's' : ''} exportée${count > 1 ? 's' : ''} dans « ${fileName} ».`));
      } catch {
        setStatus(fr('L’export a échoué : la bibliothèque n’est pas disponible dans ce navigateur.'), true);
      } finally {
        busy(false);
      }
    })();
  });

  importBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void (async () => {
      reset();
      busy(true);
      setStatus('Lecture de la sauvegarde…');
      try {
        const backup = await readBackup(new Uint8Array(await file.arrayBuffer()));
        const library = await ScoreLibrary.open();
        const plan = planImport(backup, await library.list(), readPrefs(EXPORTED_PREFS));
        if (!plan.add.length && !Object.keys(plan.preferences).length) {
          setStatus(fr(`${describePlan(plan)} Rien à importer.`));
          return;
        }
        pending = plan;
        setStatus(fr(describePlan(plan)));
        confirmLine.hidden = false;
        confirm.focus();
      } catch (error) {
        setStatus(describe(error), true);
      } finally {
        busy(false);
      }
    })();
  });

  cancel.addEventListener('click', () => {
    reset();
    setStatus('Import annulé.');
  });

  confirm.addEventListener('click', () => {
    const plan = pending;
    if (!plan) return;
    void (async () => {
      busy(true);
      setStatus('Import en cours…');
      let added = 0;
      try {
        const library = await ScoreLibrary.open();
        for (const item of plan.add) {
          await library.add(item.entry, item.bytes, item.media);
          added += 1;
        }
        writePrefs(plan.preferences);
        if (added) void requestPersistentStorage();
        setStatus(fr(`Import terminé : ${added}${NB}partition${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''}.`));
      } catch {
        setStatus(fr(`Import interrompu après ${added}${NB}partition${added > 1 ? 's' : ''} : plus de place ou stockage indisponible.`), true);
      } finally {
        reset();
        busy(false);
        document.dispatchEvent(new CustomEvent(LIBRARY_CHANGE));
      }
    })();
  });

  return h(
    'div',
    { class: 'row row--stacked', 'data-testid': 'backup' },
    h(
      'span',
      { class: 'row__text' },
      h('span', { class: 'row__label' }, 'Sauvegarde'),
      h(
        'span',
        { class: 'row__hint' },
        fr('Partitions, réglages, doigtés et enregistrements dans un fichier .zip, pour un autre appareil ou une nouvelle adresse. La clé YouTube n’en fait pas partie. L’import ne remplace rien.'),
      ),
    ),
    h('div', { class: 'field-line' }, exportBtn, importBtn, input),
    status,
    confirmLine,
  );
}
