import fs from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { midiFile, musicXmlFile, mxlFile } from './fixtures';
import { barTicks, beatPoint, importScore, openApp, passagePoints, playerState, touchSelectBars, waitForScore } from './helpers';
import { GP_FIXTURES } from './paths';

/** Notes de la première piste : mesure, début et durée (ticks), hauteur. */
const scoreNotes = (page: Page) =>
  page.evaluate(() => {
    const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
    const out: string[] = [];
    for (const staff of api.score.tracks[0].staves)
      for (const bar of staff.bars)
        for (const voice of bar.voices)
          for (const beat of voice.beats) for (const note of beat.notes) out.push(`${bar.index}:${beat.displayStart}:${beat.displayDuration}:${note.realValue}`);
    return out.sort();
  });

/** Gravure de la partition ouverte en SVG statique (sans rendu différé), prête à imprimer. */
const engravedHtml = (page: Page) =>
  page.evaluate(async () => {
    const { api, at } = (window as unknown as { __scores: { debug(): { api: any; at: any } } }).__scores.debug();
    const host = document.createElement('div');
    // Visible (alphaTab attend qu'un conteneur soit affiché pour le mettre en page), mais sous l'app.
    host.style.cssText = 'position:fixed;left:0;top:0;width:760px;height:200px;overflow:hidden;z-index:-1;opacity:0.01';
    document.body.append(host);
    const engraver = new at.AlphaTabApi(host, {
      core: { engine: 'svg', useWorkers: false, enableLazyLoading: false, fontDirectory: api.settings.core.fontDirectory },
      display: { layoutMode: at.LayoutMode.Page, staveProfile: at.StaveProfile.Default },
      player: { playerMode: at.PlayerMode.Disabled },
    });
    // Portée de notation ET tablature, comme un export Guitar Pro ou MuseScore « portée + tablature ».
    for (const staff of api.score.tracks[0].staves) {
      staff.showStandardNotation = true;
      staff.standardNotationLineCount = 5;
    }
    await new Promise<void>((resolve) => {
      engraver.renderFinished.on(() => resolve());
      engraver.renderScore(api.score, [0]);
    });
    // Police musicale incorporée : la page d'impression n'a pas l'origine de l'app (CORS des polices).
    const fontUrl = new URL(`${api.settings.core.fontDirectory}Bravura.woff2`, location.href).href;
    const bytes = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const fontFace = `@font-face{font-family:'alphaTab';src:url(data:font/woff2;base64,${btoa(binary)}) format('woff2');}`;
    const styles = [...document.querySelectorAll('style')]
      .map((el) => el.outerHTML.replace(/@font-face\s*{[^}]*}/g, ''))
      .join('') + `<style>${fontFace}</style>`;
    const surface = host.querySelector('.at-surface') as HTMLElement;
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><base href="${location.href}">${styles}` +
      '<style>body{margin:0;background:#fff;color:#000} .at-surface>div{position:relative!important;top:auto!important;left:auto!important;break-inside:avoid}</style>' +
      `</head><body><div style="width:760px">${surface.outerHTML}</div></body></html>`;
    engraver.destroy();
    host.remove();
    return html;
  });

/** PDF valide mais sans musique (une ligne de texte). */
function textOnlyPdf(): string {
  const content = 'BT /F1 12 Tf 50 150 Td (Bonjour) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

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

  test('PDF exporté par un logiciel : lu dans l’app, partition et tablature', async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    // Le PDF est produit ici : la partition MusicXML de test, gravée par alphaTab (police SMuFL),
    // puis imprimée en PDF par Chromium, comme un export de logiciel de partition.
    await openApp(page);
    await importScore(page, musicXmlFile());
    await waitForScore(page, { sound: false });
    const original = await scoreNotes(page);
    const html = await engravedHtml(page);
    const printer = await context.newPage();
    await printer.setContent(html, { waitUntil: 'load' });
    await printer.evaluate(async () => {
      await document.fonts.load('24px alphaTab', '\ue050');
      await document.fonts.ready;
    });
    const pdf = await printer.pdf({ format: 'A4', printBackground: true });
    await printer.close();
    // Conservé avec les résultats des tests (artefact de la CI) pour pouvoir l'examiner.
    fs.writeFileSync(testInfo.outputPath('promenade.pdf'), pdf);

    await page.goto('./?e2e#/partitions');
    await importScore(page, { name: 'promenade.pdf', mimeType: 'application/pdf', buffer: pdf });
    await waitForScore(page, { sound: false });
    await expect(page.locator('.player__title')).toHaveText('Promenade en Sol');
    await expect(page.locator('.player__notice')).toContainText('PDF');
    const info = await scoreApi(page);
    expect(info.tab).toBe(true);
    expect(info.fretted).toBe(info.notes);
    // Mêmes notes, mêmes mesures, mêmes positions dans la mesure, mêmes durées.
    expect(await scoreNotes(page)).toEqual(original);

    // Rouverte depuis la bibliothèque : le MusicXML converti est conservé, pas besoin de relire le PDF.
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click();
    await expect(page.getByTestId('library')).toContainText('Promenade en Sol');
  });

  test('PDF sans partition ou illisible : explication, rien n’est ajouté à la bibliothèque', async ({ page }) => {
    await openApp(page);
    await importScore(page, { name: 'lettre.pdf', mimeType: 'application/pdf', buffer: Buffer.from(textOnlyPdf()) });
    await expect(page.getByTestId('score-result')).toContainText('être converti');
    await expect(page.getByTestId('score-result')).toContainText('Aucune portée');
    await expect(page).toHaveURL(/#\/partitions$/);
    await importScore(page, { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%test\n') });
    await expect(page.getByRole('alert')).toContainText('pas un PDF lisible');
    await expect(page.getByTestId('library')).toBeHidden();
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
    // Jamais bloquée : la position avance au moins chaque seconde.
    for (let i = 1; i < playing.length; i++) expect(playing[i]!.t - playing[i - 1]!.t, 'blocage de la lecture (ms)').toBeLessThan(1000);

    // 50 % : avant le bouclage, le passage avance à la moitié du tempo écrit (±20 %).
    // Droites de régression position = f(temps), avant et après le bouclage : on mesure la
    // continuité de la musique elle-même, pas l'espacement des événements (que le
    // navigateur peut regrouper quand la machine est chargée).
    const fit = (points: Array<{ tick: number; t: number }>): { at: (tick: number) => number; rate: number } => {
      const n = points.length;
      const mt = points.reduce((sum, p) => sum + p.t, 0) / n;
      const mk = points.reduce((sum, p) => sum + p.tick, 0) / n;
      const slope =
        points.reduce((sum, p) => sum + (p.t - mt) * (p.tick - mk), 0) / points.reduce((sum, p) => sum + (p.t - mt) ** 2, 0);
      return { at: (tick) => mt + (tick - mk) / slope, rate: slope * 1000 };
    };
    const beforeWrap = playing.slice(0, wrapIndex).filter((p) => p.t > before.t - 2500);
    const afterWrap = playing.slice(wrapIndex).filter((p, i, list) => p.t < after.t + 2500 && (i === 0 || p.tick >= list[i - 1]!.tick));
    expect(beforeWrap.length, 'positions avant le bouclage').toBeGreaterThan(5);
    expect(afterWrap.length, 'positions après le bouclage').toBeGreaterThan(5);
    const pre = fit(beforeWrap);
    const post = fit(afterWrap);
    const expected = 960 * (tempo / 60) * 0.5;
    expect(pre.rate / expected).toBeGreaterThan(0.8);
    expect(pre.rate / expected).toBeLessThan(1.2);
    expect(post.rate / expected).toBeGreaterThan(0.8);
    expect(post.rate / expected).toBeLessThan(1.2);

    // Sans trou : la reprise au début suit immédiatement la fin du passage (écart < 120 ms).
    const range = state.range!;
    const gapMs = post.at(range.startTick) - pre.at(range.endTick);
    expect(Math.abs(gapMs), 'écart au bouclage (ms)').toBeLessThan(120);
    testInfo.annotations.push({
      type: 'mesure',
      description: `tempo ${tempo}, ${Math.round(pre.rate)} ticks/s (attendu ${Math.round(expected)}), passage de ${loopSeconds.toFixed(1)} s, écart au bouclage ${gapMs.toFixed(0)} ms`,
    });

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
    // Le message « supprimée » ne doit pas masquer la bibliothèque (il recouvre la barre de titre).
    const toast = await page.locator('#toast').boundingBox();
    const content = await page.locator('.library-view').boundingBox();
    expect(toast, 'message affiché').not.toBeNull();
    expect(toast!.y + toast!.height, 'message au-dessus de la bibliothèque').toBeLessThanOrEqual(content!.y);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(list.locator('.library__item')).toHaveCount(count);
  });
});
