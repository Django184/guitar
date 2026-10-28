/**
 * « Enrichir » : propose d'ajouter à la tablature des notes prises dans les transcriptions du
 * morceau (basse, notes de l'accord, notes de passage), jouables et cohérentes (suggest.ts).
 * Désactivé par défaut. Les notes ajoutées s'affichent en couleur dans un aperçu ; chacune se
 * retire d'un appui, chaque famille d'un bouton ; « Garder » les écrit dans la tablature.
 */
import { h } from '../../ui/dom';
import { menuRow, panelHead } from '../../ui/sheet';
import { describeError } from '../../ui/errors';
import { type AlphaTabModule, type Score, loadAlphaTab, parseScore } from '../alphatab';
import type { ScoreEntry } from '../library';
import { type ScoreEvent, hasRepeats, rewriteTab, scoreEvents } from '../sync/scoreEvents';
import { collectSources, foundItems } from '../rhythm/collect';
import { type AlignedSource, tabOnsets } from '../rhythm/findRhythm';
import { proxyUrl, searchBitMidi } from '../rhythm/search';
import type { Ring } from './additionLayer';
import { type AddKind, type Addition, type GuitarSetup, applyAdditions, suggest } from './suggest';

const NB = ' ';
const fr = (text: string): string => text.replace(/ ([:;!?»])/g, `${NB}$1`).replace(/« /g, `«${NB}`);
const QUARTER = 960;

const KINDS: Array<{ kind: AddKind; label: string }> = [
  { kind: 'bass', label: 'Basse' },
  { kind: 'chord', label: 'Accords' },
  { kind: 'passing', label: 'Passages' },
];

/** Couleur des notes ajoutées dans l'aperçu (fret et tête de note), selon le thème. */
const ADDED_COLOR = { dark: '#5ccfc0', light: '#0f7a6c' };

export interface EmbellishHost {
  current(): { entry: ScoreEntry; score: Score; trackIndex: number } | null;
  /** Sources déjà retrouvées par le panneau « Rythme » pour cette tablature. */
  knownSources(): readonly AlignedSource[];
  preview(score: Score | null): void;
  commit(entry: ScoreEntry, xml: Uint8Array): Promise<void>;
  /** Anneaux des notes ajoutées (dessinés après le rendu de l'aperçu). */
  showRings(rings: readonly Ring[]): void;
  /** Le panneau s'ouvre : les autres se ferment. */
  opened(): void;
  theme(): 'dark' | 'light';
}

export class EmbellishPanel {
  readonly element: HTMLElement;
  readonly toggleButton: HTMLButtonElement;

  private session = 0;
  /** Sources trouvées ici (recherche automatique), pour la partition et la piste affichées. */
  private own: { score: Score; track: number; sources: AlignedSource[] } | null = null;
  private additions: Addition[] = [];
  private rejected = new Set<string>();
  private hiddenKinds = new Set<AddKind>();
  private xml = '';

  private readonly statusEl = h('p', { class: 'media__progress', role: 'status', 'data-testid': 'embellish-status' });
  private readonly helpEl = h('p', { class: 'media__help' });
  private readonly kindsEl = h('div', { class: 'media__row media__row--wrap', 'data-testid': 'embellish-kinds' });
  private readonly keepButton = h('button', { type: 'button', class: 'btn btn--small btn--accent', 'data-testid': 'embellish-keep' }, 'Garder');
  private readonly cancelButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Annuler');
  private readonly decision = h('div', { class: 'media__row', hidden: true }, this.keepButton, this.cancelButton);
  private readonly messageEl = h('p', { class: 'media__message', role: 'status' });

  constructor(private readonly host: EmbellishHost) {
    this.toggleButton = menuRow('Enrichir', 'Basse et accords jouables, pris dans des transcriptions.', { 'aria-expanded': 'false', 'data-testid': 'embellish-toggle' });
    this.toggleButton.hidden = true;
    this.toggleButton.addEventListener('click', () => this.setOpen(!this.isOpen));
    this.keepButton.addEventListener('click', () => void this.keep());
    this.cancelButton.addEventListener('click', () => this.setOpen(false));
    this.element = h(
      'section',
      { class: 'media embellish', hidden: true, 'aria-label': 'Enrichissement de la tablature', 'data-testid': 'embellish-panel' },
      panelHead('Enrichir', () => this.setOpen(false)),
      this.statusEl,
      this.helpEl,
      this.kindsEl,
      this.decision,
      this.messageEl,
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Nouvelle partition (ou piste) : désactivé, visible pour une tablature lue dans un PDF. */
  load(visible: boolean): void {
    this.toggleButton.hidden = !visible;
    if (this.isOpen) this.setOpen(false);
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.session++;
    this.element.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (open) {
      this.host.opened();
      void this.start();
    } else {
      if (this.additions.length) this.host.preview(null);
      this.host.showRings([]);
      this.additions = [];
    }
  }

  // --- Propositions -------------------------------------------------------------------

  private context(): { entry: ScoreEntry; score: Score; trackIndex: number; events: ScoreEvent[] } | null {
    const cur = this.host.current();
    if (!cur) return null;
    return { ...cur, events: scoreEvents(cur.score, cur.trackIndex) };
  }

  private guitar(score: Score, trackIndex: number): GuitarSetup | null {
    const staff = score.tracks[trackIndex]?.staves.find((s) => s.showTablature && s.tuning.length > 0);
    return staff ? { tuning: [...staff.tuning], capo: staff.capo } : null;
  }

  private async start(): Promise<void> {
    const session = this.session;
    const ctx = this.context();
    const guitar = ctx && this.guitar(ctx.score, ctx.trackIndex);
    this.message(null);
    this.decision.hidden = true;
    this.kindsEl.replaceChildren();
    if (!ctx || !guitar) return;
    if (hasRepeats(ctx.score)) {
      this.show('Cette tablature contient des reprises : pas encore possible.', null);
      return;
    }
    let at: AlphaTabModule;
    try {
      at = await loadAlphaTab();
    } catch (error) {
      this.message(describeError(error), true);
      return;
    }
    let sources = [...this.host.knownSources()];
    if (!sources.some((s) => s.used)) {
      // Alignements valables tant que la partition est la même (notes ajoutées : à refaire).
      const own = this.own;
      if (own && own.score === ctx.score && own.track === ctx.trackIndex) {
        sources = own.sources;
      } else {
        this.show('Recherche de transcriptions…', null);
        const found = await searchBitMidi(ctx.entry.title, ctx.entry.artist).catch(() => []);
        if (session !== this.session) return;
        const result = await collectSources(
          at,
          tabOnsets(ctx.events),
          foundItems(found, proxyUrl()),
          (n, total) => this.show(`Analyse des transcriptions… ${n}/${total}`, null),
          () => session === this.session,
        );
        if (!result) return;
        sources = result.sources;
        this.own = { score: ctx.score, track: ctx.trackIndex, sources };
      }
    }
    if (!sources.some((s) => s.used)) {
      this.show('Aucune transcription de ce morceau ne contient cette tablature.', 'Le panneau « Rythme » permet d’en ajouter (Claude, fichiers).');
      return;
    }
    this.additions = suggest(
      ctx.events,
      ctx.events.map((e) => e.start),
      guitar,
      sources,
    );
    this.rejected.clear();
    this.hiddenKinds.clear();
    if (!this.additions.length) {
      this.show('Rien à ajouter : les transcriptions n’ont pas d’autre note jouable ici.', null);
      return;
    }
    this.render(at);
  }

  private accepted(): Addition[] {
    return this.additions.filter((a) => !this.rejected.has(a.id) && !this.hiddenKinds.has(a.kind));
  }

  /** Aperçu avec les notes acceptées, en couleur. */
  private render(at: AlphaTabModule): void {
    const ctx = this.context();
    const guitar = ctx && this.guitar(ctx.score, ctx.trackIndex);
    if (!ctx || !guitar) return;
    const accepted = this.accepted();
    const merged = applyAdditions(ctx.events, ctx.events.map((e) => e.start), accepted, guitar);
    let preview: Score;
    try {
      const master = ctx.score.masterBars[0];
      this.xml = rewriteTab(ctx.score, ctx.trackIndex, merged.events, merged.positions, ctx.score.tempo, {
        beats: master?.timeSignatureNumerator ?? 4,
        beatType: master?.timeSignatureDenominator ?? 4,
      }).xml;
      preview = parseScore(at, new TextEncoder().encode(this.xml), true);
    } catch (error) {
      this.show('Aperçu impossible.', null);
      this.message(describeError(error), true);
      return;
    }
    const rings = this.colorize(at, preview, accepted, guitar.tuning.length);
    this.host.preview(preview);
    this.host.showRings(rings);

    const count = accepted.length;
    this.show(
      count ? `${count}${NB}note${count > 1 ? 's' : ''} ajoutée${count > 1 ? 's' : ''}, en couleur.` : 'Aucune note ajoutée.',
      'Écoutez l’aperçu (Lire). Touchez une note ajoutée pour la retirer, puis gardez ou annulez.',
    );
    this.kindsEl.replaceChildren(
      ...KINDS.filter(({ kind }) => this.additions.some((a) => a.kind === kind)).map(({ kind, label }) => {
        const all = this.additions.filter((a) => a.kind === kind);
        const on = !this.hiddenKinds.has(kind);
        const kept = on ? all.filter((a) => !this.rejected.has(a.id)).length : 0;
        const chip = h('button', { type: 'button', class: `toggle embellish__kind embellish--${kind}`, 'aria-pressed': String(on) }, `${label} ${kept}/${all.length}`);
        chip.addEventListener('click', () => {
          if (on) this.hiddenKinds.add(kind);
          else {
            this.hiddenKinds.delete(kind);
            for (const a of all) this.rejected.delete(a.id);
          }
          this.render(at);
        });
        return chip;
      }),
    );
    this.decision.hidden = false;
    this.keepButton.disabled = !count;
  }

  /** Notes ajoutées en couleur dans l'aperçu ; renvoie les anneaux à dessiner. */
  private colorize(at: AlphaTabModule, score: Score, accepted: readonly Addition[], strings: number): Ring[] {
    const staff = score.tracks[0]?.staves.find((s) => s.showTablature && s.tuning.length > 0);
    if (!staff) return [];
    const color = at.model.Color.fromJson(ADDED_COLOR[this.host.theme()]);
    const byKey = new Map<string, Addition>(accepted.map((a) => [`${Math.round(a.start * QUARTER)}:${strings - a.hit.string + 1}`, a]));
    const rings: Ring[] = [];
    for (const bar of staff.bars) {
      const master = score.masterBars[bar.index];
      if (!master) continue;
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            if (note.isTieDestination) continue;
            const a = byKey.get(`${master.start + beat.playbackStart}:${note.string}`);
            if (!a) continue;
            const style = new at.model.NoteStyle();
            style.colors.set(at.model.NoteSubElement.GuitarTabFretNumber, color);
            style.colors.set(at.model.NoteSubElement.StandardNotationNoteHead, color);
            note.style = style;
            rings.push({ id: a.id, kind: a.kind, note });
          }
        }
      }
    }
    return rings;
  }

  /** Appui sur une note ajoutée : retirée de l'aperçu. */
  toggle(id: string): void {
    if (!this.isOpen || !this.additions.some((a) => a.id === id)) return;
    this.rejected.add(id);
    void loadAlphaTab().then((at) => this.render(at));
  }

  /** Partition quittée : tout s'arrête, sans revenir à la partition enregistrée. */
  close(): void {
    this.session++;
    this.additions = [];
    this.element.hidden = true;
    this.toggleButton.setAttribute('aria-expanded', 'false');
  }

  private async keep(): Promise<void> {
    const ctx = this.host.current();
    if (!ctx || !this.accepted().length) return;
    const xml = this.xml;
    this.session++;
    this.additions = [];
    this.element.hidden = true;
    this.toggleButton.setAttribute('aria-expanded', 'false');
    this.host.showRings([]);
    ctx.entry.settings.selection = null;
    try {
      await this.host.commit(ctx.entry, new TextEncoder().encode(xml));
    } catch (error) {
      this.element.hidden = false;
      this.message(describeError(error), true);
    }
  }

  private show(status: string, help: string | null): void {
    this.statusEl.textContent = fr(status);
    this.helpEl.textContent = help ? fr(help) : '';
    this.helpEl.hidden = !help;
  }

  private message(text: string | null, problem = false): void {
    this.messageEl.textContent = text ? fr(text) : '';
    this.messageEl.hidden = !text;
    this.messageEl.classList.toggle('is-problem', problem);
  }
}
