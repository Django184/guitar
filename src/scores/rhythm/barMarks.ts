/**
 * Mesures surlignées sur la partition (au-dessus du rendu d'alphaTab) : celles dont le rythme
 * est à vérifier. Le surlignage laisse passer les appuis (sélection d'un passage).
 */
import type { Api } from '../alphatab';

const SVG = 'http://www.w3.org/2000/svg';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ce qu'il faut du BoundsLookup d'alphaTab. */
export interface BarBoxes {
  staffSystems: Array<{ bars: Array<{ index: number; lineAlignedBounds?: Box; visualBounds: Box }> }>;
}

/** Rectangles des mesures `bars` (index), en pixels relatifs à .at-surface. */
export function barRects(lookup: BarBoxes, bars: ReadonlySet<number>): Array<Box & { index: number }> {
  const out: Array<Box & { index: number }> = [];
  for (const system of lookup.staffSystems) {
    for (const bar of system.bars) {
      if (!bars.has(bar.index)) continue;
      const b = bar.lineAlignedBounds ?? bar.visualBounds;
      out.push({ index: bar.index, x: b.x, y: b.y, w: b.w, h: b.h });
    }
  }
  return out;
}

export class BarMarks {
  private readonly svg = document.createElementNS(SVG, 'svg');

  constructor(private readonly host: HTMLElement) {
    this.svg.setAttribute('class', 'bar-marks');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('data-testid', 'bar-marks');
    this.svg.style.display = 'none';
    host.append(this.svg);
  }

  clear(): void {
    this.svg.replaceChildren();
    this.svg.style.display = 'none';
  }

  draw(api: Api, bars: readonly number[]): void {
    const surface = this.host.querySelector<HTMLElement>('.at-surface');
    const lookup = api.boundsLookup;
    if (!surface || !lookup || !bars.length) {
      this.clear();
      return;
    }
    this.svg.style.display = '';
    this.svg.style.left = `${surface.offsetLeft}px`;
    this.svg.style.top = `${surface.offsetTop}px`;
    this.svg.setAttribute('width', String(surface.offsetWidth));
    this.svg.setAttribute('height', String(surface.offsetHeight));
    const rects = barRects(lookup as unknown as BarBoxes, new Set(bars)).map(({ index, x, y, w, h }) => {
      const r = document.createElementNS(SVG, 'rect');
      r.setAttribute('class', 'bar-marks__bar');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(w));
      r.setAttribute('height', String(h));
      r.setAttribute('rx', '6');
      r.dataset.bar = String(index);
      return r;
    });
    this.svg.replaceChildren(...rects);
  }
}
