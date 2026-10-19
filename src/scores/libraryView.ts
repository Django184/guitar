import { h, s } from '../ui/dom';
import { FORMAT_LABELS, ACCEPTED_EXTENSIONS } from './formats';
import type { ScoreEntry } from './library';

interface LibraryDeps {
  onImport: (file: File) => void;
  onDelete: (entry: ScoreEntry) => void;
  onRename: (entry: ScoreEntry, title: string) => void;
}

function icon(path: string): SVGSVGElement {
  return s('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: path }));
}

const PENCIL = 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4';
const TRASH = 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v6M14 11v6';

/** Liste des partitions importées, avec import, renommage et suppression. */
export class LibraryView {
  readonly element: HTMLElement;
  private readonly list = h('ul', { class: 'library', 'data-testid': 'library' });
  private readonly empty = h(
    'div',
    { class: 'library__empty' },
    h('p', { class: 'scores__lead' }, "Aucune partition pour l'instant."),
    h(
      'p',
      { class: 'muted' },
      "Importez un fichier Guitar Pro, MusicXML ou MIDI : il s'affichera avec sa tablature et restera disponible ici, même hors-ligne.",
    ),
  );
  private readonly messages = h('div', { class: 'scores__result', 'aria-live': 'polite', 'data-testid': 'score-result' });
  private readonly input = h('input', { type: 'file', accept: ACCEPTED_EXTENSIONS, hidden: true });
  private readonly importButton = h('button', { type: 'button', class: 'btn btn--primary' }, 'Importer un fichier');

  constructor(private readonly deps: LibraryDeps) {
    this.importButton.addEventListener('click', () => this.input.click());
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      this.input.value = ''; // permet de réimporter le même fichier
      if (file) deps.onImport(file);
    });
    this.element = h(
      'div',
      { class: 'library-view' },
      this.messages,
      this.empty,
      this.list,
      h('div', { class: 'actions' }, this.input, this.importButton),
    );
  }

  setBusy(busy: boolean): void {
    this.importButton.disabled = busy;
    this.importButton.textContent = busy ? 'Lecture du fichier…' : 'Importer un fichier';
  }

  showMessage(node: HTMLElement | null): void {
    this.messages.replaceChildren(...(node ? [node] : []));
  }

  render(entries: ScoreEntry[]): void {
    this.empty.hidden = entries.length > 0;
    this.list.hidden = entries.length === 0;
    this.list.replaceChildren(...entries.map((entry) => this.item(entry)));
  }

  private item(entry: ScoreEntry): HTMLLIElement {
    const meta = [entry.artist, FORMAT_LABELS[entry.format]].filter(Boolean).join(', ');
    const title = h('span', { class: 'library__title' }, entry.title);
    const open = h(
      'a',
      { class: 'library__open', href: `#/partitions/${encodeURIComponent(entry.id)}` },
      title,
      h('span', { class: 'library__meta' }, meta),
    );
    const rename = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Renommer « ${entry.title} »` }, icon(PENCIL));
    const remove = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Supprimer « ${entry.title} »` }, icon(TRASH));
    const item = h('li', { class: 'library__item' }, open, rename, remove);

    remove.addEventListener('click', () => this.deps.onDelete(entry));
    rename.addEventListener('click', () => {
      const field = h('input', { type: 'text', class: 'library__rename', value: entry.title, 'aria-label': 'Nouveau titre', maxlength: 120 });
      let finished = false;
      const finish = (save: boolean): void => {
        if (finished) return;
        finished = true;
        const value = field.value.trim();
        if (save && value && value !== entry.title) this.deps.onRename(entry, value);
        else field.replaceWith(open);
      };
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      field.addEventListener('blur', () => finish(true));
      open.replaceWith(field);
      field.focus();
      field.select();
    });
    return item;
  }
}
