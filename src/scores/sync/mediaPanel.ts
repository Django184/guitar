/**
 * Panneau « Vidéo » du lecteur : choisir l'enregistrement de référence (recherche YouTube,
 * lien collé, fichier audio ou vidéo), le jouer, et caler la partition dessus — en tapant chaque
 * note pendant l'écoute, ou par écoute automatique. Le son d'une vidéo YouTube arrive à l'analyse
 * sans micro ni haut-parleurs : son de l'onglet (Chrome / Edge sur ordinateur) ou enregistrement
 * d'écran importé (iPhone, Android), dont seul le son est gardé.
 * Pour une tablature texte (rythme deviné), le calage réécrit le rythme ; pour une autre
 * partition, il sert seulement à suivre l'enregistrement pendant la lecture.
 */
import { unlockAudio } from '../../audio/context';
import { closeMicrophone, openMicrophone } from '../../audio/microphone';
import { h } from '../../ui/dom';
import { openSettings } from '../../shell/settings';
import { menuRow, panelHead } from '../../ui/sheet';
import { describeError } from '../../ui/errors';
import { type AlphaTabModule, type Score, parseScore } from '../alphatab';
import { type MediaLink, type ScoreEntry, mediaKey } from '../library';
import { alignAudio } from './audioAlign';
import { CaptureError, canCaptureTab, isAndroid, isIOS, openTabAudio } from './capture';
import { AudioFileMedia, type ReferenceMedia, decodeAudio } from './media';
import { PcmRecorder, type Recording } from './recorder';
import { barSyncPoints, fitRhythm, scalePositions, type SyncPoint } from './rhythmFit';
import { type ScoreEvent, barLength, fitEvents, hasRepeats, rewriteTab, scoreEvents, syncFromTimes } from './scoreEvents';
import { encodeWav, isVideoFile, peakOf, trimSilence, videoAudio } from './videoAudio';
import {
  SearchError,
  type VideoResult,
  YouTubeMedia,
  parseYouTubeUrl,
  searchQuery,
  searchYouTube,
  youtubeKey,
  youtubeSearchUrl,
} from './youtube';

const NB = '\u00a0';
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
/** Son extrait d'une vidéo : WAV mono à 32 kHz (3,8 Mo par minute, son quasi intact). */
const VIDEO_AUDIO_RATE = 32000;
const MAX_VIDEO_MINUTES = Math.floor(MAX_AUDIO_BYTES / (VIDEO_AUDIO_RATE * 2) / 60);

/** Typographie française : espace insécable avant « : ; ! ? » et à l'intérieur des guillemets. */
const fr = (text: string): string => text.replace(/ ([:;!?»])/g, `${NB}$1`).replace(/« /g, `«${NB}`);
const help = (text: string): HTMLElement => h('p', { class: 'media__help' }, fr(text));

type Source = 'tab' | 'mic';

const IMPORT_HELP = {
  ios:
    'Sur iPhone : Centre de contrôle → Enregistrement de l’écran (micro coupé), jouez la vidéo ici ou dans l’app YouTube jusqu’à la fin du passage, arrêtez l’enregistrement, puis choisissez-le ici (Photothèque). L’app n’en garde que le son, sur cet appareil, à la place de la vidéo.',
  android:
    'Sur Android : lancez l’enregistreur d’écran avec le son de l’appareil (« Sons multimédias », pas le micro), jouez la vidéo jusqu’à la fin du passage, puis choisissez l’enregistrement ici. L’app n’en garde que le son, sur cet appareil, à la place de la vidéo.',
  other: 'Ou choisissez une vidéo (enregistrement d’écran) ou un fichier son du morceau : l’app n’en garde que le son, sur cet appareil, à la place de la vidéo.',
};

export interface MediaPanelHost {
  current(): { entry: ScoreEntry; score: Score; trackIndex: number } | null;
  alphaTab(): AlphaTabModule | null;
  saveEntry(entry: ScoreEntry): void;
  loadMediaFile(entry: ScoreEntry): Promise<Uint8Array | undefined>;
  saveMediaFile(entry: ScoreEntry, bytes: Uint8Array | null): Promise<void>;
  /** Nouveau lecteur de référence (ou plus aucun). */
  mediaChanged(media: ReferenceMedia | null): void;
  /** Lecture de la partition avec l'enregistrement (si le calage existe). */
  setFollow(on: boolean): void;
  /** Calage d'une partition au rythme juste : points de synchronisation à appliquer. */
  applySync(points: SyncPoint[]): void;
  /** Aperçu d'une partition réécrite ; null : retour à la partition enregistrée. */
  preview(score: Score | null): void;
  /** Garde la partition réécrite (MusicXML) et la rouvre. */
  commit(entry: ScoreEntry, xml: Uint8Array): Promise<void>;
  /** Début de la sélection, en noires depuis le début ; null sans sélection. */
  selectionStart(): number | null;
  /** Place le curseur de la partition (en noires). */
  cursorTo(quarters: number): void;
  speed(): number;
  stopPlayback(): void;
}

type Task = 'idle' | 'tap' | 'listen' | 'analyze' | 'result';

interface Pending {
  events: ScoreEvent[];
  times: Array<number | null>;
  positions: number[];
  tempo: number;
  xml: string;
  points: SyncPoint[];
  matched: number | null;
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class MediaPanel {
  readonly element: HTMLElement;
  readonly toggleButton: HTMLButtonElement;

  private media: ReferenceMedia | null = null;
  private mediaFor: string | null = null;
  private task: Task = 'idle';
  private pending: Pending | null = null;
  private results: VideoResult[] = [];
  private searchedFor: string | null = null;
  private recorder: PcmRecorder | null = null;
  /** Fichier choisi depuis l'écoute automatique : l'analyser dès qu'il est lié. */
  private listenAfterImport = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Numéro de la tâche en cours : les écouteurs d'une tâche terminée n'agissent plus. */
  private session = 0;

  // Choix de l'enregistrement.
  private readonly picker = h('div', { class: 'media__picker' });
  private readonly queryInput = h('input', { type: 'search', class: 'media__input', 'aria-label': 'Rechercher une vidéo', enterkeyhint: 'search' });
  private readonly searchButton = h('button', { type: 'submit', class: 'btn btn--small' }, 'Rechercher');
  private readonly resultsList = h('ul', { class: 'media__results', 'data-testid': 'media-results' });
  private readonly linkInput = h('input', { type: 'url', class: 'media__input', placeholder: 'Coller un lien YouTube', 'aria-label': 'Lien YouTube', inputmode: 'url' });
  private readonly youtubeLink = h('a', { class: 'btn btn--small btn--link', target: '_blank', rel: 'noopener noreferrer' }, 'Chercher sur YouTube');
  private readonly fileInput = h('input', {
    type: 'file',
    accept: 'audio/*,video/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,.mp4,.mov,.m4v',
    hidden: true,
    'data-testid': 'media-file',
  });
  /** Clé YouTube : réglée dans la feuille « Réglages ». */
  private readonly keyLink = h('button', { type: 'button', class: 'link-btn' }, 'Clé YouTube…');
  private readonly unlinkButton = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, 'Retirer le lien');
  private readonly backButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Retour');

  // Enregistrement lié.
  private readonly linked = h('div', { class: 'media__linked' });
  private readonly frame = h('div', { class: 'media__frame' });
  private readonly titleEl = h('p', { class: 'media__title' });
  private readonly followToggle = h('button', { type: 'button', class: 'toggle', 'aria-pressed': 'false', 'data-testid': 'media-follow' }, 'Suivre la vidéo');
  private readonly tapButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Taper le rythme');
  private readonly listenButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Écoute automatique');
  private readonly actions = h('div', { class: 'media__row media__actions' });

  // Tâche en cours (calage) et messages.
  private readonly taskEl = h('div', { class: 'media__task', hidden: true, 'data-testid': 'media-task' });
  private readonly messageEl = h('p', { class: 'media__message', role: 'status', 'data-testid': 'media-message' });

  constructor(private readonly host: MediaPanelHost) {
    this.toggleButton = menuRow('Vidéo de référence', 'Suivre un enregistrement pendant la lecture.', { 'aria-expanded': 'false', 'data-testid': 'media-toggle' });
    this.toggleButton.addEventListener('click', () => this.setOpen(this.toggleButton.getAttribute('aria-expanded') !== 'true'));

    // --- Sélecteur ---
    const searchForm = h('form', { class: 'media__row', role: 'search' }, this.queryInput, this.searchButton);
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search(this.queryInput.value);
    });
    const linkForm = h('form', { class: 'media__row' }, this.linkInput, h('button', { type: 'submit', class: 'btn btn--small' }, 'Lier'));
    linkForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.linkPasted(this.linkInput.value);
    });
    const fileButton = h('button', { type: 'button', class: 'btn btn--small' }, 'Fichier audio ou vidéo…');
    fileButton.addEventListener('click', () => {
      this.listenAfterImport = false;
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      const listen = this.listenAfterImport;
      this.listenAfterImport = false;
      this.fileInput.value = '';
      if (file) void this.linkFile(file, listen);
    });
    this.keyLink.addEventListener('click', () => openSettings('youtube'));
    this.unlinkButton.addEventListener('click', () => void this.unlink());
    this.backButton.addEventListener('click', () => this.showLinked());
    this.picker.append(
      searchForm,
      this.resultsList,
      linkForm,
      h('div', { class: 'media__row media__row--wrap' }, fileButton, this.youtubeLink, this.fileInput),
      help('Une vidéo (un enregistrement d’écran, par exemple) : l’app n’en garde que le son, sur cet appareil.'),
      h('div', { class: 'media__row' }, this.keyLink),
      h('div', { class: 'media__row media__row--end' }, this.unlinkButton, this.backButton),
    );

    // --- Enregistrement lié ---
    const change = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, 'Changer');
    change.addEventListener('click', () => this.showPicker());
    this.followToggle.addEventListener('click', () => this.toggleFollow());
    this.tapButton.addEventListener('click', () => this.startTap());
    this.listenButton.addEventListener('click', () => void this.startListen());
    this.actions.append(this.followToggle, this.tapButton, this.listenButton);
    this.linked.append(this.frame, h('div', { class: 'media__row' }, this.titleEl, change), this.actions);

    this.element = h(
      'section',
      { class: 'media', hidden: true, 'aria-label': 'Enregistrement de référence', 'data-testid': 'media-panel' },
      panelHead('Vidéo de référence', () => this.setOpen(false)),
      this.picker,
      this.linked,
      this.taskEl,
      this.messageEl,
    );
  }

  // --- Ouverture d'une partition ------------------------------------------------

  /** Nouvelle partition ouverte : son enregistrement lié, s'il y en a un. */
  async load(entry: ScoreEntry): Promise<void> {
    this.endTask();
    this.results = [];
    this.searchedFor = null;
    this.message(null);
    const link = entry.media;
    if (!link) {
      this.setMedia(null, null);
      this.setOpen(false);
      this.showPicker();
      return;
    }
    if (this.mediaFor !== `${entry.id}|${mediaKey(link)}`) await this.createMedia(entry, link);
    this.showLinked();
    this.setOpen(true);
  }

  /** Lecteur courant (pour la lecture synchronisée). */
  get current(): ReferenceMedia | null {
    return this.media;
  }

  /** Le calage enregistré correspond-il à l'enregistrement lié ? */
  static syncValid(entry: ScoreEntry): boolean {
    return !!entry.media && !!entry.sync && entry.sync.media === mediaKey(entry.media) && entry.sync.points.length > 0;
  }

  /** Bouton « Suivre la vidéo » : état affiché. */
  renderFollow(): void {
    const entry = this.host.current()?.entry;
    const valid = !!entry && MediaPanel.syncValid(entry);
    this.followToggle.hidden = !valid;
    this.followToggle.setAttribute('aria-pressed', String(valid && !!entry?.settings.followMedia));
    this.followToggle.textContent = entry?.media?.kind === 'audio' ? 'Suivre l’enregistrement' : 'Suivre la vidéo';
  }

  private setOpen(open: boolean): void {
    this.element.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (open && !this.media && !this.picker.hidden) void this.autoSearch();
  }

  private setMedia(media: ReferenceMedia | null, key: string | null): void {
    if (this.media && this.media !== media) this.media.destroy();
    this.media = media;
    this.mediaFor = key;
    this.frame.replaceChildren(...(media ? [media.element] : []));
    this.host.mediaChanged(media);
  }

  private async createMedia(entry: ScoreEntry, link: MediaLink): Promise<void> {
    const key = `${entry.id}|${mediaKey(link)}`;
    this.titleEl.textContent = link.kind === 'youtube' ? link.title || 'Vidéo YouTube' : link.name;
    if (link.kind === 'youtube') {
      const { media, ready } = YouTubeMedia.create(link.id);
      this.setMedia(media, key);
      media.onState((state, message) => {
        if (state === 'error' && message) this.message(message, true);
      });
      try {
        await ready;
        const info = media.info;
        if (info.title && !link.title) {
          link.title = info.title;
          link.channel = info.channel;
          this.titleEl.textContent = info.title;
          this.host.saveEntry(entry);
        }
      } catch (error) {
        this.message(error instanceof Error ? error.message : describeError(error), true);
      }
    } else {
      const bytes = await this.host.loadMediaFile(entry).catch(() => undefined);
      if (!bytes) {
        this.setMedia(null, null);
        this.message('Le fichier audio lié n’est plus disponible : choisissez-le à nouveau.', true);
        return;
      }
      const media = new AudioFileMedia(bytes, link.type);
      media.onState((state, message) => {
        if (state === 'error' && message) this.message(message, true);
      });
      this.setMedia(media, key);
    }
  }

  // --- Choix de l'enregistrement --------------------------------------------------

  private showPicker(): void {
    const entry = this.host.current()?.entry;
    this.picker.hidden = false;
    this.linked.hidden = true;
    this.unlinkButton.hidden = !entry?.media;
    this.backButton.hidden = !entry?.media || !this.media;
    const query = entry ? searchQuery(entry.title, entry.artist) : '';
    if (!this.queryInput.value || this.searchedFor === null) this.queryInput.value = query;
    this.youtubeLink.href = youtubeSearchUrl(this.queryInput.value || query);
    this.renderResults();
    if (!this.element.hidden) void this.autoSearch();
  }

  private showLinked(): void {
    if (!this.media) {
      this.showPicker();
      return;
    }
    this.picker.hidden = true;
    this.linked.hidden = false;
    this.renderFollow();
  }

  private async autoSearch(): Promise<void> {
    if (this.searchedFor !== null || !youtubeKey()) {
      if (!youtubeKey()) this.message('Collez le lien d’une vidéo, ou ajoutez une clé YouTube pour la recherche automatique.');
      return;
    }
    await this.search(this.queryInput.value);
  }

  private async search(query: string): Promise<void> {
    const q = query.trim();
    this.youtubeLink.href = youtubeSearchUrl(q);
    const key = youtubeKey();
    if (!q) return;
    if (!key) {
      this.message('La recherche automatique demande une clé YouTube (Réglages) ; sinon, cherchez sur YouTube et collez le lien.');
      return;
    }
    this.searchedFor = q;
    this.searchButton.disabled = true;
    this.message('Recherche…');
    try {
      this.results = await searchYouTube(q, key);
      this.message(this.results.length ? null : 'Aucune vidéo trouvée : modifiez la recherche ou collez un lien.');
    } catch (error) {
      this.results = [];
      this.message(error instanceof SearchError ? error.message : 'Recherche impossible pour le moment.', true);
    } finally {
      this.searchButton.disabled = false;
    }
    this.renderResults();
  }

  private renderResults(): void {
    const current = this.host.current()?.entry.media;
    this.resultsList.replaceChildren(
      ...this.results.map((v) => {
        const button = h(
          'button',
          { type: 'button', class: 'media__result', 'aria-pressed': String(current?.kind === 'youtube' && current.id === v.id) },
          v.thumbnail ? h('img', { src: v.thumbnail, alt: '', loading: 'lazy', width: 96, height: 54 }) : '',
          h('span', { class: 'media__result-text' }, h('span', { class: 'media__result-title' }, v.title), h('span', { class: 'media__result-channel' }, v.channel)),
        );
        button.addEventListener('click', () => void this.link({ kind: 'youtube', id: v.id, title: v.title, channel: v.channel }));
        return h('li', {}, button);
      }),
    );
  }

  private linkPasted(text: string): void {
    const id = parseYouTubeUrl(text);
    if (!id) {
      this.message('Lien YouTube non reconnu (exemple : https://youtu.be/…).', true);
      return;
    }
    this.linkInput.value = '';
    void this.link({ kind: 'youtube', id, title: '' });
  }

  /** Fichier audio lié tel quel ; vidéo : seul le son est gardé (WAV). `listen` : analyse ensuite. */
  private async linkFile(file: File, listen = false): Promise<void> {
    const cur = this.host.current();
    if (!cur) return;
    let bytes: Uint8Array;
    let link: MediaLink;
    if (isVideoFile(file)) {
      const from = cur.entry.media?.kind === 'youtube' ? cur.entry.media.title : '';
      const extracted = await this.extractVideoAudio(file);
      if (!extracted) return;
      bytes = extracted;
      const base = file.name.replace(/\.[^.]+$/, '').trim() || 'Enregistrement';
      link = { kind: 'audio', name: listen && from ? `Enregistrement — ${from}` : `${base} (son)`, type: 'audio/wav', size: bytes.length };
    } else {
      if (file.size > MAX_AUDIO_BYTES) {
        this.message(`Fichier trop lourd (50${NB}Mo au plus).`, true);
        return;
      }
      bytes = new Uint8Array(await file.arrayBuffer());
      link = { kind: 'audio', name: file.name, type: file.type || 'audio/mpeg', size: file.size };
    }
    try {
      await this.host.saveMediaFile(cur.entry, bytes);
    } catch (error) {
      this.message(describeError(error), true);
      return;
    }
    await this.link(link);
    if (listen && this.host.current()?.entry === cur.entry) await this.startListen();
  }

  /** Son d'une vidéo, en WAV prêt à garder ; null (message affiché) en cas d'échec. */
  private async extractVideoAudio(file: File): Promise<Uint8Array | null> {
    this.endTask();
    this.beginTask('analyze');
    this.taskEl.replaceChildren(h('p', { class: 'media__progress', 'data-testid': 'media-extract' }, 'Extraction du son de la vidéo…'));
    await pause();
    try {
      const { samples, sampleRate } = await videoAudio(file, VIDEO_AUDIO_RATE);
      if (peakOf(samples) < 0.002) {
        throw new Error('Cette vidéo est muette : à l’enregistrement, le son de l’appareil doit être actif (et le micro coupé).');
      }
      const trimmed = trimSilence(samples, sampleRate);
      if (trimmed.length * 2 + 44 > MAX_AUDIO_BYTES) {
        throw new Error(`Enregistrement trop long (${MAX_VIDEO_MINUTES}${NB}min au plus) : arrêtez-le à la fin du passage.`);
      }
      return encodeWav(trimmed, sampleRate);
    } catch (error) {
      this.message(error instanceof Error && error.message ? error.message : describeError(error), true);
      return null;
    } finally {
      this.endTask();
    }
  }

  private async link(link: MediaLink): Promise<void> {
    const cur = this.host.current();
    if (!cur) return;
    const { entry } = cur;
    const previous = entry.media;
    if (previous?.kind === 'audio' && link.kind !== 'audio') await this.host.saveMediaFile(entry, null).catch(() => undefined);
    entry.media = link;
    if (entry.sync && entry.sync.media !== mediaKey(link)) entry.settings.followMedia = false;
    this.host.saveEntry(entry);
    this.message(null);
    await this.createMedia(entry, link);
    this.renderResults();
    this.showLinked();
    this.host.setFollow(false);
    this.renderFollow();
    if (!MediaPanel.syncValid(entry)) {
      this.message(
        entry.origin === 'pdf-tab'
          ? 'Calez maintenant le rythme : « Taper le rythme » pendant l’écoute, ou « Écoute automatique ».'
          : 'Calez la partition sur l’enregistrement pour que la lecture le suive.',
      );
    }
  }

  private async unlink(): Promise<void> {
    const cur = this.host.current();
    if (!cur) return;
    const { entry } = cur;
    if (entry.media?.kind === 'audio') await this.host.saveMediaFile(entry, null).catch(() => undefined);
    delete entry.media;
    delete entry.sync;
    entry.settings.followMedia = false;
    this.host.saveEntry(entry);
    this.host.setFollow(false);
    this.setMedia(null, null);
    this.results = [];
    this.searchedFor = null;
    this.showPicker();
  }

  private toggleFollow(): void {
    const entry = this.host.current()?.entry;
    if (!entry || !MediaPanel.syncValid(entry)) return;
    entry.settings.followMedia = !entry.settings.followMedia;
    this.host.saveEntry(entry);
    this.host.setFollow(entry.settings.followMedia);
    this.renderFollow();
  }

  // --- Calage : préparation -------------------------------------------------------

  private prepare(): { entry: ScoreEntry; score: Score; trackIndex: number; events: ScoreEvent[]; times: Array<number | null> } | null {
    const cur = this.host.current();
    if (!cur || !this.media) return null;
    if (hasRepeats(cur.score)) {
      this.message('Cette partition contient des reprises : le calage n’est pas encore possible.', true);
      return null;
    }
    const events = scoreEvents(cur.score, cur.trackIndex);
    if (events.length < 2) {
      this.message('Pas assez de notes à caler sur cette piste.', true);
      return null;
    }
    const sync = cur.entry.sync;
    const times: Array<number | null> =
      sync && cur.entry.media && sync.media === mediaKey(cur.entry.media) && sync.times.length === events.length
        ? [...sync.times]
        : events.map(() => null);
    return { ...cur, events, times };
  }

  /** Première note à caler : début de la sélection, sinon la première. */
  private firstIndex(events: ScoreEvent[]): number {
    const start = this.host.selectionStart();
    if (start === null) return 0;
    const i = events.findIndex((e) => e.start >= start - 1e-6);
    return i < 0 ? 0 : i;
  }

  private endTask(): void {
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.recorder?.stop();
    this.recorder = null;
    this.task = 'idle';
    this.taskEl.hidden = true;
    this.taskEl.replaceChildren();
    this.actions.hidden = false;
    this.element.classList.remove('is-busy');
  }

  private beginTask(task: Task): void {
    this.session++;
    this.task = task;
    this.actions.hidden = true;
    this.taskEl.hidden = false;
    this.element.classList.add('is-busy');
    this.message(null);
    this.host.stopPlayback();
    this.host.setFollow(false);
  }

  // --- Calage : taper le rythme -------------------------------------------------------

  private startTap(): void {
    const ready = this.prepare();
    const media = this.media;
    if (!ready || !media) return;
    const { events, times } = ready;
    const original = [...times];
    const first = this.firstIndex(events);
    let index = first;
    this.beginTask('tap');
    media.playbackRate = this.host.speed();
    const before = first > 0 ? times[first - 1] : null;
    if (typeof before === 'number') media.seek(Math.max(0, before - 1.5));

    const progress = h('p', { class: 'media__progress', 'data-testid': 'tap-progress' });
    const note = h('button', { type: 'button', class: 'btn btn--primary media__tap', 'data-testid': 'tap-note' }, 'Note');
    const undo = h('button', { type: 'button', class: 'btn btn--small' }, 'Annuler la dernière');
    const finish = h('button', { type: 'button', class: 'btn btn--small' }, 'Terminer');
    const cancel = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, 'Abandonner');
    this.taskEl.replaceChildren(
      h(
        'p',
        { class: 'media__help' },
        'Lancez l’enregistrement, puis touchez « Note » (ou la barre d’espace) à chaque note ou accord entendu. Ralentissez la vitesse si besoin.',
      ),
      progress,
      note,
      h('div', { class: 'media__row media__row--wrap' }, undo, finish, cancel),
    );
    // Lecture lancée en touchant la vidéo : le clavier (barre d'espace) revient au bouton « Note ».
    const session = this.session;
    media.onState((state) => {
      if (state === 'playing' && this.task === 'tap' && this.session === session) note.focus({ preventScroll: true });
    });
    const render = (): void => {
      const e = events[index];
      progress.textContent = e ? `Note ${index + 1}${NB}/${NB}${events.length} · mesure ${e.bar + 1}` : 'Toutes les notes sont calées.';
      if (e) this.host.cursorTo(e.start);
      undo.disabled = index <= first;
    };
    const hit = (): void => {
      if (this.task !== 'tap' || index >= events.length) return;
      if (!media.playing) {
        this.message('Lancez d’abord l’enregistrement.', true);
        return;
      }
      times[index] = media.currentTime();
      index++;
      note.classList.remove('is-hit');
      void note.offsetWidth;
      note.classList.add('is-hit');
      this.message(null);
      render();
      if (index >= events.length) void this.finishTap(ready, times);
    };
    note.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      hit();
    });
    note.addEventListener('click', (e) => {
      // Clavier (Entrée sur le bouton) : le pointerdown n'a pas eu lieu.
      if ((e as MouseEvent).detail === 0) hit();
    });
    undo.addEventListener('click', () => {
      if (index <= first) return;
      index--;
      times[index] = original[index] ?? null;
      render();
    });
    finish.addEventListener('click', () => void this.finishTap(ready, times));
    cancel.addEventListener('click', () => {
      media.pause();
      this.endTask();
      this.renderFollow();
    });
    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) hit();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        undo.click();
      }
    };
    document.addEventListener('keydown', this.keyHandler);
    render();
  }

  private async finishTap(ready: NonNullable<ReturnType<MediaPanel['prepare']>>, times: Array<number | null>): Promise<void> {
    this.media?.pause();
    await this.compute(ready, times, null);
  }

  // --- Calage : écoute automatique ----------------------------------------------------

  private async startListen(): Promise<void> {
    const ready = this.prepare();
    const media = this.media;
    const cur = this.host.current();
    if (!ready || !media || !cur) return;
    if (cur.entry.media?.kind === 'audio') {
      this.beginTask('analyze');
      const status = h('p', { class: 'media__progress' }, 'Analyse de l’enregistrement…');
      this.taskEl.replaceChildren(status);
      await pause();
      try {
        const bytes = await this.host.loadMediaFile(cur.entry);
        if (!bytes) throw new Error('Fichier audio introuvable.');
        const { samples, sampleRate } = await decodeAudio(bytes);
        const result = await alignAudio(
          samples,
          sampleRate,
          ready.events.map((e) => ({ pitches: e.pitches })),
          (f) => (status.textContent = `Analyse de l’enregistrement… ${Math.round(f * 100)}${NB}%`),
        );
        const times = ready.times.map((t, i) => result.times[i] ?? t);
        await this.compute(ready, times, result.matched);
      } catch (error) {
        this.endTask();
        this.message(error instanceof Error && error.message ? error.message : describeError(error), true);
      }
      return;
    }
    this.chooseListen(ready, media);
  }

  /**
   * Vidéo YouTube : son inaccessible au site. Il arrive à l'analyse par le partage de l'onglet
   * (ordinateur), par un enregistrement d'écran importé (téléphone), ou en dernier recours au micro.
   */
  private chooseListen(ready: NonNullable<ReturnType<MediaPanel['prepare']>>, media: ReferenceMedia): void {
    this.beginTask('listen');
    const tab = canCaptureTab();
    const ios = isIOS();
    const items: HTMLElement[] = [
      help('L’analyse a besoin du son de la vidéo, transmis directement à l’app — sans micro ni haut-parleurs. Placez d’abord la vidéo juste avant le passage, si besoin.'),
    ];
    if (tab) {
      const capture = h('button', { type: 'button', class: 'btn btn--primary media__tap', 'data-testid': 'listen-tab' }, 'Capter le son de l’onglet');
      capture.addEventListener('click', () => this.listenLive(ready, media, 'tab'));
      items.push(
        capture,
        help('Le navigateur demande de partager cet onglet : acceptez en laissant cochée l’option du son. La vidéo est jouée et analysée jusqu’à la fin, ou jusqu’à « Terminer ». Le volume de l’ordinateur ne compte pas.'),
      );
    }
    const record = h(
      'button',
      { type: 'button', class: tab ? 'btn btn--small' : 'btn btn--primary media__tap', 'data-testid': 'listen-import' },
      'Importer un enregistrement d’écran…',
    );
    record.addEventListener('click', () => {
      this.listenAfterImport = true;
      this.fileInput.click();
    });
    items.push(record, help(ios ? IMPORT_HELP.ios : isAndroid() ? IMPORT_HELP.android : IMPORT_HELP.other));
    const row = h('div', { class: 'media__row media__row--wrap' });
    // Micro : inutilisable sur iPhone (le son bascule sur l'écouteur), superflu avec le son de l'onglet.
    if (!tab && !ios) {
      const mic = h('button', { type: 'button', class: 'btn btn--small btn--ghost', 'data-testid': 'listen-mic' }, 'Au micro (moins fiable)');
      mic.addEventListener('click', () => this.listenLive(ready, media, 'mic'));
      row.append(mic);
    }
    const cancel = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, 'Abandonner');
    cancel.addEventListener('click', () => {
      this.endTask();
      this.renderFollow();
    });
    row.append(cancel);
    items.push(row);
    this.taskEl.replaceChildren(...items);
  }

  /** Écoute pendant la lecture de la vidéo : son de l'onglet, ou micro. Appelée pendant un clic. */
  private listenLive(ready: NonNullable<ReturnType<MediaPanel['prepare']>>, media: ReferenceMedia, source: Source): void {
    // Contexte audio et partage (ou micro) demandés pendant le geste : iOS et Chrome l'exigent.
    const unlocked = unlockAudio();
    const opened = source === 'tab' ? openTabAudio() : openMicrophone();
    const session = this.session;
    const status = help(source === 'tab' ? 'Partage du son de l’onglet…' : 'Ouverture du micro…');
    const finish = h('button', { type: 'button', class: 'btn btn--primary media__tap', disabled: true, 'data-testid': 'listen-stop' }, 'Terminer l’écoute');
    const cancel = h('button', { type: 'button', class: 'btn btn--small btn--ghost' }, 'Abandonner');
    const level = h('span', { class: 'media__level-bar' });
    this.taskEl.replaceChildren(status, finish, h('div', { class: 'media__row' }, h('span', { class: 'media__level', 'aria-hidden': 'true' }, level), cancel));
    cancel.addEventListener('click', () => {
      media.pause();
      this.endTask();
      this.renderFollow();
    });
    const live = (): boolean => this.session === session && this.task === 'listen';
    // Position de la vidéo relevée à chaque image, sur l'horloge de la page.
    const track: Array<{ at: number; media: number; playing: boolean }> = [];
    let frame = 0;
    let started = false;
    let stopped = false;
    const recorder = new PcmRecorder();
    const stop = (): void => {
      if (stopped || !started || !live()) return;
      stopped = true;
      cancelAnimationFrame(frame);
      media.pause();
      const recording = recorder.stop();
      this.recorder = null;
      void this.analyzeRecording(ready, recording, track, source);
    };
    void (async () => {
      try {
        const [ctx, stream] = await Promise.all([unlocked, opened]);
        if (!live()) {
          closeMicrophone(stream);
          return;
        }
        this.recorder = recorder;
        await recorder.start(
          ctx,
          stream,
          (rms) => {
            level.style.width = `${Math.min(100, Math.round(Math.sqrt(rms) * 300))}%`;
          },
          stop,
        );
      } catch (error) {
        void opened.then(closeMicrophone, () => undefined);
        if (!live()) return;
        this.recorder = null;
        this.endTask();
        this.message(error instanceof CaptureError ? error.message : describeError(error), true);
        return;
      }
      started = true;
      if (source === 'tab') media.volume = 1;
      media.playbackRate = 1;
      media.play();
      status.textContent = fr(
        source === 'tab'
          ? 'Écoute du son de l’onglet : laissez jouer la vidéo jusqu’à la fin du passage, puis « Terminer ».'
          : 'Écoute au micro : montez le son (haut-parleurs, pas de casque) et évitez le bruit.',
      );
      finish.disabled = false;
      const sample = (): void => {
        track.push({ at: performance.now(), media: media.currentTime(), playing: media.playing });
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      finish.addEventListener('click', stop);
      media.onState((state) => {
        if (state === 'ended') stop();
      });
    })();
  }

  private async analyzeRecording(
    ready: NonNullable<ReturnType<MediaPanel['prepare']>>,
    recording: Recording | null,
    track: Array<{ at: number; media: number; playing: boolean }>,
    source: Source,
  ): Promise<void> {
    if (!recording || recording.samples.length < recording.sampleRate * 2) {
      this.endTask();
      this.message('Écoute trop courte : laissez jouer au moins quelques mesures.', true);
      return;
    }
    this.task = 'analyze';
    const status = h('p', { class: 'media__progress' }, 'Analyse de l’écoute…');
    this.taskEl.replaceChildren(status);
    await pause();
    let peak = 0;
    for (let i = 0; i < recording.samples.length; i += 64) peak = Math.max(peak, Math.abs(recording.samples[i] as number));
    if (peak < (source === 'tab' ? 0.002 : 0.01)) {
      this.endTask();
      this.message(
        source === 'tab'
          ? 'Aucun son n’est arrivé de l’onglet : vérifiez que le son du lecteur YouTube n’est pas coupé et que le partage du son était coché.'
          : 'Le micro n’a presque rien entendu : montez le volume (sans casque), puis recommencez.',
        true,
      );
      return;
    }
    const result = await alignAudio(
      recording.samples,
      recording.sampleRate,
      ready.events.map((e) => ({ pitches: e.pitches })),
      (f) => (status.textContent = `Analyse de l’écoute… ${Math.round(f * 100)}${NB}%`),
    );
    // Instant enregistré → position de la vidéo au même moment.
    const mediaAt = (at: number): number | null => {
      let lo = 0;
      let hi = track.length - 1;
      if (hi < 1) return null;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((track[mid] as { at: number }).at <= at) lo = mid;
        else hi = mid;
      }
      const a = track[lo] as { at: number; media: number; playing: boolean };
      const b = track[hi] as { at: number; media: number; playing: boolean };
      if (!a.playing || !b.playing || at < a.at - 50 || at > b.at + 50) return null;
      const f = b.at > a.at ? (at - a.at) / (b.at - a.at) : 0;
      return a.media + f * (b.media - a.media);
    };
    const times = ready.times.map((old, i) => {
      const t = result.times[i];
      if (t === null || t === undefined) return old;
      return mediaAt(recording.timeOf(t * recording.sampleRate)) ?? old;
    });
    await this.compute(ready, times, result.matched);
  }

  // --- Calage : résultat ----------------------------------------------------------------

  private async compute(
    ready: NonNullable<ReturnType<MediaPanel['prepare']>>,
    times: Array<number | null>,
    matched: number | null,
  ): Promise<void> {
    const { entry, score, events } = ready;
    const timed = times.filter((t) => typeof t === 'number').length;
    if (timed < 2) {
      this.endTask();
      this.message(matched !== null ? 'Les notes de la partition n’ont pas été retrouvées dans l’enregistrement.' : 'Calez au moins deux notes.', true);
      return;
    }
    const doubtful = matched !== null && matched < 0.4;
    if (entry.origin !== 'pdf-tab') {
      // Rythme juste : seuls les instants servent, pour suivre l'enregistrement.
      const points = syncFromTimes(score, events, times);
      entry.sync = { media: mediaKey(entry.media as MediaLink), times, points };
      entry.settings.followMedia = true;
      this.host.saveEntry(entry);
      this.host.applySync(points);
      this.endTask();
      this.host.setFollow(true);
      this.renderFollow();
      this.message(
        doubtful
          ? `Calage douteux (${Math.round((matched as number) * 100)}${NB}% des notes retrouvées) : vérifiez en lisant, ou tapez le rythme.`
          : 'Partition calée : la lecture suit maintenant l’enregistrement.',
        doubtful,
      );
      return;
    }
    this.task = 'analyze';
    this.taskEl.replaceChildren(h('p', { class: 'media__progress' }, 'Calcul du rythme…'));
    this.taskEl.hidden = false;
    await pause();
    const fit = fitRhythm(fitEvents(events, times), { barLength: barLength(score), barsKnown: !!entry.tabBars });
    this.showResult({ events, times, positions: fit.positions, tempo: fit.tempo, xml: '', points: [], matched }, ready);
  }

  private showResult(pending: Pending, ready: NonNullable<ReturnType<MediaPanel['prepare']>>): void {
    const at = this.host.alphaTab();
    if (!at) return;
    const { score, trackIndex, entry } = ready;
    const { xml, barStarts } = rewriteTab(score, trackIndex, pending.events, pending.positions, pending.tempo);
    const points = barSyncPoints(pending.positions, pending.times, barStarts);
    let preview: Score;
    try {
      preview = parseScore(at, new TextEncoder().encode(xml), true);
    } catch (error) {
      this.endTask();
      this.message(describeError(error), true);
      return;
    }
    preview.applyFlatSyncPoints(points);
    this.pending = { ...pending, xml, points };
    this.task = 'result';
    this.host.preview(preview);

    const keep = h('button', { type: 'button', class: 'btn btn--small btn--accent', 'data-testid': 'rhythm-keep' }, 'Garder');
    const cancel = h('button', { type: 'button', class: 'btn btn--small' }, 'Annuler');
    const double = h('button', { type: 'button', class: 'btn btn--small', title: 'Valeurs deux fois plus longues' }, 'Valeurs ×2');
    const half = h('button', { type: 'button', class: 'btn btn--small', title: 'Valeurs deux fois plus courtes' }, 'Valeurs ÷2');
    const bars = barStarts.length;
    const doubtful = pending.matched !== null && pending.matched < 0.4;
    this.taskEl.replaceChildren(
      h(
        'p',
        { class: 'media__progress', 'data-testid': 'rhythm-summary' },
        `Rythme recalculé${NB}: ${bars}${NB}mesure${bars > 1 ? 's' : ''}, noire${NB}≈${NB}${Math.round(pending.tempo)}.`,
      ),
      h(
        'p',
        { class: 'media__help' },
        doubtful
          ? `Attention${NB}: seules ${Math.round((pending.matched as number) * 100)}${NB}% des notes ont été retrouvées dans l’enregistrement. Écoutez avant de garder.`
          : 'Écoutez la partition (Lire). Si les valeurs semblent doublées ou divisées par deux, corrigez-les, puis gardez.',
      ),
      h('div', { class: 'media__row media__row--wrap' }, keep, cancel, double, half),
    );
    keep.addEventListener('click', () => void this.keep(entry));
    cancel.addEventListener('click', () => {
      this.pending = null;
      this.host.preview(null);
      this.endTask();
      this.renderFollow();
    });
    const rescale = (factor: number): void => {
      const p = this.pending;
      if (!p) return;
      this.showResult({ ...p, positions: scalePositions(p.positions, factor), tempo: p.tempo * factor }, ready);
    };
    double.addEventListener('click', () => rescale(2));
    half.addEventListener('click', () => rescale(0.5));
  }

  private async keep(entry: ScoreEntry): Promise<void> {
    const p = this.pending;
    if (!p || !entry.media) return;
    this.pending = null;
    entry.sync = { media: mediaKey(entry.media), times: p.times, points: p.points };
    entry.settings.followMedia = true;
    entry.settings.selection = null;
    this.endTask();
    try {
      await this.host.commit(entry, new TextEncoder().encode(p.xml));
      this.message('Rythme gardé : la lecture suit maintenant l’enregistrement.');
    } catch (error) {
      this.message(describeError(error), true);
    }
  }

  private message(text: string | null, problem = false): void {
    this.messageEl.textContent = text ? fr(text) : '';
    this.messageEl.hidden = !text;
    this.messageEl.classList.toggle('is-problem', problem);
  }

  /** Ferme le panneau (un autre s'ouvre). */
  hide(): void {
    this.setOpen(false);
  }

  /** Message affiché dans le panneau (ouvert pour l'occasion). */
  notify(text: string): void {
    this.setOpen(true);
    this.message(text, true);
  }

  /** Arrête toute tâche (partition fermée). */
  close(): void {
    this.endTask();
    this.media?.pause();
  }
}
