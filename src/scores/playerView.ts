import { setAudioSession } from '../audio/context';
import { allowSleep, keepAwake } from '../shell/wakeLock';
import { h } from '../ui/dom';
import { describeError } from '../ui/errors';
import { bindHoldRepeat } from '../ui/hold';
import { ASSET_BASE, type AlphaTabModule, type Api, type Score, loadAlphaTab, scoreColors } from './alphatab';
import type { ScoreEntry, ScoreSettings, StoredSelection } from './library';
import { type Passage, SelectionController } from './selection';

const MIN_SPEED = 0.25;
const MAX_SPEED = 1;
const SPEED_STEP = 0.05;
const NB = ' ';

interface PlayerDeps {
  /** Retour à la bibliothèque. */
  onBack: () => void;
  /** Réglages modifiés (vitesse, boucle, sélection…) : à enregistrer. */
  onSettingsChange: (entry: ScoreEntry) => void;
}

const isCoarsePointer = (): boolean => window.matchMedia('(pointer: coarse)').matches;
const scaleForWidth = (): number => (window.innerWidth < 600 ? 0.8 : 1);

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function barLabel(passage: Passage): string {
  const first = passage.start.voice.bar.index + 1;
  const last = passage.end.voice.bar.index + 1;
  return first === last ? `Mesure ${first}` : `Mesures ${first} à ${last}`;
}

/**
 * Écran de lecture : partition + tablature (alphaTab), sélection d'un passage,
 * lecture en boucle et vitesse de 25 à 100 %.
 */
export class ScorePlayerView {
  readonly element: HTMLElement;

  private at: AlphaTabModule | null = null;
  private api: Api | null = null;
  private selection: SelectionController | null = null;
  private entry: ScoreEntry | null = null;
  private score: Score | null = null;
  private pendingSelection: StoredSelection | null = null;
  private playing = false;
  private loadingSound = false;
  private currentScale = scaleForWidth();

  private readonly titleEl = h('p', { class: 'player__title' });
  private readonly artistEl = h('p', { class: 'player__artist' });
  private readonly trackSelect = h('select', { class: 'player__track-select', 'aria-label': 'Piste affichée' });
  private readonly trackLabel = h('label', { class: 'player__track', hidden: true }, this.trackSelect);
  private readonly noticeEl = h('p', { class: 'player__notice', hidden: true });
  private readonly alertEl = h('p', { class: 'alert', role: 'alert', hidden: true });
  private readonly statusEl = h('p', { class: 'player__status', role: 'status' });
  private readonly surface = h('div', { class: 'player__surface' });
  private readonly scroller = h('div', { class: 'player__score' }, this.surface);
  private readonly selectionLabel = h('span', { class: 'player__sel-label', 'data-testid': 'selection-label' });
  private readonly timeEl = h('span', { class: 'player__time', 'data-testid': 'time' });
  private readonly clearButton = h('button', { type: 'button', class: 'btn btn--small', hidden: true }, 'Effacer');
  private readonly barsToggle = h(
    'button',
    { type: 'button', class: 'toggle', 'aria-pressed': 'true', title: 'Sélectionner des mesures entières (sinon, note par note)' },
    'Par mesure',
  );
  private readonly loopToggle = h('button', { type: 'button', class: 'toggle', 'aria-pressed': 'true' }, 'Boucle');
  private readonly speedValue = h('output', { class: 'stepper__value', 'data-testid': 'speed' });
  private readonly speedMinus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Ralentir de 5 %' }, '−');
  private readonly speedPlus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Accélérer de 5 %' }, '+');
  private readonly rewindButton = h('button', { type: 'button', class: 'btn btn--rewind', 'aria-label': 'Revenir au début du passage' }, 'Début');
  private readonly playButton = h('button', { type: 'button', class: 'btn btn--primary', 'aria-pressed': 'false', disabled: true }, 'Lire');

  constructor(private readonly deps: PlayerDeps) {
    const back = h(
      'button',
      { type: 'button', class: 'btn btn--ghost player__back', 'aria-label': 'Retour à la bibliothèque' },
      '‹ Bibliothèque',
    );
    back.addEventListener('click', () => deps.onBack());

    this.element = h(
      'div',
      { class: 'player' },
      h(
        'div',
        { class: 'player__bar' },
        back,
        h('div', { class: 'player__heading' }, this.titleEl, this.artistEl),
        this.trackLabel,
      ),
      this.noticeEl,
      this.alertEl,
      h('div', { class: 'player__stage' }, this.scroller, this.statusEl),
      h(
        'div',
        { class: 'player__controls' },
        h('div', { class: 'player__row player__row--selection' }, this.selectionLabel, this.timeEl, this.clearButton),
        h(
          'div',
          { class: 'player__row player__row--options' },
          this.barsToggle,
          this.loopToggle,
          h(
            'div',
            { class: 'stepper__controls player__speed', role: 'group', 'aria-label': 'Vitesse de lecture' },
            this.speedMinus,
            this.speedValue,
            this.speedPlus,
          ),
        ),
        h('div', { class: 'player__row player__row--transport' }, this.rewindButton, this.playButton),
      ),
    );

    this.trackSelect.addEventListener('change', () => this.changeTrack(Number(this.trackSelect.value)));
    this.clearButton.addEventListener('click', () => this.selection?.clear());
    this.barsToggle.addEventListener('click', () => this.updateSettings({ wholeBars: !this.settings.wholeBars }));
    this.loopToggle.addEventListener('click', () => this.updateSettings({ loop: !this.settings.loop }));
    bindHoldRepeat(this.speedMinus, () => this.updateSettings({ speed: this.settings.speed - SPEED_STEP }));
    bindHoldRepeat(this.speedPlus, () => this.updateSettings({ speed: this.settings.speed + SPEED_STEP }));
    this.rewindButton.addEventListener('click', () => this.api?.stop());
    this.playButton.addEventListener('click', () => this.togglePlayback());

    document.addEventListener('themechange', () => this.applyTheme());
    window.addEventListener('resize', () => this.applyScale());
    this.renderSelection(null);
  }

  private get settings(): ScoreSettings {
    return (this.entry as ScoreEntry).settings;
  }

  /** Ouvre une partition déjà lue par alphaTab. */
  async open(entry: ScoreEntry, score: Score, notice: string | null): Promise<void> {
    this.entry = entry;
    this.score = score;
    this.pendingSelection = entry.settings.selection;
    this.titleEl.textContent = entry.title;
    this.artistEl.textContent = entry.artist;
    this.artistEl.hidden = !entry.artist;
    this.noticeEl.textContent = notice ?? '';
    this.noticeEl.hidden = !notice;
    this.showAlert(null);
    this.status('Mise en page de la partition…');

    const trackIndex = Math.min(Math.max(0, entry.settings.trackIndex), score.tracks.length - 1);
    this.trackSelect.replaceChildren(
      ...score.tracks.map((track, i) =>
        h('option', { value: i, selected: i === trackIndex }, track.name || `Piste ${i + 1}`),
      ),
    );
    this.trackLabel.hidden = score.tracks.length < 2;

    try {
      const at = await loadAlphaTab();
      const api = this.ensureApi(at);
      // Oublie le passage de la partition précédente (le lecteur garde sa plage en mémoire).
      api.pause();
      this.selection?.forget();
      this.renderSelection(null);
      this.renderSettings();
      api.renderScore(score, [trackIndex]);
      api.playbackSpeed = entry.settings.speed;
      api.isLooping = entry.settings.loop;
    } catch (error) {
      this.status(null);
      this.showAlert(describeError(error));
    }
  }

  /** Met la lecture en pause (accordeur ouvert, etc.). */
  pause(): void {
    if (this.playing) this.api?.pause();
  }

  // --- alphaTab ----------------------------------------------------------------

  private ensureApi(at: AlphaTabModule): Api {
    if (this.api) return this.api;
    this.at = at;
    const api = new at.AlphaTabApi(this.surface, {
      core: {
        fontDirectory: `${ASSET_BASE}font/`,
        logLevel: at.LogLevel.Warning,
      },
      display: {
        layoutMode: at.LayoutMode.Page,
        staveProfile: at.StaveProfile.Default,
        scale: this.currentScale,
        padding: [12, 12],
        resources: scoreColors(),
      },
      player: {
        playerMode: at.PlayerMode.EnabledSynthesizer,
        soundFont: `${ASSET_BASE}soundfont/sonivox.sf3`,
        scrollElement: this.scroller,
        scrollOffsetY: -24,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableElementHighlighting: true,
        // Sélection gérée par SelectionController (souris ET doigt).
        enableUserInteraction: false,
      },
    });
    this.api = api;

    this.selection = new SelectionController({
      at,
      api,
      host: this.surface,
      scroller: this.scroller,
      wholeBars: () => this.entry?.settings.wholeBars ?? true,
      onPreview: (passage) => this.renderSelection(passage ?? this.selection?.current ?? null, true),
      onChange: (passage) => this.onSelectionChange(passage),
      onLongPress: () => {
        this.selectionLabel.textContent = "Glissez jusqu'à la fin du passage";
      },
    });

    // alphaTab redessine lui-même la sélection après chaque rendu ; on ne restaure que
    // celle enregistrée, une fois, à l'ouverture.
    api.renderFinished.on(() => {
      if (this.pendingSelection) {
        this.restoreSelection(this.pendingSelection);
        this.pendingSelection = null;
      }
      this.status(this.loadingSound ? this.statusEl.textContent : null);
    });
    api.soundFontLoad.on((e) => {
      this.loadingSound = true;
      const percent = e.total > 0 ? Math.round((e.loaded / e.total) * 100) : 0;
      this.status(`Chargement du son… ${percent}${NB}%`);
    });
    // « Prêt » est émis après le chargement du son PUIS après chaque rechargement de la musique
    // (changement de piste) : le synthétiseur repart alors d'un état neuf, on lui redonne
    // vitesse, boucle et passage. (On n'écoute pas midiLoaded : dans alphaTab 1.8.4, s'y abonner
    // provoque une récursion infinie dans AlphaSynthWebWorkerApi.loadedMidiInfo.)
    api.playerReady.on(() => {
      this.loadingSound = false;
      this.status(null);
      this.playButton.disabled = false;
      const settings = this.entry?.settings;
      if (settings) {
        api.playbackSpeed = settings.speed;
        api.isLooping = settings.loop;
      }
      this.selection?.reapply();
    });
    api.playerStateChanged.on((e) => {
      this.playing = e.state === at.synth.PlayerState.Playing;
      this.playButton.textContent = this.playing ? 'Pause' : 'Lire';
      this.playButton.setAttribute('aria-pressed', String(this.playing));
      if (this.playing) keepAwake('player');
      else allowSleep('player');
    });
    api.playerPositionChanged.on((e) => {
      this.timeEl.textContent = `${formatTime(e.currentTime)} / ${formatTime(e.endTime)}`;
    });
    api.error.on((error) => {
      console.error('alphaTab', error);
      this.status(null);
      this.showAlert("La partition n'a pas pu être affichée ou jouée. Rechargez la page, puis rouvrez-la.");
    });
    return api;
  }

  private togglePlayback(): void {
    const api = this.api;
    if (!api || !api.isReadyForPlayback) return;
    setAudioSession('playback');
    api.playPause();
  }

  private changeTrack(index: number): void {
    if (!this.api || !this.score || !this.entry) return;
    this.api.pause();
    this.selection?.forget();
    this.renderSelection(null);
    this.updateSettings({ trackIndex: index, selection: null });
    this.api.renderScore(this.score, [index]);
  }

  private applyTheme(): void {
    if (!this.api) return;
    this.api.settings.fillFromJson({ display: { resources: scoreColors() } });
    this.api.updateSettings();
    this.api.render();
  }

  private applyScale(): void {
    const scale = scaleForWidth();
    if (!this.api || scale === this.currentScale) return;
    this.currentScale = scale;
    this.api.settings.display.scale = scale;
    this.api.updateSettings();
    this.api.render();
  }

  // --- Sélection ---------------------------------------------------------------

  private restoreSelection(stored: StoredSelection): void {
    const bars = this.api?.tracks[0]?.staves[0]?.bars;
    const startBeat = bars?.[stored.startBar]?.voices[0]?.beats[stored.startBeat];
    const endBeat = bars?.[stored.endBar]?.voices[0]?.beats[stored.endBeat];
    if (startBeat && endBeat && this.selection) {
      this.selection.select(startBeat, endBeat, false);
      this.renderSelection(this.selection.current);
    }
  }

  private onSelectionChange(passage: Passage | null): void {
    this.renderSelection(passage);
    const stored: StoredSelection | null = passage
      ? {
          startBar: passage.start.voice.bar.index,
          startBeat: passage.start.index,
          endBar: passage.end.voice.bar.index,
          endBeat: passage.end.index,
        }
      : null;
    this.updateSettings({ selection: stored });
  }

  private renderSelection(passage: Passage | null, preview = false): void {
    if (passage) {
      this.selectionLabel.textContent = barLabel(passage);
      this.selectionLabel.classList.add('is-set');
    } else {
      this.selectionLabel.textContent = isCoarsePointer()
        ? 'Passage : appui long, puis glissez.'
        : 'Passage : cliquez-glissez sur la partition.';
      this.selectionLabel.classList.remove('is-set');
    }
    this.clearButton.hidden = preview || !this.selection?.current;
  }

  // --- Réglages ----------------------------------------------------------------

  private updateSettings(patch: Partial<ScoreSettings>): void {
    const entry = this.entry;
    if (!entry) return;
    const next = { ...entry.settings, ...patch };
    next.speed = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, next.speed)) * 100) / 100;
    entry.settings = next;
    if (this.api) {
      this.api.playbackSpeed = next.speed;
      this.api.isLooping = next.loop;
    }
    this.renderSettings();
    this.deps.onSettingsChange(entry);
  }

  private renderSettings(): void {
    const settings = this.entry?.settings;
    if (!settings) return;
    this.speedValue.textContent = `${Math.round(settings.speed * 100)}${NB}%`;
    this.speedMinus.disabled = settings.speed <= MIN_SPEED;
    this.speedPlus.disabled = settings.speed >= MAX_SPEED;
    this.loopToggle.setAttribute('aria-pressed', String(settings.loop));
    this.barsToggle.setAttribute('aria-pressed', String(settings.wholeBars));
  }

  private status(text: string | null): void {
    this.statusEl.textContent = text ?? '';
    this.statusEl.hidden = !text;
  }

  private showAlert(message: string | null): void {
    this.alertEl.textContent = message ?? '';
    this.alertEl.hidden = !message;
  }

  /** Accès de test (Playwright) : uniquement avec ?e2e dans l'adresse. */
  debugHandle(): { api: Api | null; at: AlphaTabModule | null } {
    return { api: this.api, at: this.at };
  }
}
