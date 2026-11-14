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
    // Banque de sons : GeneralUser GS (public/sons/), précachée comme le reste de l'app.
    const soundFont = await page.evaluate(
      () => (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug().api.settings.player.soundFont as string,
    );
    expect(soundFont).toContain('sons/generaluser-gs-2.0.3.sf3');
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

test.describe('Sauvegarde de la bibliothèque', () => {
  test('export puis import sur un appareil vide : partition et réglages retrouvés, rien remplacé', async ({ page, browser, baseURL }, testInfo) => {
    await openApp(page);
    await importScore(page, musicXmlFile());
    await waitForScore(page, { sound: false });
    await page.goto('./?e2e#/partitions');
    await expect(page.getByTestId('library').locator('li')).toHaveCount(1);

    await page.locator('#settings-btn').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^pratique-guitare-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const path = testInfo.outputPath('sauvegarde.zip');
    await file.saveAs(path);
    await expect(page.getByTestId('backup-status')).toContainText('1 partition exportée');

    // Nouvel appareil : stockage vide.
    const other = await browser.newContext({ baseURL });
    const fresh = await other.newPage();
    await openApp(fresh);
    await expect(fresh.getByTestId('library').locator('li')).toHaveCount(0);
    await fresh.locator('#settings-btn').click();
    await fresh.getByTestId('backup-file').setInputFiles(path);
    await expect(fresh.getByTestId('backup-status')).toContainText('1 partition à ajouter');
    await fresh.getByTestId('backup-confirm').click();
    await expect(fresh.getByTestId('backup-status')).toContainText('Import terminé');
    await fresh.keyboard.press('Escape');
    await expect(fresh.getByTestId('library').locator('li')).toHaveCount(1);
    await fresh.getByTestId('library').locator('a').first().click();
    await waitForScore(fresh, { sound: false });

    // Second import : rien n'est ajouté ni remplacé.
    await fresh.goto('./?e2e#/partitions');
    await fresh.locator('#settings-btn').click();
    await fresh.getByTestId('backup-file').setInputFiles(path);
    await expect(fresh.getByTestId('backup-status')).toContainText('Rien à importer');
    await other.close();
  });
});

test.describe('Politique de sécurité du contenu', () => {
  test('aucun écran ne déclenche de violation (accordeur, métronome, partitions, réglages, lecteur)', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openApp(page, 'accordeur');
    const hasCsp = await page.locator('meta[http-equiv="Content-Security-Policy"]').count();
    test.skip(hasCsp === 0, 'build de développement sans politique de sécurité');
    await page.getByRole('button', { name: 'Démarrer' }).click();
    await page.getByRole('link', { name: 'Métronome' }).first().click();
    await page.getByRole('link', { name: 'Partitions' }).first().click();
    await importScore(page, musicXmlFile());
    await waitForScore(page);
    await page.getByRole('button', { name: 'Lire' }).click();
    await page.waitForTimeout(1500);
    await page.locator('#settings-btn').click();
    await expect(page.getByTestId('settings')).toBeVisible();
    await page.keyboard.press('Escape');
    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
