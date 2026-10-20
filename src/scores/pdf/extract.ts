/**
 * Extraction des primitives d'un PDF avec pdf.js : glyphes (avec leur position exacte),
 * traits et surfaces vectoriels, et surface des images.
 *
 * On interprète la liste d'opérateurs de chaque page (matrices, état du texte, chemins)
 * au lieu de getTextContent : il faut la position de CHAQUE glyphe (une armure de trois
 * dièses est souvent écrite d'un seul bloc) et tous les traits (portées, hampes, ligatures).
 */
import type * as PdfJs from 'pdfjs-dist';
import type { Box, Glyph, PageData, PathItem, Point } from './types';

type Matrix = [number, number, number, number, number, number];
type PdfModule = typeof PdfJs;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 au sens PDF (applique m1 puis m2). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** « ABCDEF+Leland-Regular » → « Leland-Regular ». */
export function cleanFontName(name: string | undefined): string {
  return (name ?? '').replace(/^[A-Z]{6}\+/, '');
}

interface FontInfo {
  name: string;
  fontMatrix: Matrix;
  vertical: boolean;
  /** Noms de glyphes par code de caractère (/Differences de l'encodage), s'il y en a. */
  glyphNames: string[] | null;
}

interface TextState {
  font: FontInfo | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  rise: number;
  leading: number;
  textMatrix: Matrix;
  lineMatrix: Matrix;
}

interface GraphicsState {
  ctm: Matrix;
  lineWidth: number;
  text: TextState;
}

interface PdfGlyph {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
  originalCharCode?: number;
}

function boxOf(points: Point[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** Lit toutes les pages d'un document pdf.js déjà ouvert. */
export async function extractPages(
  pdfjs: PdfModule,
  doc: PdfJs.PDFDocumentProxy,
  onPage?: (done: number, total: number) => void,
): Promise<PageData[]> {
  const pages: PageData[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push(await extractPage(pdfjs, page, n - 1));
    page.cleanup();
    onPage?.(n, doc.numPages);
  }
  return pages;
}

export async function extractPage(pdfjs: PdfModule, page: PdfJs.PDFPageProxy, index: number): Promise<PageData> {
  const OPS = pdfjs.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as Matrix;
  const ops = await page.getOperatorList();

  const glyphs: Glyph[] = [];
  const paths: PathItem[] = [];
  let imageArea = 0;
  const fonts = new Map<string, FontInfo>();

  const fontInfo = (id: string): FontInfo => {
    let info = fonts.get(id);
    if (!info) {
      let name = '';
      let fontMatrix: Matrix = [0.001, 0, 0, 0.001, 0, 0];
      let vertical = false;
      let glyphNames: string[] | null = null;
      try {
        const f = page.commonObjs.get(id) as { name?: string; fontMatrix?: number[]; vertical?: boolean; differences?: unknown };
        name = cleanFontName(f?.name);
        if (f?.fontMatrix?.length === 6) fontMatrix = f.fontMatrix as Matrix;
        vertical = !!f?.vertical;
        if (Array.isArray(f?.differences) && f.differences.length > 0) glyphNames = f.differences as string[];
      } catch {
        // Police non résolue : on garde des valeurs par défaut.
      }
      info = { name, fontMatrix, vertical, glyphNames };
      fonts.set(id, info);
    }
    return info;
  };

  const newText = (): TextState => ({
    font: null,
    size: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    rise: 0,
    leading: 0,
    textMatrix: [...IDENTITY],
    lineMatrix: [...IDENTITY],
  });

  let state: GraphicsState = { ctm: [...IDENTITY], lineWidth: 1, text: newText() };
  const stack: GraphicsState[] = [];
  const clone = (s: GraphicsState): GraphicsState => ({ ctm: [...s.ctm], lineWidth: s.lineWidth, text: { ...s.text } });

  const toPage = (m: Matrix): Matrix => multiply(m, base);

  const moveText = (tx: number, ty: number): void => {
    const t = state.text;
    t.lineMatrix = multiply([1, 0, 0, 1, tx, ty], t.lineMatrix);
    t.textMatrix = [...t.lineMatrix];
  };

  const showGlyphs = (items: Array<PdfGlyph | number | null>): void => {
    const t = state.text;
    const font = t.font;
    if (!font) return;
    const fm = font.fontMatrix;
    const scaleX = fm[0] || 0.001;
    for (const item of items) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'number') {
        // Ajustement de TJ, en millièmes de corps (positif = vers la gauche).
        const tx = (-item / 1000) * t.size * t.hScale;
        t.textMatrix = multiply([1, 0, 0, 1, tx, 0], t.textMatrix);
        continue;
      }
      const advance = (item.width ?? 0) * scaleX * t.size;
      const unicode = item.unicode ?? '';
      const name = item.originalCharCode !== undefined ? font.glyphNames?.[item.originalCharCode] : undefined;
      if ((unicode && unicode.trim() !== '') || name) {
        const trm = multiply(multiply([t.size * t.hScale, 0, 0, t.size, 0, t.rise], t.textMatrix), state.ctm);
        const pageM = toPage(trm);
        const origin = apply(pageM, 0, 0);
        // Taille réelle à l'écran : longueur du vecteur vertical unité.
        const size = Math.hypot(pageM[2], pageM[3]);
        const end = apply(toPage(multiply(multiply([1, 0, 0, 1, advance * t.hScale, 0], t.textMatrix), state.ctm)), 0, 0);
        glyphs.push({
          text: unicode,
          cp: unicode.codePointAt(0) ?? 0,
          ...(name ? { name } : {}),
          font: font.name,
          x: origin.x,
          y: origin.y,
          size,
          width: Math.hypot(end.x - origin.x, end.y - origin.y),
        });
      }
      const tx = (advance + t.charSpacing + (item.isSpace ? t.wordSpacing : 0)) * t.hScale;
      t.textMatrix = multiply([1, 0, 0, 1, tx, 0], t.textMatrix);
    }
  };

  const addPath = (drawOp: number, data: ArrayLike<number> | undefined): void => {
    if (!data) return;
    let kind: 'stroke' | 'fill' | null = null;
    switch (drawOp) {
      case OPS.stroke:
      case OPS.closeStroke:
        kind = 'stroke';
        break;
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        kind = 'fill';
        break;
      default:
        return; // endPath : tracé de découpe, invisible
    }
    const m = toPage(state.ctm);
    const subpaths: Point[][] = [];
    let current: Point[] = [];
    let hasCurve = false;
    let i = 0;
    while (i < data.length) {
      const op = data[i++] as number;
      switch (op) {
        case 0: // moveTo
          if (current.length) subpaths.push(current);
          current = [apply(m, data[i] as number, data[i + 1] as number)];
          i += 2;
          break;
        case 1: // lineTo
          current.push(apply(m, data[i] as number, data[i + 1] as number));
          i += 2;
          break;
        case 2: // curveTo
          hasCurve = true;
          current.push(
            apply(m, data[i] as number, data[i + 1] as number),
            apply(m, data[i + 2] as number, data[i + 3] as number),
            apply(m, data[i + 4] as number, data[i + 5] as number),
          );
          i += 6;
          break;
        case 3: // quadraticCurveTo
          hasCurve = true;
          current.push(apply(m, data[i] as number, data[i + 1] as number), apply(m, data[i + 2] as number, data[i + 3] as number));
          i += 4;
          break;
        case 4: // closePath
          if (current.length) current.push({ ...(current[0] as Point) });
          break;
        default:
          i = data.length; // format inconnu : on abandonne ce chemin
      }
    }
    if (current.length) subpaths.push(current);
    const all = subpaths.flat();
    if (all.length === 0) return;
    // Épaisseur du trait à l'échelle de la page.
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    paths.push({ kind, lineWidth: Math.max(state.lineWidth * scale, 0.01), subpaths, hasCurve, box: boxOf(all) });
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(clone(state));
        break;
      case OPS.restore:
        state = stack.pop() ?? state;
        break;
      case OPS.transform:
        state.ctm = multiply(Array.from(args as ArrayLike<number>) as Matrix, state.ctm);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(clone(state));
        const matrix = args[0] as number[] | null;
        if (matrix && matrix.length === 6) state.ctm = multiply(matrix as Matrix, state.ctm);
        break;
      }
      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case OPS.setLineWidth:
        state.lineWidth = args[0] as number;
        break;
      case OPS.constructPath: {
        const drawOp = args[0] as number;
        const data = (args[1] as ArrayLike<number>[] | null)?.[0];
        addPath(drawOp, data);
        break;
      }
      case OPS.beginText:
        state.text.textMatrix = [...IDENTITY];
        state.text.lineMatrix = [...IDENTITY];
        break;
      case OPS.setFont:
        state.text.font = fontInfo(args[0] as string);
        state.text.size = args[1] as number;
        break;
      case OPS.setTextMatrix: {
        const first = args[0];
        const m = Array.from((Array.isArray(first) || ArrayBuffer.isView(first) ? first : args) as ArrayLike<number>) as Matrix;
        state.text.textMatrix = [...m];
        state.text.lineMatrix = [...m];
        break;
      }
      case OPS.moveText:
        moveText(args[0] as number, args[1] as number);
        break;
      case OPS.setLeadingMoveText:
        state.text.leading = -(args[1] as number);
        moveText(args[0] as number, args[1] as number);
        break;
      case OPS.nextLine:
        moveText(0, -state.text.leading);
        break;
      case OPS.setLeading:
        state.text.leading = args[0] as number;
        break;
      case OPS.setCharSpacing:
        state.text.charSpacing = args[0] as number;
        break;
      case OPS.setWordSpacing:
        state.text.wordSpacing = args[0] as number;
        break;
      case OPS.setHScale:
        state.text.hScale = (args[0] as number) / 100;
        break;
      case OPS.setTextRise:
        state.text.rise = args[0] as number;
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showGlyphs(args[0] as Array<PdfGlyph | number | null>);
        break;
      case OPS.nextLineShowText:
        moveText(0, -state.text.leading);
        showGlyphs(args[0] as Array<PdfGlyph | number | null>);
        break;
      case OPS.nextLineSetSpacingShowText:
        state.text.wordSpacing = args[0] as number;
        state.text.charSpacing = args[1] as number;
        moveText(0, -state.text.leading);
        showGlyphs(args[2] as Array<PdfGlyph | number | null>);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat: {
        const m = toPage(state.ctm);
        imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]);
        break;
      }
      default:
    }
  }

  return { index, width: viewport.width, height: viewport.height, glyphs, paths, imageArea };
}
