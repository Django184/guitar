/**
 * Transcriptions téléchargées (ou importées), lues et confrontées à la tablature, une à une :
 * le navigateur garde la main entre deux (pas de gel de l'écran).
 */
import type { AlphaTabModule } from '../alphatab';
import type { Onset } from './align';
import { type AlignedSource, alignSource } from './findRhythm';
import { readSource } from './readSource';
import { type Found, SearchFailure, download } from './search';

export interface SourceItem {
  label: string;
  bytes: () => Promise<Uint8Array>;
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const foundItems = (found: readonly Found[], proxy: string | null): SourceItem[] =>
  found.map((f) => ({ label: `${f.title} (${f.source})`, bytes: () => download(f.url, proxy) }));

export const fileItems = (files: readonly File[]): SourceItem[] =>
  files.map((file) => ({ label: file.name, bytes: async () => new Uint8Array(await file.arrayBuffer()) }));

/**
 * Lit et aligne chaque source. `onStep(n, total)` avant chacune ; `alive()` faux : abandon
 * (renvoie null). Les échecs (lien mort, fichier illisible) sont décrits, sans tout arrêter.
 */
export async function collectSources(
  at: AlphaTabModule,
  tab: readonly Onset[],
  items: readonly SourceItem[],
  onStep: (n: number, total: number) => void,
  alive: () => boolean,
): Promise<{ sources: AlignedSource[]; failures: string[] } | null> {
  const sources: AlignedSource[] = [];
  const failures: string[] = [];
  for (const [n, item] of items.entries()) {
    if (!alive()) return null;
    onStep(n + 1, items.length);
    try {
      const source = await readSource(at, await item.bytes(), item.label);
      if (!alive()) return null;
      sources.push(await alignSource(tab, source, pause));
    } catch (error) {
      failures.push(`${item.label} : ${error instanceof SearchFailure ? error.message : 'fichier illisible.'}`);
    }
  }
  return alive() ? { sources, failures } : null;
}
