/**
 * Conversion d'un PDF de partition en MusicXML, entièrement dans le navigateur.
 *
 * Trois lectures, de la plus sûre à la plus approximative :
 * 1. PDF « vectoriel » (exporté par MuseScore, Guitar Pro, Finale, Sibelius, Dorico, LilyPond…) :
 *    symboles musicaux en caractères de police et lignes en tracés, positionnés exactement ;
 * 2. tablature « texte » (ASCII) écrite en caractères à chasse fixe ;
 * 3. tablature texte dessinée en image (capture d'écran collée dans un document) : reconnaissance
 *    de caractères dédiée (tabOcr.ts, chargé seulement dans ce cas).
 * Une partition scannée (portées en image) reste illisible.
 */
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type * as PdfJs from 'pdfjs-dist';
import { monospaceRows, readAsciiTab, type TextRow } from './asciiTab';
import { extractPage } from './extract';
import type { RecScore } from './model';
import { toMusicXml } from './musicxml';
import { recognize } from './recognize';
import { textLines } from './tab';
import type { PageData, PageImage } from './types';

export type PdfSource = 'vector' | 'text' | 'image';

export type PdfConversion =
  | {
      kind: 'score';
      source: PdfSource;
      xml: string;
      title: string;
      measures: number;
      notes: number;
      tabs: number;
      /** Tablature texte : ses barres de mesure étaient écrites (sinon, mesures déduites). */
      tabBars?: boolean;
    }
  /** Pages faites d'images : partition scannée ou photographiée. */
  | { kind: 'scanned' }
  /** Aucune portée reconnue. */
  | { kind: 'no-music' }
  | { kind: 'protected' };

/** Étape en cours : lecture des pages, puis (au besoin) des images. */
export type PdfPhase = 'pages' | 'images';

/** Au-delà, la lecture serait longue et le résultat peu maniable. */
export const MAX_PDF_PAGES = 60;

function looksScanned(pages: PageData[]): boolean {
  const imageShare = pages.reduce((s, p) => s + p.imageArea / (p.width * p.height), 0) / Math.max(1, pages.length);
  const glyphs = pages.reduce((s, p) => s + p.glyphs.length, 0);
  return imageShare > 0.3 && glyphs < 50 * pages.length;
}

/** Image assez grande pour contenir au moins un système de tablature lisible. */
const readableImage = (img: PageImage): boolean => img.box.x1 - img.box.x0 >= 100 && img.box.y1 - img.box.y0 >= 30;

/** Objet d'une page (image décodée) ; null s'il n'arrive pas. */
function pageObject(page: PdfJs.PDFPageProxy, id: string, timeout = 10000): Promise<unknown> {
  const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    try {
      objs.get(id, (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function convertPdf(
  bytes: Uint8Array,
  onProgress?: (page: number, total: number, phase: PdfPhase) => void,
): Promise<PdfConversion> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const open = () =>
    pdfjs.getDocument({
      // Copie : pdf.js transfère le tampon à son worker.
      data: bytes.slice(),
      disableFontFace: true,
      fontExtraProperties: true,
      // Images en pixels bruts (et non en ImageBitmap) : la lecture des tablatures en image en a besoin.
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      verbosity: 0,
    });
  const task = open();
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    if ((error as { name?: string })?.name === 'PasswordException') return { kind: 'protected' };
    throw error;
  }
  try {
    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages: PageData[] = [];
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      pages.push(await extractPage(pdfjs, page, n - 1));
      page.cleanup();
      onProgress?.(n, total, 'pages');
    }
    const done = (score: RecScore, measures: number, notes: number, source: PdfSource, tabBars?: boolean): PdfConversion => ({
      kind: 'score',
      source,
      ...(tabBars === undefined ? {} : { tabBars }),
      xml: toMusicXml(score),
      title: score.title,
      measures,
      notes,
      tabs: score.parts.filter((p) => p.tuning).length,
    });

    // 1. Partition vectorielle.
    const { score, stats } = recognize(pages);
    if (stats.notes > 0 && score.parts.length) return done(score, stats.measures, stats.notes, 'vector');

    // 2. Tablature texte.
    const texts = pages.flatMap((p) => textLines(p.glyphs, p.index));
    const rows: TextRow[] = pages.flatMap((p) => monospaceRows(p.glyphs, p.index));
    const fromText = readAsciiTab(rows, texts);
    if (fromText) return done(fromText.score, measureCount(fromText.score), fromText.notes, 'text', fromText.bars);

    // 3. Tablature texte en image. Document rouvert : une fois une page nettoyée, pdf.js ne
    // renvoie plus ses images déjà décodées.
    const withImages = pages.filter((p) => p.images?.some(readableImage));
    if (withImages.length) {
      const { ocrTabRows, toGray } = await import('./tabOcr');
      const imageTask = open();
      try {
        const imageDoc = await imageTask.promise;
        let read = 0;
        for (const { index } of withImages) {
          const page = await imageDoc.getPage(index + 1);
          const data = await extractPage(pdfjs, page, index); // décode les images de la page
          for (const img of (data.images ?? []).filter(readableImage)) {
            const obj = await pageObject(page, img.id);
            const gray = obj ? toGray(obj as Parameters<typeof toGray>[0]) : null;
            if (gray) rows.push(...ocrTabRows(gray, index, img.box));
            // Laisse respirer l'interface entre deux images.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          page.cleanup();
          onProgress?.(++read, withImages.length, 'images');
        }
      } finally {
        void imageTask.destroy();
      }
      rows.sort((a, b) => a.page - b.page || a.y - b.y);
      const fromImages = readAsciiTab(rows, texts);
      if (fromImages) return done(fromImages.score, measureCount(fromImages.score), fromImages.notes, 'image', fromImages.bars);
    }
    return looksScanned(pages) ? { kind: 'scanned' } : { kind: 'no-music' };
  } finally {
    void task.destroy();
  }
}

const measureCount = (score: RecScore): number => Math.max(0, ...score.parts.map((p) => p.measures.length));
