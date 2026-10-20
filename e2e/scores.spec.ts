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

/** Tablature texte de test : deux mesures, accordage drop D écrit dans les noms de cordes. */
const ASCII_TAB = [
  'e|-0---------------|-----------------|',
  'B|-----1-------1---|-3---------------|',
  'G|---------2-------|-----------------|',
  'D|-----------------|---------2-------|',
  'A|-----------------|-----------------|',
  'D|-----------------|-0-----------10--|',
];

/**
 * Page de tablature texte, imprimée en PDF par Chromium : en caractères (police à chasse fixe)
 * ou en image (capture d'écran collée dans un document).
 */
function asciiTabHtml(mode: 'text' | 'image'): string {
  const lines = JSON.stringify(ASCII_TAB);
  const body =
    mode === 'text'
      ? `<pre style="font: 11px 'Courier New', monospace">${ASCII_TAB.join('\n')}</pre>`
      : `<canvas id="c" width="760" height="230"></canvas>
<script>
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  ctx.font = '30px monospace';
  ctx.textBaseline = 'middle';
  ${lines}.forEach((line, i) => ctx.fillText(line, 12, 30 + i * 34));
  const img = document.createElement('img');
  img.src = c.toDataURL('image/png');
  img.style.width = c.width / 2 + 'px';
  document.body.append(img);
  c.remove();
</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family: sans-serif">
<h1 style="font-size: 24px">Exercice en arpèges</h1><p style="font-size: 12px">Capo 2</p>${body}</body></html>`;
}

/** Corde pincée (Karplus-Strong). */
function pluck(out: Float32Array, rate: number, start: number, midi: number, seed: number): void {
  const period = Math.max(2, Math.round(rate / (440 * 2 ** ((midi - 69) / 12))));
  let s = seed;
  const buf = Float32Array.from({ length: period }, () => (s = (s * 16807) % 2147483647) / 1073741823.5 - 1);
  const i0 = Math.round(start * rate);
  for (let n = 0, idx = 0; n < Math.min(out.length - i0, rate * 2); n++) {
    const next = (idx + 1) % period;
    const v = buf[idx] as number;
    buf[idx] = 0.996 * 0.5 * (v + (buf[next] as number));
    out[i0 + n] = (out[i0 + n] as number) + 0.25 * v;
    idx = next;
  }
}

/** Enregistrement de référence de test : guitare synthétisée, WAV mono 16 bits. */
function guitarWav(notes: Array<{ time: number; pitches: number[] }>, duration: number, rate = 22050): Buffer {
  const samples = new Float32Array(Math.round(duration * rate));
  notes.forEach((n, i) => n.pitches.forEach((p, j) => pluck(samples, rate, n.time, p, i * 7 + j + 1)));
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round((v / peak) * 0.9 * 32767), 44 + i * 2));
  return buf;
}

/**
 * La tablature ASCII_TAB (drop D, capo 2) jouée avec un autre rythme que son espacement :
 * mesure 1 : noire pointée, croche, noire, noire ; mesure 2 : blanche, noire, noire. 100 à la noire.
 */
const TAB_RHYTHM = [0, 1.5, 2, 3, 4, 6, 7];
const TAB_PITCHES = [[66], [62], [59], [62], [64, 40], [54], [50]];
const TAB_TIMES = TAB_RHYTHM.map((q) => 1.2 + q * 0.6);
const tabRecording = (): { name: string; mimeType: string; buffer: Buffer } => ({
  name: 'reprise.wav',
  mimeType: 'audio/wav',
  buffer: guitarWav(
    TAB_TIMES.map((time, i) => ({ time, pitches: TAB_PITCHES[i] as number[] })),
    (TAB_TIMES[TAB_TIMES.length - 1] as number) + 2.5,
  ),
});

/** Débuts (en noires) des notes de la partition ouverte, notes liées exclues. */
const noteStarts = (page: Page) =>
  page.evaluate(() => {
    const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
    const out: number[] = [];
    for (const bar of api.score.tracks[0].staves[0].bars)
      for (const beat of bar.voices[0].beats) {
        if (beat.isRest || !beat.notes.some((n: any) => !n.isTieDestination)) continue;
        out.push((api.score.masterBars[bar.index].start + beat.playbackStart) / 960);
      }
    return { starts: out, tempo: api.score.tempo as number };
  });

/** Importe la tablature texte de test (PDF imprimé par Chromium) et l'ouvre. */
async function openTextTab(page: Page, context: import('@playwright/test').BrowserContext): Promise<void> {
  const printer = await context.newPage();
  await printer.setContent(asciiTabHtml('text'), { waitUntil: 'load' });
  const pdf = await printer.pdf({ format: 'A4' });
  await printer.close();
  await openApp(page);
  await importScore(page, { name: 'arpeges.pdf', mimeType: 'application/pdf', buffer: pdf });
  await waitForScore(page);
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

  for (const mode of ['text', 'image'] as const) {
    test(`PDF de tablature texte (${mode === 'text' ? 'en caractères' : 'en image'}) : lue dans l’app`, async ({ page, context }, testInfo) => {
      test.setTimeout(90_000);
      const printer = await context.newPage();
      await printer.setContent(asciiTabHtml(mode), { waitUntil: 'load' });
      if (mode === 'image') await printer.waitForFunction(() => document.querySelector('img')?.complete === true);
      const pdf = await printer.pdf({ format: 'A4' });
      await printer.close();
      fs.writeFileSync(testInfo.outputPath(`tablature-${mode}.pdf`), pdf);

      await openApp(page);
      await importScore(page, { name: `tablature-${mode}.pdf`, mimeType: 'application/pdf', buffer: pdf });
      await waitForScore(page, { sound: false });
      await expect(page.locator('.player__title')).toHaveText('Exercice en arpèges');
      await expect(page.locator('.player__notice')).toContainText('Tablature lue dans le PDF');
      const info = await scoreApi(page);
      expect(info.tab).toBe(true);
      expect(info.notes).toBe(8);
      expect(info.fretted).toBe(8);
      // Cases dans l'ordre de lecture (accords de la corde aiguë à la grave).
      const frets = await page.evaluate(() => {
        const { api } = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug();
        const out: number[] = [];
        for (const bar of api.tracks[0].staves[0].bars) for (const beat of bar.voices[0].beats) for (const note of beat.notes) out.push(note.fret);
        return out;
      });
      expect([...frets].sort((a, b) => a - b)).toEqual([0, 0, 1, 1, 2, 2, 3, 10]);
    });
  }

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

test.describe('Calage sur un enregistrement de référence', () => {
  test('écoute automatique d’un fichier audio : rythme réécrit, lecture qui suit l’enregistrement', async ({ page, context }) => {
    test.setTimeout(120_000);
    await openTextTab(page, context);
    expect((await noteStarts(page)).starts).toEqual([0, 1, 2, 3, 4, 6, 7]);

    await page.getByTestId('media-toggle').click();
    await page.getByTestId('media-file').setInputFiles(tabRecording());
    await expect(page.locator('.media__audio')).toBeAttached();
    await page.getByRole('button', { name: 'Écoute automatique' }).click();
    await expect(page.getByTestId('rhythm-summary')).toContainText('2', { timeout: 60_000 });
    await expect(page.getByTestId('rhythm-summary')).toContainText('≈ 100');
    await page.getByTestId('rhythm-keep').click();
    await expect(page.locator('.player__notice')).toContainText('calé', { timeout: 30_000 });
    await waitForScore(page);
    const result = await noteStarts(page);
    expect(result.starts).toEqual(TAB_RHYTHM);
    expect(result.tempo).toBe(100);
    await expect(page.getByTestId('media-follow')).toHaveAttribute('aria-pressed', 'true');

    // Lecture : c'est l'enregistrement qui joue, et le curseur suit sa position.
    await page.getByRole('button', { name: 'Lire' }).click();
    await page.waitForFunction(() => !(document.querySelector('.media__audio') as HTMLAudioElement).paused, null, { timeout: 15_000 });
    // 3 s dans l'enregistrement = 3e temps (la première note sonne à 1,2 s, noire = 0,6 s) : tick 2880.
    // (Position imposée : dans Chromium sans tête, avec les périphériques simulés, le son peut se figer.)
    await page.evaluate(() => {
      (document.querySelector('.media__audio') as HTMLAudioElement).currentTime = 3;
    });
    await page.waitForFunction(
      () => {
        const tick = (window as unknown as { __scores: { debug(): { api: any } } }).__scores.debug().api.tickPosition as number;
        return Math.abs(tick - 2880) < 240;
      },
      null,
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => page.evaluate(() => (document.querySelector('.media__audio') as HTMLAudioElement).paused)).toBe(true);

    // Rouverte depuis la bibliothèque : rythme, lien et calage conservés.
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click();
    await page.locator('.library__open').first().click();
    await waitForScore(page);
    expect((await noteStarts(page)).starts).toEqual(TAB_RHYTHM);
    await expect(page.locator('.media__audio')).toBeAttached();
    await expect(page.getByTestId('media-follow')).toHaveAttribute('aria-pressed', 'true');
    // Lecteur audio recréé après l'ouverture : la lecture suit de nouveau l'enregistrement.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __scores: { debug(): { api: any; at: any } } }).__scores.debug().api.settings.player.playerMode))
      .toBe(4);
  });

  test('rythme tapé pendant l’écoute', async ({ page, context }) => {
    test.setTimeout(120_000);
    await openTextTab(page, context);
    await page.getByTestId('media-toggle').click();
    await page.getByTestId('media-file').setInputFiles(tabRecording());
    await expect(page.locator('.media__audio')).toBeAttached();
    await page.getByRole('button', { name: 'Taper le rythme' }).click();
    await expect(page.getByTestId('tap-progress')).toContainText('Note 1');
    // Un appui à chaque note, au moment où l'enregistrement la joue.
    await page.evaluate((times) => {
      const audio = document.querySelector('.media__audio') as HTMLAudioElement;
      const button = document.querySelector('[data-testid="tap-note"]') as HTMLElement;
      let i = 0;
      const loop = (): void => {
        if (i >= times.length) return;
        if (audio.currentTime >= (times[i] as number)) {
          button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          i++;
        }
        requestAnimationFrame(loop);
      };
      void audio.play();
      requestAnimationFrame(loop);
    }, TAB_TIMES);
    await expect(page.getByTestId('rhythm-summary')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('rhythm-keep').click();
    await expect(page.locator('.player__notice')).toContainText('calé', { timeout: 30_000 });
    await waitForScore(page, { sound: false });
    expect((await noteStarts(page)).starts).toEqual(TAB_RHYTHM);
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
