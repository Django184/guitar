import { expect, test } from '@playwright/test';
import { musicXmlFile } from './fixtures';
import { importScore, openApp, waitForScore } from './helpers';

test.describe('Phase 1 : critères d’acceptation', () => {
  test('accordeur : un La à 110 Hz s’affiche « A2 » à ±2 cents', async ({ page }) => {
    await openApp(page, 'accordeur');
    await page.getByRole('button', { name: 'Démarrer' }).click();
    await expect(page.getByTestId('note')).toHaveText('A2');
    await expect(page.getByTestId('cents')).toHaveText(/^(0|[+−][12])\sct$/);
    await expect(page.getByTestId('string-info')).toContainText('5 (A2)');
  });

  test('métronome : le premier temps est marqué à part et les temps défilent', async ({ page }) => {
    await openApp(page, 'metronome');
    await page.getByRole('button', { name: 'Démarrer' }).click();
    const beats = page.getByTestId('beats').locator('.beat');
    await expect(beats).toHaveCount(4);
    await expect(beats.first()).toHaveClass(/beat--strong/);
    await expect(page.getByTestId('beats').locator('.beat.is-on')).toHaveCount(1);
    await page.getByRole('button', { name: 'Arrêter' }).click();
  });

  test('installable : manifeste complet et service worker actif', async ({ page }) => {
    await openApp(page, 'accordeur');
    const link = page.locator('link[rel="manifest"]');
    test.skip((await link.count()) === 0, 'build de développement sans manifeste');
    const href = (await link.getAttribute('href')) as string;
    const manifest = await (await page.request.get(new URL(href, page.url()).toString())).json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
    const ready = await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active);
    expect(ready).toBe(true);
  });

  test('hors-ligne : l’app et une partition importée s’ouvrent sans réseau, son compris', async ({ page, context }) => {
    await openApp(page);
    const hasManifest = await page.locator('link[rel="manifest"]').count();
    test.skip(hasManifest === 0, 'build de développement sans service worker');

    await importScore(page, musicXmlFile());
    await waitForScore(page);
    const scoreUrl = page.url();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Premier rechargement : la page passe sous le contrôle du service worker.
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await context.setOffline(true);
    await page.goto(scoreUrl);
    await waitForScore(page); // alphaTab, police, Worker, Worklet et banque de sons depuis le cache
    await page.getByRole('link', { name: 'Accordeur' }).first().click();
    await expect(page.getByRole('button', { name: 'Démarrer' })).toBeVisible();
    await context.setOffline(false);
  });
});
