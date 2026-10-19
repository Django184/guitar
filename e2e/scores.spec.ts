import fs from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { midiFile, musicXmlFile, mxlFile } from './fixtures';
import { barTicks, beatPoint, importScore, openApp, passagePoints, playerState, touchSelectBars, waitForScore } from './helpers';
import { GP_FIXTURES } from './paths';

const scoreApi = (page: Page) =>
  page.evaluate(() => {
    const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
    const staff = api.tracks[0].staves[0];
    const frets: number[] = [];
    for (const bar of staff.bars) for (const beat of bar.voices[0].beats) for (const note of beat.notes) frets.push(note.fret);
    return { tab: staff.showTablature as boolean, fretted: frets.filter((f) => f >= 0).length, notes: frets.length };
  });

test.describe('Import des formats', () => {
  for (const [format, file] of Object.entries(GP_FIXTURES)) {
    test(`Guitar Pro ${format} : partition et tablature affichées`, async ({ page }) => {
      test.skip(!fs.existsSync(file), 'fichier de test téléchargé par la CI uniquement');
      await openApp(page);
      await importScore(page, file);
      await waitForScore(page, { sound: false });
      expect((await scoreApi(page)).tab).toBe(true);
      await expect(page.locator('.library-view')).toBeHidden();
    });
  }

  test('MusicXML sans tablature : tablature calculée et signalée', async ({ page }) => {
    await openApp(page);
    await importScore(page, musicXmlFile());
    await waitForScore(page, { sound: false });
    const info = await scoreApi(page);
    await expect(page.locator('.player__title')).toHaveText('Promenade en Sol');
    expect(info.tab).toBe(true);
    expect(info.fretted).toBe(info.notes);
    await expect(page.locator('.player__notice')).toContainText('tablature');
  });

  test('MusicXML compressé (.mxl)', async ({ page }) => {
    await openApp(page);
    await importScore(page, await mxlFile());
    await waitForScore(page, { sound: false });
    await expect(page.locator('.player__title')).toHaveText('Promenade compressée');
    expect((await scoreApi(page)).tab).toBe(true);
  });

  test('MIDI : converti en partition avec tablature', async ({ page }) => {
    await openApp(page);
    await importScore(page, midiFile());
    await waitForScore(page, { sound: false });
    const info = await scoreApi(page);
    expect(info.tab).toBe(true);
    expect(info.notes).toBeGreaterThan(20);
    await expect(page.locator('.player__notice')).toContainText('MIDI');
  });

  test('PDF : guide de conversion, rien n’est ajouté à la bibliothèque', async ({ page }) => {
    await openApp(page);
    await importScore(page, { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%test\n') });
    await expect(page.getByTestId('score-result')).toContainText('être converti');
    await expect(page.getByTestId('score-result')).toContainText('MusicXML');
    await expect(page).toHaveURL(/#\/partitions$/);
  });

  test('fichier invalide et format non pris en charge : messages clairs', async ({ page }) => {
    await openApp(page);
    await importScore(page, { name: 'solo.gp5', mimeType: 'application/octet-stream', buffer: Buffer.from('pas du guitar pro') });
    await expect(page.getByRole('alert')).toContainText('Fichier invalide');
    await importScore(page, { name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\u0003\u0004word/document.xml') });
    await expect(page.getByRole('alert')).toContainText('Format non pris en charge');
  });
});

test.describe('Sélection, boucle et vitesse', () => {
  test('critère : la boucle des mesures 5 à 8 est jouée sans trou à 50 %', async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === 'mobile';
    await openApp(page);
    // Fichier Guitar Pro de la CI (120 BPM) si présent, sinon la mélodie MusicXML générée (100 BPM).
    await importScore(page, fs.existsSync(GP_FIXTURES.gp3) ? GP_FIXTURES.gp3 : musicXmlFile());
    await waitForScore(page);

    // Sélection des mesures 5 à 8 : appui long + glissé au doigt (mobile) ou glissé à la souris (ordinateur).
    if (mobile) {
      await touchSelectBars(page, 4, 7);
    } else {
      const { from, to } = await passagePoints(page, 4, 7);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    }
    await expect(page.getByTestId('selection-label')).toHaveText('Mesures 5 à 8');

    // Vitesse : 100 % → 50 % par pas de 5 %.
    for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Ralentir de 5 %' }).click();
    await expect(page.getByTestId('speed')).toHaveText(/^50\s%$/);

    const ticks = await barTicks(page, 4, 7);
    const state = await playerState(page);
    expect(state.looping).toBe(true);
    expect(state.speed).toBe(0.5);
    expect(state.range).not.toBeNull();
    expect(Math.abs(state.range!.startTick - ticks.start)).toBeLessThan(10);
    expect(Math.abs(state.range!.endTick - ticks.end)).toBeLessThan(100);

    // Lecture : on enregistre les positions et on attend un tour de boucle complet.
    const tempo = await page.evaluate(() => (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug().api.score.tempo as number);
    const loopSeconds = ((ticks.end - ticks.start) / 960) * (60 / tempo) / 0.5;
    await page.evaluate(() => {
      const w = window as unknown as { __positions: Array<{ tick: number; t: number }>; __scores: { debug(): { api: any } } };
      w.__positions = [];
      w.__scores.debug().api.playerPositionChanged.on((e: { currentTick: number }) => w.__positions.push({ tick: e.currentTick, t: performance.now() }));
    });
    await page.getByRole('button', { name: 'Lire' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.waitForTimeout((loopSeconds + 3) * 1000);
    const positions = await page.evaluate(() => (window as unknown as { __positions: Array<{ tick: number; t: number }> }).__positions);
    await page.getByRole('button', { name: 'Pause' }).click();

    // Toutes les positions restent dans le passage.
    const playing = positions.filter((p) => p.t > positions[0]!.t + 300);
    for (const p of playing) {
      expect(p.tick).toBeGreaterThanOrEqual(ticks.start - 10);
      expect(p.tick).toBeLessThanOrEqual(ticks.end + 10);
    }
    // Au moins un retour au début : la fin du passage enchaîne sur son début.
    const wrapIndex = playing.findIndex((p, i) => i > 0 && p.tick < playing[i - 1]!.tick - (ticks.end - ticks.start) / 2);
    expect(wrapIndex, 'retour au début du passage').toBeGreaterThan(0);
    const before = playing[wrapIndex - 1]!;
    const after = playing[wrapIndex]!;
    expect(before.tick).toBeGreaterThan(ticks.end - 960);
    expect(after.tick).toBeLessThan(ticks.start + 960);
    // Sans trou : jamais plus de 300 ms sans avancer, y compris au moment du bouclage.
    for (let i = 1; i < playing.length; i++) expect(playing[i]!.t - playing[i - 1]!.t).toBeLessThan(300);
    expect(after.t - before.t).toBeLessThan(300);
    // 50 % : le passage avance à la moitié du tempo écrit (±20 %).
    const segment = playing.slice(0, wrapIndex);
    const rate = (segment[segment.length - 1]!.tick - segment[0]!.tick) / ((segment[segment.length - 1]!.t - segment[0]!.t) / 1000);
    const expected = 960 * (tempo / 60) * 0.5;
    expect(rate / expected).toBeGreaterThan(0.8);
    expect(rate / expected).toBeLessThan(1.2);
    testInfo.annotations.push({ type: 'mesure', description: `tempo ${tempo}, ${Math.round(rate)} ticks/s (attendu ${Math.round(expected)}), passage de ${loopSeconds.toFixed(1)} s` });

    // Persistance : après rechargement, la bibliothèque rouvre la partition avec sa sélection et sa vitesse.
    const url = page.url();
    await page.reload();
    await page.goto(url.replace(/#.*/, '#/partitions'));
    const item = page.getByTestId('library').locator('.library__open').first();
    await expect(item).toBeVisible();
    await item.click();
    await waitForScore(page, { sound: false });
    await expect(page.getByTestId('selection-label')).toHaveText('Mesures 5 à 8');
    await expect(page.getByTestId('speed')).toHaveText(/^50\s%$/);
  });

  test('effleurement : déplace le curseur sans perdre la sélection', async ({ page }, testInfo) => {
    await openApp(page);
    await importScore(page, musicXmlFile());
    await waitForScore(page, { sound: false });
    if (testInfo.project.name === 'mobile') await touchSelectBars(page, 1, 2);
    else {
      const { from, to } = await passagePoints(page, 1, 2);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
    }
    await expect(page.getByTestId('selection-label')).toHaveText('Mesures 2 à 3');
    const tap = await beatPoint(page, 5, 'first');
    if (testInfo.project.name === 'mobile') await page.touchscreen.tap(tap.x, tap.y);
    else await page.mouse.click(tap.x, tap.y);
    await expect(page.getByTestId('selection-label')).toHaveText('Mesures 2 à 3');
    await page.getByRole('button', { name: 'Effacer' }).click();
    expect((await playerState(page)).range).toBeNull();
  });
});

test.describe('Bibliothèque', () => {
  test('renommer, supprimer, annuler la suppression', async ({ page }) => {
    await openApp(page);
    await importScore(page, midiFile());
    await waitForScore(page, { sound: false });
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click();
    const list = page.getByTestId('library');
    await expect(list).toContainText('arpeges');

    await list.getByRole('button', { name: /^Renommer/ }).first().click();
    await page.getByLabel('Nouveau titre').fill('Arpèges du matin');
    await page.getByLabel('Nouveau titre').press('Enter');
    await expect(list).toContainText('Arpèges du matin');

    const count = await list.locator('.library__item').count();
    await list.getByRole('button', { name: /^Supprimer/ }).first().click();
    await expect(list.locator('.library__item')).toHaveCount(count - 1);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(list.locator('.library__item')).toHaveCount(count);
  });
});
