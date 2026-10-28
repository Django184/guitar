/**
 * Anneaux autour des notes ajoutées par l'enrichissement (sur la tablature, au-dessus du rendu
 * d'alphaTab) : les repérer d'un coup d'œil, et les retirer d'un appui.
 */
import type { Api } from '../alphatab';
import type { NoteHeads } from '../fingering/fingeringLayer';
import type { AddKind } from './suggest';

const SVG = 'http://www.w3.org/2000/svg';

export interface Ring {
  id: string;
  kind: AddKind;
  /** Note du modèle alphaTab (aperçu). */
  note: unknown;
}

/** Repère de la tablature de chaque note (le plus bas des deux portées). */
function tabHeads(lookup: NoteHeads): Map<unknown, { x: number; y: number; w: number; h: number }> {
  const heads = new Map<unknown, { x: number; y: number; w: number; h: number }>();
  for (const system of lookup.staffSystems) {
    for (const master of system.bars) {
      for (const bar of master.bars) {
        for (const beat of bar.beats) {
          for (const nb of beat.notes ?? []) {
            const b = nb.noteHeadBounds;
            const known = heads.get(nb.note);
            if (!known || b.y > known.y) heads.set(nb.note, { x: b.x, y: b.y, w: b.w, h: b.h });
          }
        }
      }
    }
  }
  return heads;
}

export class AdditionLayer {
  private readonly svg = document.createElementNS(SVG, 'svg');

  constructor(
    private readonly host: HTMLElement,
    private readonly onToggle: (id: string) => void,
  ) {
    this.svg.setAttribute('class', 'additions');
    this.svg.setAttribute('data-testid', 'additions');
    this.svg.style.display = 'none';
    host.append(this.svg);
    for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
      this.svg.addEventListener(type, (e) => {
        if ((e.target as Element).closest('.additions__ring')) e.stopPropagation();
      });
    }
    this.svg.addEventListener('click', (e) => {
      const ring = (e.target as Element).closest<SVGGElement>('.additions__ring');
      if (!ring?.dataset.id) return;
      e.stopPropagation();
      this.onToggle(ring.dataset.id);
    });
  }

  clear(): void {
    this.svg.replaceChildren();
    this.svg.style.display = 'none';
  }

  draw(api: Api, rings: readonly Ring[]): void {
    const surface = this.host.querySelector<HTMLElement>('.at-surface');
    const lookup = api.boundsLookup;
    if (!surface || !lookup || !rings.length) {
      this.clear();
      return;
    }
    this.svg.style.display = '';
    this.svg.style.left = `${surface.offsetLeft}px`;
    this.svg.style.top = `${surface.offsetTop}px`;
    this.svg.setAttribute('width', String(surface.offsetWidth));
    this.svg.setAttribute('height', String(surface.offsetHeight));
    const heads = tabHeads(lookup as unknown as NoteHeads);
    const nodes: SVGGElement[] = [];
    for (const ring of rings) {
      const b = heads.get(ring.note);
      if (!b) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const r = Math.max(8, Math.min(12, b.h * 0.75));
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', `additions__ring additions--${ring.kind}`);
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', 'Retirer la note ajoutée');
      g.dataset.id = ring.id;
      const hit = document.createElementNS(SVG, 'circle');
      hit.setAttribute('class', 'additions__hit');
      hit.setAttribute('cx', String(cx));
      hit.setAttribute('cy', String(cy));
      hit.setAttribute('r', String(r + 4));
      const circle = document.createElementNS(SVG, 'circle');
      circle.setAttribute('class', 'additions__circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
      g.append(hit, circle);
      nodes.push(g);
    }
    this.svg.replaceChildren(...nodes);
  }
}
