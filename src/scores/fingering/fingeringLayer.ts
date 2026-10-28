/**
 * Pastilles de doigtés posées sur la tablature (au-dessus du rendu d'alphaTab), comme dans les
 * méthodes : un disque coloré par doigt, à gauche du numéro de case. Toucher une pastille ouvre
 * un petit menu pour imposer un autre doigt (ou revenir au calcul automatique).
 */
import type { Api } from '../alphatab';
import type { Finger } from './fingering';
import type { TabFingering } from './fromScore';

const SVG = 'http://www.w3.org/2000/svg';
const LABEL: Record<number, string> = { 1: '1', 2: '2', 3: '3', 4: '4', 5: 'T' };
const NAME: Record<number, string> = { 1: 'index', 2: 'majeur', 3: 'annulaire', 4: 'auriculaire', 5: 'pouce' };

type Note = TabFingering['notes'] extends Map<string, infer N> ? N : never;

/** Ce qu'il faut du BoundsLookup d'alphaTab (repères en pixels, relatifs à .at-surface). */
export interface NoteHeads {
  staffSystems: Array<{
    bars: Array<{ bars: Array<{ beats: Array<{ notes: Array<{ note: unknown; noteHeadBounds: { x: number; y: number; w: number; h: number } }> | null }> }> }>;
  }>;
}

export interface Dot {
  id: string;
  finger: Finger;
  cx: number;
  cy: number;
  r: number;
}

/**
 * Position des pastilles : à gauche du numéro de case de chaque note doigtée. Chaque note a un
 * repère par portée (notation, tablature) : celui de la tablature est le plus bas.
 */
export function layoutDots(lookup: NoteHeads, result: TabFingering): Dot[] {
  const heads = new Map<unknown, { x: number; y: number; h: number }>();
  for (const system of lookup.staffSystems) {
    for (const master of system.bars) {
      for (const bar of master.bars) {
        for (const beat of bar.beats) {
          for (const nb of beat.notes ?? []) {
            const b = nb.noteHeadBounds;
            const known = heads.get(nb.note);
            if (!known || b.y > known.y) heads.set(nb.note, { x: b.x, y: b.y, h: b.h });
          }
        }
      }
    }
  }
  const dots: Dot[] = [];
  for (const [id, note] of result.notes) {
    const finger = result.fingers.get(id) ?? 0;
    const head = heads.get(note as Note);
    if (!finger || !head) continue;
    const r = Math.max(5.5, Math.min(8, head.h * 0.48));
    dots.push({ id, finger, cx: head.x - r - 0.5, cy: head.y + head.h / 2, r });
  }
  return dots;
}

export interface FingeringLayerHost {
  /** Doigt choisi par l'utilisateur pour une note ; null : retour au calcul automatique. */
  onChoose(id: string, finger: Finger | null): void;
}

export class FingeringLayer {
  private readonly svg = document.createElementNS(SVG, 'svg');
  private readonly menu: HTMLElement;
  private readonly menuButtons = new Map<string, HTMLButtonElement>();
  private menuFor: string | null = null;
  private overrides: ReadonlySet<string> = new Set();

  constructor(
    private readonly host: HTMLElement,
    private readonly owner: FingeringLayerHost,
  ) {
    this.svg.setAttribute('class', 'fingering');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('data-testid', 'fingering');
    host.append(this.svg);

    this.menu = document.createElement('div');
    this.menu.className = 'fingering-menu';
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'dialog');
    this.menu.setAttribute('aria-label', 'Doigt de la note');
    for (const [value, text] of [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', 'T'], ['auto', 'Auto']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = value === 'auto' ? 'fingering-menu__auto' : `fingering-menu__finger fingering--${value}`;
      button.textContent = text;
      button.setAttribute('aria-label', value === 'auto' ? 'Doigt calculé automatiquement' : `Doigt ${text} (${NAME[Number(value)]})`);
      button.addEventListener('click', () => this.choose(value === 'auto' ? null : (Number(value) as Finger)));
      this.menu.append(button);
      this.menuButtons.set(value, button);
    }
    document.body.append(this.menu);

    // Les pastilles prennent leurs appuis : la sélection de passage (sur la partition) ne les voit pas.
    for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
      this.svg.addEventListener(type, (e) => {
        if ((e.target as Element).closest('.fingering__dot')) e.stopPropagation();
      });
    }
    this.svg.addEventListener('click', (e) => {
      const dot = (e.target as Element).closest<SVGGElement>('.fingering__dot');
      if (!dot) return;
      e.stopPropagation();
      this.open(dot);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node) && !(e.target as Element).closest?.('.fingering__dot')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  /** Efface les pastilles. */
  clear(): void {
    this.svg.replaceChildren();
    this.svg.style.display = 'none';
    this.close();
  }

  /** Pastilles pour le rendu actuel d'alphaTab ; `overrides` : notes au doigt imposé (soulignées). */
  draw(api: Api, result: TabFingering, overrides: ReadonlySet<string>): void {
    this.overrides = overrides;
    const surface = this.host.querySelector<HTMLElement>('.at-surface');
    const lookup = api.boundsLookup;
    if (!surface || !lookup) {
      this.clear();
      return;
    }
    // Repères d'alphaTab : relatifs à .at-surface ; la couche la recouvre exactement.
    this.svg.style.display = '';
    this.svg.style.left = `${surface.offsetLeft}px`;
    this.svg.style.top = `${surface.offsetTop}px`;
    this.svg.setAttribute('width', String(surface.offsetWidth));
    this.svg.setAttribute('height', String(surface.offsetHeight));

    const nodes: SVGGElement[] = [];
    for (const { id, finger, cx, cy, r } of layoutDots(lookup as unknown as NoteHeads, result)) {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', `fingering__dot fingering--${finger}${overrides.has(id) ? ' is-forced' : ''}`);
      g.dataset.id = id;
      g.dataset.finger = String(finger);
      const hit = document.createElementNS(SVG, 'circle');
      hit.setAttribute('class', 'fingering__hit');
      hit.setAttribute('cx', String(cx));
      hit.setAttribute('cy', String(cy));
      hit.setAttribute('r', String(r + 4));
      const disc = document.createElementNS(SVG, 'circle');
      disc.setAttribute('class', 'fingering__disc');
      disc.setAttribute('cx', String(cx));
      disc.setAttribute('cy', String(cy));
      disc.setAttribute('r', String(r));
      const text = document.createElementNS(SVG, 'text');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(cy));
      text.setAttribute('font-size', String(r * 1.35));
      text.textContent = LABEL[finger] ?? '';
      g.append(hit, disc, text);
      nodes.push(g);
    }
    this.svg.replaceChildren(...nodes);
  }

  private open(dot: SVGGElement): void {
    const id = dot.dataset.id;
    if (!id) return;
    this.menuFor = id;
    const current = dot.dataset.finger ?? '';
    for (const [value, button] of this.menuButtons) {
      const selected = value === 'auto' ? !this.overrides.has(id) : this.overrides.has(id) && value === current;
      button.setAttribute('aria-pressed', String(selected));
    }
    this.menu.hidden = false;
    const rect = dot.getBoundingClientRect();
    const width = this.menu.offsetWidth;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + 8 + this.menu.offsetHeight < window.innerHeight;
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${below ? rect.bottom + 6 : rect.top - this.menu.offsetHeight - 6}px`;
    (this.menuButtons.get(this.overrides.has(id) ? current : 'auto') as HTMLButtonElement).focus({ preventScroll: true });
  }

  close(): void {
    this.menu.hidden = true;
    this.menuFor = null;
  }

  private choose(finger: Finger | null): void {
    const id = this.menuFor;
    this.close();
    if (id) this.owner.onChoose(id, finger);
  }
}
