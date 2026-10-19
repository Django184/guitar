import { type Page, expect } from '@playwright/test';
import type { UploadFile } from './fixtures';

/** Ouvre l'app en mode test (accès au lecteur alphaTab via window.__scores). */
export async function openApp(page: Page, route = 'partitions'): Promise<void> {
  await page.goto(`./?e2e#/${route}`);
  await expect(page.locator('#view-title')).toBeVisible();
}

export async function importScore(page: Page, file: UploadFile | string): Promise<void> {
  await page.locator('.library-view input[type=file]').setInputFiles(file);
}

/** Attend que la partition soit affichée (mise en page terminée) et que le son soit prêt. */
export async function waitForScore(page: Page, { sound = true } = {}): Promise<void> {
  await expect(page).toHaveURL(/#\/partitions\/.+/);
  await page.waitForFunction(
    () => {
      const handle = (window as unknown as { __scores?: { debug(): { api: any } } }).__scores?.debug();
      const lookup = handle?.api?.boundsLookup;
      return !!lookup && lookup.isFinished && lookup.staffSystems.length > 0;
    },
    null,
    { timeout: 60_000 },
  );
  await expect(page.locator('.player .at-surface svg, .player .at-surface canvas').first()).toBeAttached();
  if (sound) await expect(page.getByRole('button', { name: 'Lire' })).toBeEnabled({ timeout: 60_000 });
}

/** Coordonnées écran du premier ou du dernier temps d'une mesure (index 0 = mesure 1). */
export async function beatPoint(
  page: Page,
  barIndex: number,
  which: 'first' | 'last',
  { scroll = true } = {},
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ barIndex, which, scroll }) => {
      const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
      const beats = api.tracks[0].staves[0].bars[barIndex].voices[0].beats;
      const beat = which === 'first' ? beats[0] : beats[beats.length - 1];
      const r = api.boundsLookup.findBeat(beat).visualBounds;
      const scroller = document.querySelector('.player__score') as HTMLElement;
      const surface = document.querySelector('.player .at-surface') as HTMLElement;
      if (scroll) {
        // Amène la ligne de la mesure en haut de la zone visible avant de mesurer.
        const top = surface.getBoundingClientRect().top + r.y;
        const view = scroller.getBoundingClientRect();
        if (top < view.top || top + r.h > view.bottom) scroller.scrollTop += top - view.top - 20;
      }
      const rect = surface.getBoundingClientRect();
      // Haut de la portée plutôt que le centre : la ligne entière (portée + tablature) est haute.
      return { x: rect.left + r.x + r.w / 2, y: rect.top + r.y + Math.min(r.h / 2, 28) };
    },
    { barIndex, which, scroll },
  );
}

/** Points de départ et d'arrivée pour sélectionner à la souris les mesures firstBar..lastBar, tous deux visibles. */
export async function passagePoints(
  page: Page,
  firstBar: number,
  lastBar: number,
): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  const from = await beatPoint(page, firstBar, 'first');
  const to = await beatPoint(page, lastBar, 'last', { scroll: false });
  const box = await page.locator('.player__score').boundingBox();
  expect(box, 'zone de partition').not.toBeNull();
  expect(to.y, 'fin du passage visible sans défiler').toBeLessThan(box!.y + box!.height);
  return { from, to };
}

/** Plage de lecture actuelle (ticks MIDI) et réglages du lecteur. */
export async function playerState(page: Page): Promise<{ range: { startTick: number; endTick: number } | null; looping: boolean; speed: number }> {
  return page.evaluate(() => {
    const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
    const range = api.playbackRange;
    return {
      range: range ? { startTick: range.startTick, endTick: range.endTick } : null,
      looping: api.isLooping,
      speed: api.playbackSpeed,
    };
  });
}

/** Ticks de début et de fin des mesures firstBar..lastBar (index 0 = mesure 1). */
export async function barTicks(page: Page, firstBar: number, lastBar: number): Promise<{ start: number; end: number }> {
  return page.evaluate(
    ({ firstBar, lastBar }) => {
      const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
      const bars = api.score.masterBars;
      return { start: bars[firstBar].start, end: bars[lastBar].start + bars[lastBar].calculateDuration() };
    },
    { firstBar, lastBar },
  );
}

/**
 * Appui long sur la première mesure puis glissé du doigt jusqu'à la fin de la dernière
 * (événements tactiles réels). Si la fin est sous la zone visible, le doigt s'arrête
 * au bord bas, ce qui fait défiler la partition, comme sur un téléphone.
 */
export async function touchSelectBars(page: Page, firstBar: number, lastBar: number): Promise<void> {
  await beatPoint(page, firstBar, 'first'); // amène le début du passage en haut
  await page.evaluate(
    async ({ firstBar, lastBar }) => {
      const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
      const scroller = document.querySelector('.player__score') as HTMLElement;
      const surface = document.querySelector('.player .at-surface') as HTMLElement;
      const point = (bar: number, which: 'first' | 'last'): { x: number; y: number } => {
        const beats = api.tracks[0].staves[0].bars[bar].voices[0].beats;
        const r = api.boundsLookup.findBeat(which === 'first' ? beats[0] : beats[beats.length - 1]).visualBounds;
        const rect = surface.getBoundingClientRect();
        return { x: rect.left + r.x + r.w / 2, y: rect.top + r.y + Math.min(r.h / 2, 28) };
      };
      const start = point(firstBar, 'first');
      const target = document.elementFromPoint(start.x, start.y) as HTMLElement;
      const fire = (type: string, x: number, y: number, ended = false): void => {
        const t = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY });
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: ended ? [] : [t],
            targetTouches: ended ? [] : [t],
            changedTouches: [t],
          }),
        );
      };
      const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

      fire('touchstart', start.x, start.y);
      await wait(550); // appui long
      let x = start.x;
      let y = start.y;
      for (let i = 0; i < 200; i++) {
        const end = point(lastBar, 'last');
        const bottom = scroller.getBoundingClientRect().bottom;
        const next = end.y < bottom - 60 ? end : { x: end.x, y: bottom - 20 }; // bord bas : défilement
        x += (next.x - x) / 2;
        y += (next.y - y) / 2;
        fire('touchmove', x, y);
        await wait(25);
        if (Math.hypot(end.x - x, end.y - y) < 2) break;
      }
      fire('touchend', x, y, true);
    },
    { firstBar, lastBar },
  );
}
