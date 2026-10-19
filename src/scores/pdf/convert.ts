/**
 * Conversion d'un PDF de partition en MusicXML, entièrement dans le navigateur.
 *
 * Seuls les PDF « vectoriels » (exportés par MuseScore, Guitar Pro, Finale, Sibelius, Dorico,
 * LilyPond…) sont lisibles : leurs symboles musicaux sont des caractères de police et leurs
 * lignes des tracés, positionnés exactement. Un PDF scanné ne contient qu'une image.
 */
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { extractPage } from './extract';
import { toMusicXml } from './musicxml';
import { recognize } from './recognize';
import type { PageData } from './types';

export type PdfConversion =
  | { kind: 'score'; xml: string; title: string; measures: number; notes: number; tabs: number }
  /** Pages faites d'images : partition scannée ou photographiée. */
  | { kind: 'scanned' }
  /** Aucune portée reconnue. */
  | { kind: 'no-music' }
  | { kind: 'protected' };

/** Au-delà, la lecture serait longue et le résultat peu maniable. */
export const MAX_PDF_PAGES = 60;

function looksScanned(pages: PageData[]): boolean {
  const imageShare = pages.reduce((s, p) => s + p.imageArea / (p.width * p.height), 0) / Math.max(1, pages.length);
  const glyphs = pages.reduce((s, p) => s + p.glyphs.length, 0);
  return imageShare > 0.3 && glyphs < 50 * pages.length;
}

export async function convertPdf(bytes: Uint8Array, onProgress?: (page: number, total: number) => void): Promise<PdfConversion> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // Copie : pdf.js transfère le tampon à son worker.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    fontExtraProperties: true,
    verbosity: 0,
  });
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
      onProgress?.(n, total);
    }
    const { score, stats } = recognize(pages);
    if (stats.notes === 0 || !score.parts.length) return looksScanned(pages) ? { kind: 'scanned' } : { kind: 'no-music' };
    return {
      kind: 'score',
      xml: toMusicXml(score),
      title: score.title,
      measures: stats.measures,
      notes: stats.notes,
      tabs: score.parts.filter((p) => p.tuning).length,
    };
  } finally {
    void task.destroy();
  }
}
