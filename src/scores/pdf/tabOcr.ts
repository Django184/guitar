/**
 * Lecture d'une tablature texte dessinée en image (capture d'écran, export « image ») :
 * reconnaissance de caractères spécialisée, sans dépendance.
 *
 * Une tablature texte est une grille à chasse fixe : les tirets « - » donnent la ligne de chaque
 * corde et le pas des colonnes ; chaque case contient alors un tiret, une barre « | », un chiffre
 * (case) ou une lettre (nom de corde), reconnu par comparaison à des gabarits.
 */
import type { TextRow } from './asciiTab';
import { GLYPH_TEMPLATES } from './glyphTemplates';
import type { Box } from './types';

export interface GrayImage {
  width: number;
  height: number;
  /** Luminance 0 (noir) à 255 (blanc), ligne par ligne. */
  data: Uint8Array;
}

/** Image décodée par pdf.js (page.objs) : pixels bruts, ou ImageBitmap selon les options. */
export interface PdfImageObject {
  width: number;
  height: number;
  /** 1 : gris 1 bit par pixel (1 = blanc), 2 : RVB, 3 : RVBA. */
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: ImageBitmap;
}

/** Au-delà (20 Mpx, une page A4 numérisée à plus de 400 ppp), l'image n'est pas lue : trop lourd pour un téléphone. */
const MAX_PIXELS = 20e6;

/** Luminance d'une image pdf.js ; null si le format n'est pas lisible. */
export function toGray(obj: PdfImageObject): GrayImage | null {
  const { width, height } = obj;
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) return null;
  let rgba: Uint8Array | Uint8ClampedArray | null = null;
  let channels = 0;
  if (obj.data && obj.kind === 1) {
    const gray = new Uint8Array(width * height);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) gray[y * width + x] = ((obj.data[y * rowBytes + (x >> 3)] as number) >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    return { width, height, data: gray };
  }
  if (obj.data && (obj.kind === 2 || obj.kind === 3)) {
    rgba = obj.data;
    channels = obj.kind === 2 ? 3 : 4;
  } else if (obj.bitmap && typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(obj.bitmap, 0, 0);
    rgba = ctx.getImageData(0, 0, width, height).data;
    channels = 4;
  }
  if (!rgba || rgba.length < width * height * channels) return null;
  const gray = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < gray.length; p++, i += channels) {
    const lum = 0.299 * (rgba[i] as number) + 0.587 * (rgba[i + 1] as number) + 0.114 * (rgba[i + 2] as number);
    // Transparence : composée sur fond blanc.
    const alpha = channels === 4 ? (rgba[i + 3] as number) / 255 : 1;
    gray[p] = Math.round(lum * alpha + 255 * (1 - alpha));
  }
  return { width, height, data: gray };
}

interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Nombre de pixels d'encre. */
  area: number;
  id: number;
}

const GW = 8;
const GH = 12;

interface Template {
  ch: string;
  aspect: number;
  grid: Float32Array;
}

let templates: Template[] | null = null;

function loadTemplates(): Template[] {
  if (templates) return templates;
  templates = GLYPH_TEMPLATES.split(';').map((entry) => {
    const ch = entry[0] as string;
    const aspect = Number(entry.slice(1, 4)) / 100;
    const grid = new Float32Array(GW * GH);
    for (let i = 0; i < GW * GH; i++) grid[i] = parseInt(entry[4 + i] ?? '0', 16) / 15;
    return { ch, aspect, grid };
  });
  return templates;
}

/** Seuil d'Otsu, borné : le texte est sombre, les surlignages clairs restent du fond. */
function threshold(img: GrayImage): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i] as number]++;
  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * (hist[i] as number);
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let level = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t] as number;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * (hist[t] as number);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      level = t;
    }
  }
  return Math.min(170, Math.max(90, level));
}

/** Composantes connexes (8-connexité) de l'encre, avec leur étiquette par pixel. */
function components(ink: Uint8Array, width: number, height: number): { comps: Component[]; labels: Int32Array } {
  const labels = new Int32Array(width * height).fill(-1);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || labels[start] !== -1) continue;
    const id = comps.length;
    const c: Component = { x0: width, y0: height, x1: -1, y1: -1, area: 0, id };
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % width;
      const y = (p - x) / width;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (ink[q] && labels[q] === -1) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
    }
    comps.push(c);
  }
  return { comps, labels };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/** Encre d'une boîte réduite à une grille 8×12 (moyenne par zone). */
function gridOf(img: GrayImage, cutoff: number, x0: number, y0: number, x1: number, y1: number, keep: (x: number, y: number) => boolean): Float32Array {
  const grid = new Float32Array(GW * GH);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      // Zone source (sous-pixels : 2×2 échantillons par cellule).
      let total = 0;
      let n = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const fx = x0 + ((gx + (sx + 0.5) / 2) / GW) * w - 0.5;
          const fy = y0 + ((gy + (sy + 0.5) / 2) / GH) * h - 0.5;
          const px = Math.min(x1, Math.max(x0, Math.round(fx)));
          const py = Math.min(y1, Math.max(y0, Math.round(fy)));
          const lum = img.data[py * img.width + px] as number;
          total += keep(px, py) ? Math.max(0, Math.min(1, (255 - lum) / (255 - cutoff * 0.6))) : 0;
          n++;
        }
      }
      grid[gy * GW + gx] = total / n;
    }
  }
  return grid;
}

/** Caractère le plus proche parmi `allowed`. */
function classify(grid: Float32Array, aspect: number, allowed: string): string {
  let best = '?';
  let bestD = Infinity;
  for (const t of loadTemplates()) {
    if (!allowed.includes(t.ch)) continue;
    let d = 0;
    for (let i = 0; i < grid.length; i++) {
      const e = (grid[i] as number) - (t.grid[i] as number);
      d += e * e;
    }
    d += 6 * (Math.log(aspect / t.aspect) ** 2);
    if (d < bestD) {
      bestD = d;
      best = t.ch;
    }
  }
  return best;
}

interface GridRow {
  y: number;
  dashes: Component[];
  /** Centre de la case 0 et pas horizontal. */
  origin: number;
  pitch: number;
}

/** Pas des colonnes : droite x = origine + k × pas ajustée aux centres des tirets d'une ligne. */
function fitPitch(dashes: Component[], pitch: number): number {
  const centers = dashes.map((d) => (d.x0 + d.x1) / 2).sort((a, b) => a - b);
  const first = centers[0] as number;
  const ks = centers.map((c) => Math.round((c - first) / pitch));
  const n = ks.length;
  const mk = ks.reduce((s, k) => s + k, 0) / n;
  const mc = centers.reduce((s, c) => s + c, 0) / n;
  let num = 0;
  let den = 0;
  ks.forEach((k, i) => {
    num += (k - mk) * ((centers[i] as number) - mc);
    den += (k - mk) ** 2;
  });
  return den > 0 ? num / den : pitch;
}

/** Centre de la case 0 (entre ½ et 1½ pas du bord gauche) pour un pas donné. */
function fitOrigin(dashes: Component[], pitch: number): number {
  const phases = dashes.map((d) => {
    const c = (d.x0 + d.x1) / 2;
    return c - Math.floor(c / pitch) * pitch;
  });
  // Moyenne circulaire des phases (les tirets d'une même ligne sont alignés sur la grille).
  let sx = 0;
  let sy = 0;
  for (const ph of phases) {
    sx += Math.cos((2 * Math.PI * ph) / pitch);
    sy += Math.sin((2 * Math.PI * ph) / pitch);
  }
  let phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * pitch;
  if (phase < 0) phase += pitch;
  return phase < 0.5 * pitch ? phase + pitch : phase;
}

/**
 * Lignes de tablature reconnues dans une image (vide si l'image n'en contient pas).
 * `box` : emplacement de l'image sur la page, pour situer les lignes parmi le texte.
 */
export function ocrTabRows(img: GrayImage, page: number, box?: Box): TextRow[] {
  // Pixels → points de la page (l'image est posée droite ; sans emplacement : pixels).
  const top = box ? box.y0 : 0;
  const scale = box ? (box.y1 - box.y0) / img.height : 1;
  const cutoff = threshold(img);
  const ink = new Uint8Array(img.width * img.height);
  for (let i = 0; i < ink.length; i++) ink[i] = (img.data[i] as number) < cutoff ? 1 : 0;
  const { comps, labels } = components(ink, img.width, img.height);

  // Tirets : traits courts, plats, nombreux et de même taille.
  const flat = comps.filter((c) => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    return w >= 3 && w <= 60 && h <= Math.max(3, w / 2.5);
  });
  if (flat.length < 20) return [];
  const dashW = median(flat.map((c) => c.x1 - c.x0 + 1));
  const dashes = flat.filter((c) => Math.abs(c.x1 - c.x0 + 1 - dashW) <= Math.max(2, dashW * 0.35));

  // Lignes de tirets (une par corde).
  const byY = [...dashes].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const groups: Array<{ dashes: Component[]; sumY: number }> = [];
  for (const d of byY) {
    const cy = (d.y0 + d.y1) / 2;
    const g = groups[groups.length - 1];
    if (g && Math.abs(cy - g.sumY / g.dashes.length) <= 2) {
      g.dashes.push(d);
      g.sumY += cy;
    } else groups.push({ dashes: [d], sumY: cy });
  }
  const lines = groups.map((g) => g.dashes).filter((g) => g.length >= 8);
  if (lines.length < 4) return [];

  // Pas des colonnes : écart le plus courant entre deux tirets voisins.
  const steps: number[] = [];
  for (const g of lines) {
    const xs = g.map((d) => (d.x0 + d.x1) / 2).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) steps.push((xs[i] as number) - (xs[i - 1] as number));
  }
  const pitch0 = median(steps.filter((s) => s > dashW * 0.8 && s < dashW * 3));
  if (!pitch0) return [];
  // Toute l'image partage une grille (même police, même marge) : un pas et une origine.
  const pitch = median(lines.map((g) => fitPitch(g, pitch0)));
  const origin = fitOrigin(lines.flat(), pitch);
  const rows: GridRow[] = lines.map((g) => ({ y: median(g.map((d) => (d.y0 + d.y1) / 2)), dashes: g, origin, pitch }));
  rows.sort((a, b) => a.y - b.y);
  const gaps = rows.slice(1).map((r, i) => r.y - (rows[i] as GridRow).y);
  const lineH = median(gaps.filter((g) => g < 1.8 * Math.min(...gaps)));

  // Éléments de chaque ligne (tirets, barres, caractères), puis colonnes par pas successifs :
  // l'espacement des caractères n'est pas parfaitement régulier en image (arrondis au pixel),
  // une grille unique dériverait ; chaque écart entre voisins, lui, s'arrondit sans erreur.
  const out: TextRow[] = [];
  const isDash = new Set(dashes.map((d) => d.id));
  for (const row of rows) {
    const bandTop = row.y - 0.62 * lineH;
    const bandBottom = row.y + 0.42 * lineH;
    const items: Array<{ cx: number; ch: string; comps?: Component[] }> = [];
    const glyphs: Component[] = [];
    for (const c of comps) {
      const h = c.y1 - c.y0 + 1;
      const w = c.x1 - c.x0 + 1;
      const cx = (c.x0 + c.x1) / 2;
      // Barre verticale (souvent d'un seul trait sur toutes les cordes) : présente si elle couvre la bande.
      if (h >= 0.8 * lineH && w <= 0.4 * row.pitch) {
        const cover = Math.min(c.y1, row.y + 0.3 * lineH) - Math.max(c.y0, row.y - 0.3 * lineH);
        if (cover >= 0.5 * lineH) items.push({ cx, ch: '|' });
        continue;
      }
      const cy = (c.y0 + c.y1) / 2;
      if (cy < bandTop || cy > bandBottom) continue;
      if (isDash.has(c.id) || (h <= Math.max(3, w / 2.5) && Math.abs(cy - row.y) < 0.2 * lineH)) {
        // Tiret, ou plusieurs tirets soudés en un trait.
        const n = Math.max(1, Math.round(w / row.pitch));
        for (let i = 0; i < n; i++) items.push({ cx: c.x0 + (i + 0.5) * (w / n), ch: '-' });
        continue;
      }
      if (h < 0.25 * lineH && w < 0.25 * row.pitch) continue; // poussière
      if (h > 1.4 * lineH || w > 2.5 * row.pitch) continue; // surlignage, cadre…
      glyphs.push(c);
    }
    // Un caractère = composantes qui se chevauchent horizontalement (« i », « % »…).
    glyphs.sort((a, b) => a.x0 - b.x0);
    let cluster: Component[] = [];
    const flush = (): void => {
      if (!cluster.length) return;
      const x0 = Math.min(...cluster.map((c) => c.x0));
      const x1 = Math.max(...cluster.map((c) => c.x1));
      items.push({ cx: (x0 + x1) / 2, ch: '?', comps: cluster });
      cluster = [];
    };
    for (const c of glyphs) {
      const last = cluster[cluster.length - 1];
      if (last && c.x0 > Math.max(...cluster.map((o) => o.x1))) flush();
      cluster.push(c);
    }
    flush();
    if (!items.length) continue;
    items.sort((a, b) => a.cx - b.cx);
    // Colonnes : première par la grille, les suivantes par l'écart au voisin.
    const placed: Array<{ k: number; item: (typeof items)[number] }> = [];
    for (const item of items) {
      const prev = placed[placed.length - 1];
      if (prev && item.cx - prev.item.cx < 0.35 * row.pitch) {
        // Deux éléments dans la même case : la barre et le caractère l'emportent sur le tiret.
        if (prev.item.ch === '-') prev.item = item;
        continue;
      }
      const k = prev ? prev.k + Math.max(1, Math.round((item.cx - prev.item.cx) / row.pitch)) : Math.round((item.cx - row.origin) / row.pitch);
      placed.push({ k, item });
    }
    // Avant la première barre ou le premier tiret : noms de cordes (lettres) ; après : cases (chiffres).
    const firstLine = placed.find((p) => p.item.ch === '|' || p.item.ch === '-')?.k ?? Infinity;
    const cells = new Map<number, string>();
    for (const { k, item } of placed) {
      if (!item.comps) {
        cells.set(k, item.ch);
        continue;
      }
      const list = item.comps;
      const x0 = Math.min(...list.map((c) => c.x0));
      const x1 = Math.max(...list.map((c) => c.x1));
      const y0 = Math.min(...list.map((c) => c.y0));
      const y1 = Math.max(...list.map((c) => c.y1));
      const ids = new Set(list.map((c) => c.id));
      const grid = gridOf(img, cutoff, x0, y0, x1, y1, (x, y) => ids.has(labels[y * img.width + x] as number));
      cells.set(k, classify(grid, (x1 - x0 + 1) / (y1 - y0 + 1), k < firstLine ? 'ABCDEFGabdeg' : '0123456789hprsx/\\~()'));
    }
    const maxK = Math.max(...cells.keys());
    let text = '';
    for (let k = 0; k <= maxK; k++) text += cells.get(k) ?? ' ';
    out.push({ text, page, y: top + row.y * scale, size: lineH * scale });
  }
  return out;
}
