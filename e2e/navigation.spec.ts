import { type Page, expect, test } from '@playwright/test';
import { midiFile, musicXmlFile } from './fixtures';
import { importScore, openApp, waitForScore } from './helpers';

// Navigation et reprise (ECOSYSTEME.md §4, motifs N1 à N8).

const historyLength = (page: Page) => page.evaluate(() => history.length);
const activeHref = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('href') ?? null);
const tickPosition = (page: Page) =>
  page.evaluate(() => (window as unknown as { __scores: { debug(): { api: { tickPosition: number } } } }).__scores.debug().api.tickPosition);
const barStart = (page: Page, bar: number) =>
  page.evaluate(
    (i) => (window as unknown as { __scores: { debug(): { api: { score: { masterBars: Array<{ start: number }> } } } } }).__scores.debug().api.score.masterBars[i]?.start,
    bar,
  );

/** Deux partitions dans la bibliothèque, la seconde ouverte. */
async function twoScores(page: Page): Promise<string> {
  await openApp(page);
  await importScore(page, musicXmlFile());
  await waitForScore(page, { sound: false });
  await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click();
  await importScore(page, midiFile());
  await waitForScore(page, { sound: false });
  return new URL(page.url()).hash;
}

test.describe('Navigation et reprise', () => {
  test('retour à la bibliothèque : dans l’historique, partition quittée retrouvée et focalisée', async ({ page }) => {
    const hash = await twoScores(page);
    const length = await historyLength(page);
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click();
    await expect(page).toHaveURL(/#\/partitions$/);
    expect(await historyLength(page), 'aucune page ajoutée').toBe(length);
    await expect.poll(() => activeHref(page)).toBe(hash);
    await expect(page.locator(`.library__open[href="${hash}"]`)).toHaveClass(/is-found/);
    await expect(page.locator(`.library__open[href="${hash}"]`)).toBeInViewport();

    // Onglet Partitions depuis le lecteur : retour dans l'historique, puis retouché : en haut.
    await page.locator(`.library__open[href="${hash}"]`).click();
    await waitForScore(page, { sound: false });
    const again = await historyLength(page);
    await page.locator('.nav__item[data-route="partitions"]').click();
    await expect(page).toHaveURL(/#\/partitions$/);
    expect(await historyLength(page)).toBe(again);
    await page.locator('#main').evaluate((main) => (main.scrollTop = 200));
    await page.locator('.nav__item[data-route="partitions"]').click();
    await expect.poll(() => page.locator('#main').evaluate((main) => main.scrollTop)).toBe(0);
    await expect(page).toHaveURL(/#\/partitions$/);
  });

  test('retour d’Android : le panneau ouvert se ferme d’abord, la partition reste', async ({ page }) => {
    await openApp(page);
    await importScore(page, midiFile());
    await waitForScore(page, { sound: false });
    // CloseWatcher simulé : Playwright ne sait pas émettre le geste « retour » d'Android ; la requête de
    // fermeture est celle que Chrome adresse au panneau.
    await page.evaluate(() => {
      const w = window as unknown as { __watchers: Array<{ alive: boolean; onclose: (() => void) | null; requestClose(): void }>; CloseWatcher: unknown };
      w.__watchers = [];
      w.CloseWatcher = class {
        alive = true;
        onclose: (() => void) | null = null;
        constructor() {
          w.__watchers.push(this);
        }
        destroy(): void {
          this.alive = false;
        }
        requestClose(): void {
          if (!this.alive) return;
          this.alive = false;
          this.onclose?.();
        }
      };
    });
    const hash = new URL(page.url()).hash;
    await page.getByTestId('score-options').click();
    await page.getByTestId('media-toggle').click();
    await expect(page.getByTestId('media-panel')).toBeVisible();
    const alive = () => page.evaluate(() => (window as unknown as { __watchers: Array<{ alive: boolean }> }).__watchers.filter((x) => x.alive).length);
    expect(await alive()).toBe(1);
    await page.evaluate(() => (window as unknown as { __watchers: Array<{ alive: boolean; requestClose(): void }> }).__watchers.find((x) => x.alive)?.requestClose());
    await expect(page.getByTestId('media-panel')).toBeHidden();
    expect(new URL(page.url()).hash).toBe(hash);
    // Fermé par son bouton : plus rien à surveiller.
    await page.getByTestId('score-options').click();
    await page.getByTestId('media-toggle').click();
    await expect(page.getByTestId('media-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Fermer le panneau Vidéo de référence' }).click();
    await expect(page.getByTestId('media-panel')).toBeHidden();
    expect(await alive()).toBe(0);
  });

  test('clavier du lecteur et reprise à la dernière position', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'ordinateur', 'raccourcis clavier : ordinateur seulement');
    await openApp(page);
    await importScore(page, midiFile());
    await waitForScore(page);
    const hash = new URL(page.url()).hash;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // focus hors des boutons
    const loop = page.getByRole('button', { name: 'Boucle' });
    const before = await loop.getAttribute('aria-pressed');
    await page.keyboard.press('l');
    await expect(loop).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
    await page.keyboard.press('-');
    await expect(page.getByTestId('speed')).toContainText('95');
    await page.keyboard.press('+');
    await expect(page.getByTestId('speed')).toContainText('100');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    // alphaTab arrondit parfois la position d'un tick : écart toléré de quelques ticks (une noire = 960).
    const near = async (target: number) => expect.poll(async () => Math.abs((await tickPosition(page)) - target)).toBeLessThanOrEqual(4);
    await near((await barStart(page, 2)) as number);
    await page.keyboard.press('ArrowLeft');
    await near((await barStart(page, 1)) as number);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press(' ');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.keyboard.press(' ');
    await expect(page.getByRole('button', { name: 'Lire' })).toBeVisible();
    const tick = await tickPosition(page);
    expect(tick).toBeGreaterThanOrEqual(((await barStart(page, 2)) as number) - 4);

    // Bibliothèque : la partition dit où elle reprendra ; rouverte, elle y reprend.
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click();
    await expect(page.getByTestId('library-resume')).toContainText('Reprendre');
    await expect(page.getByTestId('library-resume')).toContainText('mesure 3');
    await page.locator(`.library__open[href="${hash}"]`).click();
    await waitForScore(page);
    await near(tick);
  });
});
