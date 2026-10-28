/**
 * Feuille de réglages : panneau qui monte du bas de l'écran sur téléphone, fenêtre centrée sur
 * ordinateur. Élément <dialog> natif : focus gardé à l'intérieur, Échap pour fermer, fond inerte.
 * Rangées prêtes à l'emploi : interrupteur, entrée de menu, réglage libre.
 */
import { h, s } from './dom';

/** Icônes au trait (24 × 24), dans le style de la navigation. */
export const ICONS = {
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4Z',
  rewind: 'M6 5v14M19 5l-10 7 10 7Z',
  play: 'M7 4.5v15L19.5 12Z',
  pause: 'M7.5 5v14M16.5 5v14',
  loop: 'M17 2.5 20.5 6 17 9.5M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5M7 21.5 3.5 18 7 14.5M20.5 13v1.5a3.5 3.5 0 0 1-3.5 3.5H3.5',
} as const;

export function icon(path: string, extra = ''): SVGSVGElement {
  return s('svg', { class: `icon ${extra}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: path }));
}

export class Sheet {
  readonly element: HTMLDialogElement;
  readonly body: HTMLElement;
  private readonly onClose: Array<() => void> = [];

  constructor(title: string, options: { testId?: string } = {}) {
    const close = h('button', { type: 'button', class: 'icon-btn sheet__close', 'aria-label': 'Fermer' }, icon(ICONS.close));
    close.addEventListener('click', () => this.close());
    const heading = h('h2', { class: 'sheet__title' }, title);
    this.body = h('div', { class: 'sheet__body' });
    this.element = h(
      'dialog',
      { class: 'sheet', 'aria-label': title, ...(options.testId ? { 'data-testid': options.testId } : {}) },
      h('div', { class: 'sheet__head' }, heading, close),
      this.body,
    ) as HTMLDialogElement;
    // Un appui sur le fond (hors du panneau) ferme la feuille.
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });
    this.element.addEventListener('close', () => {
      for (const fn of this.onClose) fn();
    });
    document.body.append(this.element);
  }

  get isOpen(): boolean {
    return this.element.open;
  }

  open(): void {
    if (this.element.open) return;
    if (typeof this.element.showModal === 'function') this.element.showModal();
    else this.element.setAttribute('open', '');
  }

  close(): void {
    if (!this.element.open) return;
    if (typeof this.element.close === 'function') this.element.close();
    else {
      this.element.removeAttribute('open');
      for (const fn of this.onClose) fn();
    }
  }

  closed(fn: () => void): void {
    this.onClose.push(fn);
  }
}

/** Groupe de rangées (séparé du suivant par un filet). */
export const group = (...rows: Array<HTMLElement | null>): HTMLElement => h('div', { class: 'sheet__group' }, ...rows);

/** Interrupteur : libellé, explication éventuelle, état on / off. */
export function switchRow(label: string, hint: string | null, attrs: Record<string, string> = {}): { row: HTMLButtonElement; set(on: boolean): void } {
  const row = h(
    'button',
    { type: 'button', role: 'switch', 'aria-checked': 'false', class: 'row row--switch', ...attrs },
    h('span', { class: 'row__text' }, h('span', { class: 'row__label' }, label), hint ? h('span', { class: 'row__hint' }, hint) : null),
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch__knob' })),
  );
  return {
    row,
    set: (on: boolean) => row.setAttribute('aria-checked', String(on)),
  };
}

/** Entrée de menu : ouvre un panneau ou une autre feuille. */
export function menuRow(label: string, hint: string | null, attrs: Record<string, string> = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'row row--menu', ...attrs },
    h('span', { class: 'row__text' }, h('span', { class: 'row__label' }, label), hint ? h('span', { class: 'row__hint' }, hint) : null),
    icon(ICONS.chevron, 'row__chevron'),
  );
}

/** Réglage libre : libellé à gauche, commande à droite (ou en dessous, si `stacked`). */
export function fieldRow(label: string, control: HTMLElement, options: { hint?: string; stacked?: boolean } = {}): HTMLElement {
  return h(
    'div',
    { class: `row row--field${options.stacked ? ' row--stacked' : ''}` },
    h('span', { class: 'row__text' }, h('span', { class: 'row__label' }, label), options.hint ? h('span', { class: 'row__hint' }, options.hint) : null),
    control,
  );
}

/** En-tête d'un panneau du lecteur : titre et bouton de fermeture. */
export function panelHead(title: string, onClose: () => void): HTMLElement {
  const close = h('button', { type: 'button', class: 'icon-btn icon-btn--small', 'aria-label': `Fermer le panneau ${title}` }, icon(ICONS.close));
  close.addEventListener('click', onClose);
  return h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, title), close);
}
