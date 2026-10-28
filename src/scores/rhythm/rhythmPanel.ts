/**
 * Panneau « Rythme » du lecteur : le rythme d'une tablature lue dans un PDF, retrouvé dans des
 * transcriptions du même morceau (MIDI, Guitar Pro, MusicXML). Ouvrir le panneau suffit : la
 * recherche (BitMidi), l'alignement et le vote se font seuls ; la tablature réécrite s'affiche
 * en aperçu, mesures douteuses surlignées, à garder ou non. Les notes restent celles de la
 * tablature : seul le rythme change.
 * D'autres sources s'ajoutent à la main : liens trouvés par Claude (claude.ai), fichiers.
 */
import { openSettings } from '../../shell/settings';
import { h } from '../../ui/dom';
import { menuRow, panelHead } from '../../ui/sheet';
import { describeError } from '../../ui/errors';
import { type AlphaTabModule, type Score, loadAlphaTab, parseScore } from '../alphatab';
import type { ScoreEntry } from '../library';
import { type ScoreEvent, hasRepeats, rewriteTab, scoreEvents } from '../sync/scoreEvents';
import type { Onset } from './align';
import type { Consensus } from './consensus';
import { collectSources, fileItems, foundItems } from './collect';
import { type AlignedSource, combine, tabOnsets, trackName } from './findRhythm';
import {
  type Found,
  claudeLink,
  claudePrompt,
  parseClaudeAnswer,
  proxyUrl,
  searchBitMidi,
} from './search';

const NB = ' ';
/** Typographie française : espace insécable avant « : ; ! ? » et à l'intérieur des guillemets. */
const fr = (text: string): string => text.replace(/ ([:;!?»])/g, `${NB}$1`).replace(/« /g, `«${NB}`);
const SOURCE_FILES = '.gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml,.mxl,.mid,.midi';
/** Une tablature plus courte ne se retrouve pas de façon fiable. */
const MIN_ONSETS = 8;

const plural = (n: number, word: string): string => `${n}${NB}${word}${n > 1 ? 's' : ''}`;

export interface RhythmPanelHost {
  current(): { entry: ScoreEntry; score: Score; trackIndex: number } | null;
  /** Aperçu d'une partition réécrite ; null : retour à la partition enregistrée. */
  preview(score: Score | null): void;
  /** Garde la partition réécrite (MusicXML) et la rouvre. */
  commit(entry: ScoreEntry, xml: Uint8Array): Promise<void>;
  /** Mesures surlignées (rythme à vérifier). */
  markBars(bars: readonly number[]): void;
  /** Sélectionne une mesure (lecture en boucle) et l'amène à l'écran. */
  selectBar(index: number): void;
  /** Le panneau s'ouvre (l'autre se ferme). */
  opened(): void;
}

type State = 'idle' | 'busy' | 'result' | 'none';

interface Pending {
  xml: string;
  consensus: Consensus;
}

export class RhythmPanel {
  readonly element: HTMLElement;
  readonly toggleButton: HTMLButtonElement;

  private state: State = 'idle';
  /** Sources déjà confrontées à la tablature (pour la partition et la piste courantes). */
  private sources: AlignedSource[] = [];
  private sourcesFor: string | null = null;
  private pending: Pending | null = null;
  /** Numéro de la tâche en cours : une tâche dépassée (autre partition) n'agit plus. */
  private session = 0;

  private readonly statusEl = h('p', { class: 'media__progress', role: 'status', 'data-testid': 'rhythm-status' });
  private readonly detailEl = h('p', { class: 'media__help', 'data-testid': 'rhythm-detail' });
  private readonly barsEl = h('div', { class: 'media__row media__row--wrap rhythm__bars', 'data-testid': 'rhythm-bars' });
  private readonly sourcesBox = h('details', { class: 'media__key rhythm__sources-box' });
  private readonly sourcesSummary = h('summary', {}, 'Sources');
  private readonly sourcesList = h('ul', { class: 'rhythm__sources', 'data-testid': 'rhythm-sources' });
  private readonly keepButton = h('button', { type: 'button', class: 'btn btn--small btn--accent', 'data-testid': 'sources-keep' }, 'Garder');
  private readonly cancelButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Annuler');
  private readonly decision = h('div', { class: 'media__row', hidden: true }, this.keepButton, this.cancelButton);
  private readonly againButton = h('button', { type: 'button', class: 'btn btn--small rhythm__again', hidden: true }, 'Chercher à nouveau');
  private readonly moreBox = h('details', { class: 'media__key rhythm__more' });
  private readonly claudeButton = h('a', { class: 'btn btn--small btn--link', target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'rhythm-claude' }, 'Demander à Claude');
  private readonly answerInput = h('textarea', {
    class: 'media__input rhythm__answer',
    rows: 3,
    placeholder: 'Collez ici la réponse de Claude',
    'aria-label': 'Réponse de Claude',
    'data-testid': 'rhythm-answer',
  });
  private readonly addButton = h('button', { type: 'button', class: 'btn btn--small', 'data-testid': 'rhythm-add' }, 'Ajouter ces liens');
  private readonly fileInput = h('input', { type: 'file', accept: SOURCE_FILES, multiple: true, hidden: true, 'data-testid': 'rhythm-file' });
  private readonly messageEl = h('p', { class: 'media__message', role: 'status', 'data-testid': 'rhythm-message' });

  constructor(private readonly host: RhythmPanelHost) {
    this.toggleButton = menuRow('Rythme', 'Le retrouver dans des transcriptions du morceau.', { 'aria-expanded': 'false', 'data-testid': 'rhythm-toggle' });
    this.toggleButton.hidden = true;
    this.toggleButton.addEventListener('click', () => this.setOpen(!this.isOpen));

    this.keepButton.addEventListener('click', () => void this.keep());
    this.againButton.addEventListener('click', () => {
      this.sources = [];
      void this.searchAll();
    });
    this.cancelButton.addEventListener('click', () => this.cancel());

    // --- Autres sources ---
    this.claudeButton.addEventListener('click', () => {
      // Le message est aussi copié : à coller si claude.ai s'ouvre sans lui (application mobile…).
      const cur = this.host.current();
      if (cur) void navigator.clipboard?.writeText(claudePrompt(cur.entry.title, cur.entry.artist)).catch(() => undefined);
      this.answerInput.hidden = false;
      this.addButton.hidden = false;
    });
    const fileButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Importer un fichier…');
    fileButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      if (files.length) void this.addFiles(files);
    });
    this.addButton.addEventListener('click', () => {
      const found = parseClaudeAnswer(this.answerInput.value);
      if (!found.length) {
        this.message('Aucun lien dans ce texte : collez la réponse complète de Claude.', true);
        return;
      }
      this.answerInput.value = '';
      void this.addFound(found);
    });
    this.answerInput.hidden = true;
    this.addButton.hidden = true;

    // Sans validation du navigateur : une adresse sans « https:// » est complétée par l'app.
    const proxyLink = h('button', { type: 'button', class: 'link-btn' }, 'Proxy des partitions…');
    proxyLink.addEventListener('click', () => openSettings('proxy'));
    this.moreBox.append(
      h('summary', {}, 'Autres sources'),
      h('p', { class: 'media__help' }, fr('Claude peut chercher d’autres transcriptions sur le web : envoyez-lui le message préparé, puis collez sa réponse ici.')),
      h('div', { class: 'media__row media__row--wrap' }, this.claudeButton, fileButton, this.fileInput),
      this.answerInput,
      h('div', { class: 'media__row media__row--end' }, this.addButton),
      h('p', { class: 'media__help' }, fr('Les liens d’autres sites passent par votre proxy : '), proxyLink),
    );
    this.sourcesBox.append(this.sourcesSummary, this.sourcesList);
    this.sourcesBox.hidden = true;

    this.element = h(
      'section',
      { class: 'media rhythm', hidden: true, 'aria-label': 'Rythme de la tablature', 'data-testid': 'rhythm-panel' },
      panelHead('Rythme', () => this.setOpen(false)),
      this.statusEl,
      this.detailEl,
      this.barsEl,
      this.decision,
      this.againButton,
      this.sourcesBox,
      this.moreBox,
      this.messageEl,
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Bouton visible seulement pour une tablature au rythme incertain (lue dans un PDF). */
  static applies(entry: ScoreEntry, score: Score, trackIndex: number): boolean {
    const track = score.tracks[trackIndex];
    const tab = !!track?.staves.some((s) => s.showTablature && s.tuning.length > 0);
    return tab && (entry.origin === 'pdf-tab' || entry.origin === 'pdf');
  }

  /** Nouvelle partition (ou piste) affichée. */
  load(entry: ScoreEntry, score: Score, trackIndex: number): void {
    this.session++;
    const applies = RhythmPanel.applies(entry, score, trackIndex);
    this.toggleButton.hidden = !applies;
    const key = `${entry.id}|${trackIndex}`;
    if (this.sourcesFor !== key) {
      this.sources = [];
      this.sourcesFor = key;
    }
    this.pending = null;
    this.state = 'idle';
    this.message(null);
    this.claudeButton.href = claudeLink(claudePrompt(entry.title, entry.artist));
    if (!applies) this.setOpen(false);
    else if (this.isOpen) void this.start();
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.element.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (open) {
      this.host.opened();
      void this.start();
    } else {
      // Panneau fermé : l'aperçu en cours est abandonné, une recherche en cours aussi.
      if (this.pending) this.cancel();
      if (this.state === 'busy') {
        this.session++;
        this.state = 'idle';
        this.sources = [];
      }
      this.host.markBars([]);
    }
  }

  /** Partition quittée. */
  close(): void {
    this.session++;
    this.pending = null;
    this.state = 'idle';
  }

  // --- Recherche ------------------------------------------------------------------

  private context(): { entry: ScoreEntry; score: Score; trackIndex: number; events: ScoreEvent[]; tab: Onset[] } | null {
    const cur = this.host.current();
    if (!cur) return null;
    const events = scoreEvents(cur.score, cur.trackIndex);
    return { ...cur, events, tab: tabOnsets(events) };
  }

  /** Ouverture : résultat déjà calculé, ou recherche automatique. */
  private async start(): Promise<void> {
    if (this.state === 'busy' || this.state === 'result') return;
    const ctx = this.context();
    if (!ctx) return;
    if (hasRepeats(ctx.score)) {
      this.show('Cette tablature contient des reprises : le rythme ne peut pas encore être retrouvé.', null);
      return;
    }
    if (ctx.events.length < MIN_ONSETS) {
      this.show('Pas assez de notes sur cette piste pour retrouver le rythme.', null);
      return;
    }
    if (this.sources.length) {
      await this.showResult();
      return;
    }
    const kept = ctx.entry.rhythm;
    if (kept && this.state === 'idle') {
      this.showKept(kept);
      return;
    }
    await this.searchAll();
  }

  /** Recherche automatique : BitMidi, puis chaque fichier trouvé est lu et aligné. */
  private async searchAll(): Promise<void> {
    const ctx = this.context();
    if (!ctx) return;
    const session = ++this.session;
    this.state = 'busy';
    this.message(null);
    this.show('Recherche de transcriptions…', null);
    const found = await searchBitMidi(ctx.entry.title, ctx.entry.artist).catch(() => [] as Found[]);
    if (session !== this.session) return;
    await this.analyze(found, session);
  }

  private async analyze(found: Found[], session: number, files: File[] = []): Promise<void> {
    const ctx = this.context();
    if (!ctx) return;
    let at: AlphaTabModule;
    try {
      at = await loadAlphaTab();
    } catch (error) {
      this.state = 'idle';
      this.message(describeError(error), true);
      return;
    }
    const items = [...foundItems(found, proxyUrl()), ...fileItems(files)];
    const result = await collectSources(
      at,
      ctx.tab,
      items,
      (n, total) => this.show(`Analyse des transcriptions… ${n}/${total}`, null),
      () => session === this.session,
    );
    if (!result) return;
    const labels = new Set(result.sources.map((s) => s.label));
    this.sources = [...this.sources.filter((s) => !labels.has(s.label)), ...result.sources];
    this.state = 'idle';
    await this.showResult();
    if (result.failures.length) this.message(result.failures.join(' '), true);
  }

  /** Sources déjà confrontées à la tablature affichée (pour l'enrichissement). */
  currentSources(): readonly AlignedSource[] {
    return this.sources;
  }

  private async addFound(found: Found[]): Promise<void> {
    const session = ++this.session;
    this.state = 'busy';
    this.discardPreview();
    await this.analyze(found, session);
  }

  private async addFiles(files: File[]): Promise<void> {
    const session = ++this.session;
    this.state = 'busy';
    this.discardPreview();
    await this.analyze([], session, files);
  }

  // --- Résultat -------------------------------------------------------------------

  private show(status: string, detail: string | null): void {
    this.statusEl.textContent = fr(status);
    this.detailEl.textContent = detail ? fr(detail) : '';
    this.detailEl.hidden = !detail;
    this.barsEl.replaceChildren();
    this.barsEl.hidden = true;
    this.decision.hidden = true;
    this.againButton.hidden = true;
    this.host.markBars([]);
    this.renderSources();
  }

  private renderSources(): void {
    const items = this.sources.map((s) => {
      const used = s.used;
      const track = trackName(s);
      const text = used
        ? `${s.label}${track ? ` — ${track}` : ''}`
        : `${s.label}${NB}: ne contient pas cette tablature`;
      return h('li', { class: used ? 'rhythm__source is-used' : 'rhythm__source' }, h('span', { 'aria-hidden': 'true' }, used ? '✓' : '–'), ` ${text}`);
    });
    this.sourcesList.replaceChildren(...items);
    this.sourcesSummary.textContent = `Sources (${this.sources.filter((s) => s.used).length}/${this.sources.length})`;
    this.sourcesBox.hidden = !this.sources.length;
  }

  private renderBars(bars: readonly number[], label: string): void {
    this.barsEl.replaceChildren(
      h('span', { class: 'media__help' }, fr(label)),
      ...bars.map((b) => {
        const chip = h('button', { type: 'button', class: 'toggle rhythm__bar', 'aria-label': `Écouter la mesure ${b + 1}` }, String(b + 1));
        chip.addEventListener('click', () => this.host.selectBar(b));
        return chip;
      }),
    );
    this.barsEl.hidden = !bars.length;
    this.host.markBars(bars);
  }

  private async showResult(): Promise<void> {
    const ctx = this.context();
    if (!ctx) return;
    const result = combine(ctx.events, this.sources);
    if (!result) {
      this.state = 'none';
      this.discardPreview();
      this.show(
        this.sources.length ? 'Aucune transcription trouvée ne contient cette tablature.' : 'Aucune transcription trouvée.',
        'Ajoutez-en d’autres : Claude peut en chercher sur le web, ou importez un fichier.',
      );
      this.moreBox.open = true;
      return;
    }
    let preview: Score;
    let xml: string;
    try {
      const at = await loadAlphaTab();
      xml = rewriteTab(ctx.score, ctx.trackIndex, ctx.events, result.positions, result.tempo, result.time).xml;
      preview = parseScore(at, new TextEncoder().encode(xml), true);
    } catch (error) {
      this.state = 'none';
      this.show('Réécriture impossible.', null);
      this.message(describeError(error), true);
      return;
    }
    this.pending = { xml, consensus: result };
    this.state = 'result';
    this.host.preview(preview);

    const n = result.sources.length;
    const notes = result.positions.length;
    const sure = Math.round((result.counts.sure / notes) * 100);
    const status =
      n > 1 ? `Rythme trouvé : ${n} transcriptions, d’accord sur ${sure}${NB}% des notes.` : 'Rythme trouvé dans une transcription.';
    const detail =
      n > 1
        ? 'Aperçu : écoutez (Lire), puis gardez ou annulez. Les notes restent celles de votre tablature.'
        : 'Une seule source : rien pour le confirmer. Écoutez l’aperçu (Lire), puis gardez ou annulez.';
    this.show(status, detail);
    const bars = result.doubtfulBars;
    this.renderBars(bars, bars.length ? `${plural(bars.length, 'mesure')} à vérifier${NB}:` : '');
    this.decision.hidden = false;
  }

  private showKept(kept: NonNullable<ScoreEntry['rhythm']>): void {
    const n = kept.sources.length;
    this.show(`Rythme repris de ${plural(n, 'transcription')}.`, null);
    this.renderBars(kept.doubtfulBars, kept.doubtfulBars.length ? `À vérifier${NB}:` : '');
    this.againButton.hidden = false;
  }

  private async keep(): Promise<void> {
    const pending = this.pending;
    const ctx = this.host.current();
    if (!pending || !ctx) return;
    const { entry } = ctx;
    this.pending = null;
    this.state = 'idle';
    // La tablature réécrite devient la référence : les sources seront confrontées à elle.
    this.sources = [];
    entry.rhythm = { sources: pending.consensus.sources, doubtfulBars: pending.consensus.doubtfulBars, at: Date.now() };
    entry.settings.selection = null;
    // Mesures nouvelles : un calage sur une vidéo ne correspond plus.
    delete entry.sync;
    entry.settings.followMedia = false;
    this.decision.hidden = true;
    try {
      await this.host.commit(entry, new TextEncoder().encode(pending.xml));
      this.message('Rythme gardé.');
    } catch (error) {
      this.message(describeError(error), true);
    }
  }

  private cancel(): void {
    this.discardPreview();
    this.state = 'none';
    this.show('Aperçu annulé : la tablature n’a pas changé.', null);
  }

  private discardPreview(): void {
    if (!this.pending) return;
    this.pending = null;
    this.host.preview(null);
    this.host.markBars([]);
  }

  private message(text: string | null, problem = false): void {
    this.messageEl.textContent = text ? fr(text) : '';
    this.messageEl.hidden = !text;
    this.messageEl.classList.toggle('is-problem', problem);
  }
}
