/**
 * Classement des traits vectoriels d'une page : segments horizontaux (lignes de portée,
 * lignes supplémentaires), segments verticaux (hampes, barres de mesure), ligatures
 * (quadrilatères épais, éventuellement inclinés) et courbes (liaisons).
 */
import type { Box, PageData, PathItem, Point } from './types';

export interface HSeg {
  x0: number;
  x1: number;
  y: number;
  thickness: number;
}

export interface VSeg {
  x: number;
  y0: number;
  y1: number;
  thickness: number;
}

/** Ligature : bord supérieur y = top0 + (x - x0) * slope, épaisseur verticale constante. */
export interface Beam {
  x0: number;
  x1: number;
  top0: number;
  slope: number;
  thickness: number;
}

export interface Curve {
  box: Box;
  /** Extrémités gauche et droite de la courbe. */
  left: Point;
  right: Point;
}

export interface Geometry {
  hsegs: HSeg[];
  vsegs: VSeg[];
  beams: Beam[];
  curves: Curve[];
}

const EPS = 0.35;

export function beamTopAt(beam: Beam, x: number): number {
  return beam.top0 + (x - beam.x0) * beam.slope;
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) out.pop();
  return out;
}

/** Quadrilatère à deux côtés verticaux (ligature, éventuellement inclinée). */
function asBeam(pts: Point[]): Beam | null {
  if (pts.length !== 4) return null;
  const xs = [...new Set(pts.map((p) => Math.round(p.x * 20) / 20))];
  // Deux abscisses distinctes : côtés verticaux.
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const left = sorted.slice(0, 2).sort((a, b) => a.y - b.y);
  const right = sorted.slice(2).sort((a, b) => a.y - b.y);
  const [lt, lb] = left as [Point, Point];
  const [rt, rb] = right as [Point, Point];
  if (xs.length > 2 && (Math.abs(lt.x - lb.x) > EPS || Math.abs(rt.x - rb.x) > EPS)) return null;
  const width = (rt.x + rb.x) / 2 - (lt.x + lb.x) / 2;
  if (width <= 0.5) return null;
  const thickL = lb.y - lt.y;
  const thickR = rb.y - rt.y;
  if (Math.abs(thickL - thickR) > Math.max(0.3, 0.15 * Math.max(thickL, thickR))) return null;
  const x0 = (lt.x + lb.x) / 2;
  return { x0, x1: x0 + width, top0: lt.y, slope: (rt.y - lt.y) / width, thickness: (thickL + thickR) / 2 };
}

/** Rectangle aligné sur les axes (4 sommets), ou null. */
function asRect(pts: Point[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (pts.length !== 4) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const ok = pts.every((p) => (Math.abs(p.x - x0) < EPS || Math.abs(p.x - x1) < EPS) && (Math.abs(p.y - y0) < EPS || Math.abs(p.y - y1) < EPS));
  return ok ? { x0, y0, x1, y1 } : null;
}

/** Surface pleine : trait fin (ligne, hampe, barre) ou ligature. */
function addFilledShape(pts: Point[], geo: Geometry): void {
  const rect = asRect(pts);
  if (rect) {
    const sw = rect.x1 - rect.x0;
    const sh = rect.y1 - rect.y0;
    if (sh <= 2.2 && sw > sh * 3) {
      geo.hsegs.push({ x0: rect.x0, x1: rect.x1, y: (rect.y0 + rect.y1) / 2, thickness: sh });
      // Une ligature horizontale est aussi un rectangle : on la garde comme candidate.
      if (sh > 1.2) geo.beams.push({ x0: rect.x0, x1: rect.x1, top0: rect.y0, slope: 0, thickness: sh });
      return;
    }
    if (sw <= 3.2 && sh > sw * 2) {
      geo.vsegs.push({ x: (rect.x0 + rect.x1) / 2, y0: rect.y0, y1: rect.y1, thickness: sw });
      return;
    }
  }
  const beam = asBeam(pts);
  if (beam && beam.thickness > 0.8 && beam.thickness < 6 && beam.x1 - beam.x0 > beam.thickness) geo.beams.push(beam);
}

function addStrokeSegments(path: PathItem, geo: Geometry): void {
  for (const raw of path.subpaths) {
    // Rectangle tracé (contour) : une hampe ou une ligne dessinée en creux, épaisseur comprise.
    const closed = dedupe(raw);
    const rect = raw.length >= 5 ? asRect(closed) : null;
    if (rect && Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0) < 2) {
      const h = path.lineWidth / 2;
      addFilledShape(
        [
          { x: rect.x0 - h, y: rect.y0 - h },
          { x: rect.x1 + h, y: rect.y0 - h },
          { x: rect.x1 + h, y: rect.y1 + h },
          { x: rect.x0 - h, y: rect.y1 + h },
        ],
        geo,
      );
      continue;
    }
    const sub = raw;
    for (let i = 1; i < sub.length; i++) {
      const a = sub[i - 1] as Point;
      const b = sub[i] as Point;
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx < 0.01 && dy < 0.01) continue;
      if (dy <= EPS && dx > dy) {
        geo.hsegs.push({ x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y: (a.y + b.y) / 2, thickness: path.lineWidth });
      } else if (dx <= EPS && dy > dx) {
        geo.vsegs.push({ x: (a.x + b.x) / 2, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), thickness: path.lineWidth });
      } else if (path.lineWidth >= 1.2) {
        // Ligature tracée comme un trait épais.
        const [l, r] = a.x < b.x ? [a, b] : [b, a];
        geo.beams.push({
          x0: l.x,
          x1: r.x,
          top0: l.y - path.lineWidth / 2,
          slope: (r.y - l.y) / (r.x - l.x),
          thickness: path.lineWidth,
        });
      }
    }
  }
}

export function classifyPaths(page: PageData): Geometry {
  const geo: Geometry = { hsegs: [], vsegs: [], beams: [], curves: [] };
  for (const path of page.paths) {
    const { box } = path;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    // Fond de page ou cadres : ignorés.
    if (w > page.width * 0.5 && h > page.height * 0.3) continue;

    if (path.hasCurve) {
      if (w > 1 && h < w * 1.2) {
        const pts = path.subpaths.flat();
        let left = pts[0] as Point;
        let right = pts[0] as Point;
        for (const p of pts) {
          if (p.x < left.x) left = p;
          if (p.x > right.x) right = p;
        }
        geo.curves.push({ box, left, right });
      }
      continue;
    }

    if (path.kind === 'stroke') {
      addStrokeSegments(path, geo);
      continue;
    }

    // Surfaces pleines : rectangles fins (lignes, hampes, barres) ou ligatures.
    for (const sub of path.subpaths) {
      const pts = dedupe(sub);
      if (pts.length >= 3) addFilledShape(pts, geo);
    }
  }
  return dedupeGeometry(geo);
}

/** Un même trait est parfois dessiné deux fois (contour puis remplissage) : on n'en garde qu'un. */
function dedupeGeometry(geo: Geometry): Geometry {
  const vsegs: VSeg[] = [];
  for (const v of [...geo.vsegs].sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
    const twin = vsegs.find(
      (o) => Math.abs(o.x - v.x) < Math.max(0.3, (o.thickness + v.thickness) / 2) && Math.abs(o.y0 - v.y0) < 0.6 && Math.abs(o.y1 - v.y1) < 0.6,
    );
    if (twin) twin.thickness = Math.max(twin.thickness, v.thickness);
    else vsegs.push({ ...v });
  }
  const hsegs: HSeg[] = [];
  for (const h of [...geo.hsegs].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const twin = hsegs.find((o) => Math.abs(o.y - h.y) < Math.max(0.3, (o.thickness + h.thickness) / 2) && Math.abs(o.x0 - h.x0) < 0.6 && Math.abs(o.x1 - h.x1) < 0.6);
    if (twin) twin.thickness = Math.max(twin.thickness, h.thickness);
    else hsegs.push({ ...h });
  }
  const beams: Beam[] = [];
  for (const b of geo.beams) {
    if (beams.some((o) => Math.abs(o.x0 - b.x0) < 0.6 && Math.abs(o.x1 - b.x1) < 0.6 && Math.abs(o.top0 - b.top0) < 0.6)) continue;
    beams.push(b);
  }
  return { hsegs, vsegs, beams, curves: geo.curves };
}
