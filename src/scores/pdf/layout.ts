/**
 * Mise en page : portées (5 lignes équidistantes, 4 à 7 pour une tablature), systèmes
 * (portées reliées par une barre ou une accolade) et barres de mesure.
 */
import type { HSeg, VSeg } from './geometry';

export interface Staff {
  page: number;
  /** Ordonnées des lignes, de haut en bas. */
  lines: number[];
  /** Interligne, en points. */
  spacing: number;
  x0: number;
  x1: number;
  kind: 'standard' | 'tab';
  /** Épaisseur des lignes. */
  lineWidth: number;
}

export interface Barline {
  x: number;
  /** Abscisse de gauche et de droite du groupe de traits (barre double, finale…). */
  left: number;
  right: number;
  style: 'regular' | 'double' | 'final' | 'heavy-light' | 'heavy';
}

export interface System {
  page: number;
  staves: Staff[];
  x0: number;
  x1: number;
  /** Barres de mesure internes et finale, triées (la barre de début de système est exclue). */
  barlines: Barline[];
  /** Abscisse de début de la zone musicale (début du système). */
  start: number;
}

export function staffTop(staff: Staff): number {
  return staff.lines[0] as number;
}

export function staffBottom(staff: Staff): number {
  return staff.lines[staff.lines.length - 1] as number;
}

/**
 * Fusionne les segments horizontaux colinéaires : les lignes sont souvent coupées à chaque
 * mesure, et celles d'une tablature s'interrompent autour des chiffres.
 */
export function mergeHorizontal(hsegs: HSeg[], holes: Array<{ x0: number; x1: number; y0: number; y1: number }> = []): HSeg[] {
  // Un trou est franchi s'il est petit, ou occupé par des glyphes posés sur la ligne (cases de tablature).
  const bridged = (x0: number, x1: number, y: number): boolean => {
    if (x1 - x0 <= 1.5) return true;
    const inside = holes
      .filter((h) => h.y0 <= y && h.y1 >= y && h.x0 < x1 && h.x1 > x0)
      .map((h) => [Math.max(h.x0, x0), Math.min(h.x1, x1)] as const)
      .sort((a, b) => a[0] - b[0]);
    if (!inside.length) return false;
    // Petit blanc toléré autour et entre les chiffres (« 6 <18> »).
    let edge = x0;
    for (const [a, b] of inside) {
      if (a - edge > 5) return false;
      edge = Math.max(edge, b);
    }
    return x1 - edge <= 5;
  };
  const sorted = [...hsegs].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const rows: HSeg[][] = [];
  for (const seg of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs((row[0] as HSeg).y - seg.y) <= 0.25) row.push(seg);
    else rows.push([seg]);
  }
  const out: HSeg[] = [];
  for (const row of rows) {
    // Par épaisseur : une ligature horizontale posée sur une ligne ne doit pas la couper.
    const families: HSeg[][] = [];
    for (const seg of row) {
      const fam = families.find((f) => Math.abs((f[0] as HSeg).thickness - seg.thickness) < 0.3);
      if (fam) fam.push(seg);
      else families.push([seg]);
    }
    for (const fam of families) {
      fam.sort((a, b) => a.x0 - b.x0);
      let cur: HSeg | null = null;
      for (const seg of fam) {
        if (cur && (seg.x0 <= cur.x1 + 1.5 || bridged(cur.x1, seg.x0, seg.y))) cur.x1 = Math.max(cur.x1, seg.x1);
        else {
          if (cur) out.push(cur);
          cur = { ...seg };
        }
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

/** Fusionne les segments verticaux colinéaires (barres coupées entre les portées). */
export function mergeVertical(vsegs: VSeg[]): VSeg[] {
  const sorted = [...vsegs].sort((a, b) => a.x - b.x || a.y0 - b.y0);
  const cols: VSeg[][] = [];
  for (const seg of sorted) {
    const col = cols[cols.length - 1];
    if (col && Math.abs((col[0] as VSeg).x - seg.x) <= 0.2) col.push(seg);
    else cols.push([seg]);
  }
  const out: VSeg[] = [];
  for (const col of cols) {
    col.sort((a, b) => a.y0 - b.y0);
    let cur: VSeg | null = null;
    for (const seg of col) {
      if (cur && seg.y0 <= cur.y1 + 0.6 && Math.abs(seg.thickness - cur.thickness) < 0.3) {
        cur.y1 = Math.max(cur.y1, seg.y1);
      } else {
        if (cur) out.push(cur);
        cur = { ...seg };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/** Repère les portées d'une page à partir de ses lignes horizontales fusionnées. */
export function findStaves(lines: HSeg[], page: number): Staff[] {
  const candidates = lines.filter((l) => l.x1 - l.x0 >= 40 && l.thickness <= 1.6).sort((a, b) => a.y - b.y);
  const used = new Set<HSeg>();
  const staves: Staff[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const first = candidates[i] as HSeg;
    if (used.has(first)) continue;
    // Lignes suivantes qui se superposent horizontalement à la première.
    const group: HSeg[] = [first];
    let gap = 0;
    for (let j = i + 1; j < candidates.length; j++) {
      const next = candidates[j] as HSeg;
      if (used.has(next)) continue;
      const last = group[group.length - 1] as HSeg;
      const shared = overlap(first.x0, first.x1, next.x0, next.x1);
      if (shared < 0.6 * Math.min(first.x1 - first.x0, next.x1 - next.x0)) continue;
      // Les lignes d'une portée ont les mêmes extrémités (contrairement aux lignes supplémentaires).
      if (Math.abs(next.x0 - first.x0) > 3 || Math.abs(next.x1 - first.x1) > 3) continue;
      const d = next.y - last.y;
      if (d < 0.5) continue;
      if (gap === 0) {
        if (d < 2.5 || d > 25) break;
        gap = d;
        group.push(next);
      } else if (Math.abs(d - gap) <= Math.max(0.12 * gap, 0.3)) {
        group.push(next);
      } else if (d > gap * 1.15) {
        break;
      }
      if (group.length === 7) break;
    }
    if (group.length < 4) continue;
    const kind: Staff['kind'] = group.length === 5 ? 'standard' : 'tab';
    for (const l of group) used.add(l);
    const ys = group.map((l) => l.y);
    staves.push({
      page,
      lines: ys,
      spacing: ((ys[ys.length - 1] as number) - (ys[0] as number)) / (ys.length - 1),
      x0: Math.min(...group.map((l) => l.x0)),
      x1: Math.max(...group.map((l) => l.x1)),
      kind,
      lineWidth: group.reduce((s, l) => s + l.thickness, 0) / group.length,
    });
  }
  return staves.sort((a, b) => staffTop(a) - staffTop(b) || a.x0 - b.x0);
}

/** Barre verticale qui couvre exactement la portée (de la première à la dernière ligne). */
function spansStaff(v: VSeg, staff: Staff): boolean {
  const tol = Math.max(0.3 * staff.spacing, 0.6);
  return v.y0 <= staffTop(staff) + tol && v.y1 >= staffBottom(staff) - tol;
}

/** Les extrémités d'une barre de mesure tombent sur une ligne de portée (début ou fin d'une portée). */
function endsOnStaffEdges(v: VSeg, staves: Staff[]): boolean {
  const near = (y: number, edges: number[]): boolean => edges.some((e) => Math.abs(e - y) <= 0.25 * (staves[0]?.spacing ?? 5) + 0.4);
  return near(v.y0, staves.map(staffTop)) && near(v.y1, staves.map(staffBottom));
}

export interface HeadMark {
  x0: number;
  x1: number;
  y: number;
}

/**
 * Regroupe les portées en systèmes et trouve leurs barres de mesure.
 * `heads` (têtes de notes) sert à écarter les hampes qui ressembleraient à des barres.
 */
export function buildSystems(staves: Staff[], vsegs: VSeg[], braces: Array<{ x: number; y0: number; y1: number }>, heads: HeadMark[]): System[] {
  const verticals = mergeVertical(vsegs);
  const systems: System[] = [];
  let current: Staff[] = [];
  const connected = (a: Staff, b: Staff): boolean => {
    if (Math.abs(a.x0 - b.x0) > 3 || Math.abs(a.x1 - b.x1) > 3) return false;
    const top = staffTop(a) + a.spacing;
    const bottom = staffBottom(b) - b.spacing;
    const bar = verticals.some((v) => v.x >= a.x0 - 6 && v.x <= a.x1 + 1 && v.y0 <= top && v.y1 >= bottom);
    const brace = braces.some((br) => br.x < a.x0 + 2 && br.x > a.x0 - 40 && br.y0 <= top && br.y1 >= bottom);
    // Trait de liaison à gauche qui ne fait que franchir l'espace entre les deux portées.
    const gap = verticals.some((v) => v.x >= a.x0 - 8 && v.x <= a.x0 + 2 && v.y0 <= staffBottom(a) + 0.6 && v.y1 >= staffTop(b) - 0.6);
    // Tablature collée à sa portée de notation (même largeur, juste dessous).
    const pair = a.kind === 'standard' && b.kind === 'tab' && staffTop(b) - staffBottom(a) < 8 * a.spacing;
    return bar || brace || gap || pair;
  };
  for (const staff of staves) {
    const prev = current[current.length - 1];
    if (prev && prev.page === staff.page && connected(prev, staff)) current.push(staff);
    else {
      if (current.length) systems.push(makeSystem(current, verticals, heads));
      current = [staff];
    }
  }
  if (current.length) systems.push(makeSystem(current, verticals, heads));
  return systems;
}

function makeSystem(staves: Staff[], verticals: VSeg[], heads: HeadMark[]): System {
  const first = staves[0] as Staff;
  const x0 = Math.min(...staves.map((s) => s.x0));
  const x1 = Math.max(...staves.map((s) => s.x1));
  const sp = first.spacing;
  // Candidats par portée : traits qui la couvrent entièrement, extrémités sur les bords de portées.
  const xs: Array<{ x: number; thickness: number; count: number }> = [];
  for (const staff of staves) {
    for (const v of verticals) {
      if (v.x < x0 - 1 || v.x > x1 + 1.5) continue;
      if (!spansStaff(v, staff) || !endsOnStaffEdges(v, staves)) continue;
      // Une hampe porte une tête de note à l'une de ses extrémités.
      const stem = heads.some(
        (h) =>
          (Math.abs(h.x0 - v.x) < 1.2 || Math.abs(h.x1 - v.x) < 1.2 || (v.x > h.x0 && v.x < h.x1)) &&
          (Math.abs(h.y - v.y0) < 0.8 * sp || Math.abs(h.y - v.y1) < 0.8 * sp),
      );
      if (stem) continue;
      const hit = xs.find((c) => Math.abs(c.x - v.x) < 0.3);
      if (hit) hit.count++;
      else xs.push({ x: v.x, thickness: v.thickness, count: 1 });
    }
  }
  const needed = Math.max(1, Math.ceil(staves.length / 2));
  const strokes = xs.filter((c) => c.count >= needed).sort((a, b) => a.x - b.x);
  // Regroupe les traits proches (barre double, finale, reprise).
  const groups: Array<typeof strokes> = [];
  for (const s of strokes) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (g && last && s.x - last.x < 1.2 * sp) g.push(s);
    else groups.push([s]);
  }
  const thin = Math.min(...strokes.map((s) => s.thickness), Infinity);
  const barlines: Barline[] = groups.map((g) => {
    const left = (g[0] as (typeof strokes)[number]).x;
    const right = (g[g.length - 1] as (typeof strokes)[number]).x;
    const heavy = g.map((s) => s.thickness > thin * 1.8);
    let style: Barline['style'] = 'regular';
    if (g.length >= 2) {
      if (heavy[heavy.length - 1] && !heavy[0]) style = 'final';
      else if (heavy[0] && !heavy[heavy.length - 1]) style = 'heavy-light';
      else style = 'double';
    } else if (heavy[0]) style = 'heavy';
    return { x: right, left, right, style };
  });
  // Barre de début de système : on la retire, elle ouvre la première mesure.
  let start = x0;
  while (barlines.length && (barlines[0] as Barline).left <= x0 + 1.5 * sp) {
    const b = barlines.shift() as Barline;
    start = b.right;
  }
  return { page: first.page, staves, x0, x1, barlines, start };
}
