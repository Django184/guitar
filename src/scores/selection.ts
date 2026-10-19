/**
 * Sélection d'un passage sur la partition, à la souris ou au doigt.
 *
 * - Souris : cliquer-glisser d'une note (ou mesure) à une autre.
 * - Doigt : appui long (0,4 s) puis glisser ; un simple glissement fait défiler.
 * - Clic ou toucher bref : place le curseur de lecture sur la note, sans
 *   effacer la sélection en cours (un effleurement guitare en main ne doit pas
 *   perdre la boucle).
 *
 * alphaTab ne gère la sélection qu'à la souris : on calcule nous-mêmes la note
 * sous le doigt (boundsLookup) et on s'appuie sur highlightPlaybackRange /
 * applyPlaybackRangeFromHighlight pour la surbrillance et la plage de lecture.
 */
import type { AlphaTabModule, Api, Beat } from './alphatab';

export interface Passage {
  start: Beat;
  end: Beat;
}

interface SelectionOptions {
  at: AlphaTabModule;
  api: Api;
  /** Conteneur alphaTab (reçoit les gestes). */
  host: HTMLElement;
  /** Élément qui défile (pour le défilement automatique pendant le glissé). */
  scroller: HTMLElement;
  /** Sélection par mesures entières (sinon par notes). */
  wholeBars: () => boolean;
  /** Pendant le geste : aperçu de la plage, ou null. */
  onPreview: (passage: Passage | null) => void;
  /** Sélection validée, ou effacée (null). */
  onChange: (passage: Passage | null) => void;
  /** Appui long reconnu : le glissé commence. */
  onLongPress: () => void;
}

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE_PX = 10;
const EDGE_PX = 48;
const EDGE_STEP_PX = 14;

export class SelectionController {
  private passage: Passage | null = null;
  private drag: { anchor: Beat; last: Beat; x: number; y: number; moved: boolean } | null = null;
  private touch: {
    anchor: Beat;
    last: Beat;
    x: number;
    y: number;
    timer: number;
    selecting: boolean;
    moved: boolean;
  } | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly options: SelectionOptions) {
    const { host } = options;
    this.listen(host, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(host, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(host, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(host, 'pointercancel', () => this.cancelDrag());
    this.listen(host, 'touchstart', (e) => this.onTouchStart(e as TouchEvent), { passive: true });
    this.listen(host, 'touchmove', (e) => this.onTouchMove(e as TouchEvent), { passive: false });
    this.listen(host, 'touchend', (e) => this.onTouchEnd(e as TouchEvent));
    this.listen(host, 'touchcancel', () => this.cancelTouch());
    this.listen(host, 'contextmenu', (e) => e.preventDefault());
  }

  get current(): Passage | null {
    return this.passage;
  }

  /** Applique une sélection (restauration, ou fin de geste). `notify = false` : sans prévenir l'écran. */
  select(a: Beat, b: Beat, notify = true): void {
    const passage = this.normalize(a, b);
    const { api, at } = this.options;
    if (passage.start === passage.end) {
      // Mesure d'une seule figure : alphaTab ne sait pas surligner un seul temps,
      // on fixe la plage de lecture directement sur la mesure.
      this.resetAlphaTab(passage.start);
      const masterBar = passage.start.voice.bar.masterBar;
      const range = new at.synth.PlaybackRange();
      range.startTick = masterBar.start;
      range.endTick = masterBar.start + masterBar.calculateDuration() - 1;
      api.playbackRange = range;
      api.tickPosition = range.startTick;
    } else {
      api.highlightPlaybackRange(passage.start, passage.end);
      api.applyPlaybackRangeFromHighlight();
    }
    this.passage = passage;
    if (notify) this.options.onChange(passage);
  }

  /**
   * Réapplique la plage de lecture : le synthétiseur l'oublie quand alphaTab
   * recharge la musique (son prêt, changement de piste).
   */
  reapply(): void {
    if (this.passage) this.select(this.passage.start, this.passage.end, false);
  }

  clear(): void {
    this.resetAlphaTab(this.passage?.start ?? null);
    this.passage = null;
    this.options.onChange(null);
  }

  /**
   * Oublie la sélection avant de changer de partition, sans prévenir l'écran.
   * À appeler tant que l'ancienne partition est encore chargée.
   */
  forget(): void {
    this.resetAlphaTab(this.passage?.start ?? null);
    this.passage = null;
  }

  /**
   * Neutralise aussi la sélection mémorisée par alphaTab : il la redessine après chaque
   * rendu (redimensionnement, thème) et plante si elle désigne des notes d'une autre
   * piste ou d'une autre partition. Seule voie publique : une « sélection » d'un seul
   * temps, qu'alphaTab ne dessine jamais (et sans toucher à la position de lecture).
   */
  private resetAlphaTab(anchor: Beat | null): void {
    const { api } = this.options;
    const beat = anchor ?? api.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats[0] ?? null;
    if (beat) api.highlightPlaybackRange(beat, beat);
    api.clearPlaybackRangeHighlight();
    api.playbackRange = null;
  }

  dispose(): void {
    this.cancelTouch();
    this.cleanup.forEach((fn) => fn());
    this.cleanup.length = 0;
  }

  // --- Calculs -----------------------------------------------------------------

  private listen(target: HTMLElement, type: string, handler: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  private beatAt(clientX: number, clientY: number): Beat | null {
    const surface = this.options.host.querySelector<HTMLElement>('.at-surface');
    const lookup = this.options.api.boundsLookup;
    if (!surface || !lookup) return null;
    const rect = surface.getBoundingClientRect();
    return lookup.getBeatAtPos(clientX - rect.left, clientY - rect.top);
  }

  /** Ordonne les deux notes et, en mode mesures entières, étend aux bords des mesures. */
  private normalize(a: Beat, b: Beat): Passage {
    let [start, end] = a.absolutePlaybackStart <= b.absolutePlaybackStart ? [a, b] : [b, a];
    if (this.options.wholeBars()) {
      start = start.voice.beats[0] ?? start;
      end = end.voice.beats[end.voice.beats.length - 1] ?? end;
    }
    return { start, end };
  }

  private preview(anchor: Beat, current: Beat): void {
    const passage = this.normalize(anchor, current);
    if (passage.start !== passage.end) this.options.api.highlightPlaybackRange(passage.start, passage.end);
    this.options.onPreview(passage);
  }

  private seek(beat: Beat): void {
    this.options.api.tickPosition = beat.absolutePlaybackStart;
  }

  /** Fait défiler la partition quand le doigt ou la souris approche d'un bord. */
  private autoScroll(clientY: number): void {
    const rect = this.options.scroller.getBoundingClientRect();
    if (clientY > rect.bottom - EDGE_PX) this.options.scroller.scrollTop += EDGE_STEP_PX;
    else if (clientY < rect.top + EDGE_PX) this.options.scroller.scrollTop -= EDGE_STEP_PX;
  }

  /** Geste annulé : on remet la surbrillance (et la sélection interne d'alphaTab) sur le passage précédent. */
  private restorePrevious(anchor: Beat): void {
    const { api } = this.options;
    const previous = this.passage;
    if (previous && previous.start !== previous.end) {
      api.highlightPlaybackRange(previous.start, previous.end);
    } else {
      api.highlightPlaybackRange(anchor, anchor);
      api.clearPlaybackRangeHighlight();
    }
    this.options.onPreview(null);
  }

  // --- Souris et stylet --------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const beat = this.beatAt(e.clientX, e.clientY);
    if (!beat) return;
    e.preventDefault();
    try {
      this.options.host.setPointerCapture(e.pointerId);
    } catch {
      // Sans capture, le geste s'arrête si le pointeur sort de la partition.
    }
    this.drag = { anchor: beat, last: beat, x: e.clientX, y: e.clientY, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerType === 'touch') return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    this.autoScroll(e.clientY);
    const beat = this.beatAt(e.clientX, e.clientY);
    if (beat && beat !== drag.last) {
      drag.last = beat;
      this.preview(drag.anchor, beat);
    } else if (beat === drag.anchor && this.options.wholeBars()) {
      this.preview(drag.anchor, beat);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerType === 'touch') return;
    this.drag = null;
    if (!drag.moved) {
      this.seek(drag.anchor);
    } else if (drag.last !== drag.anchor || this.options.wholeBars()) {
      this.select(drag.anchor, drag.last);
    } else {
      this.restorePrevious(drag.anchor);
    }
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.restorePrevious(drag.anchor);
  }

  // --- Doigt -------------------------------------------------------------------

  private onTouchStart(e: TouchEvent): void {
    this.cancelTouch();
    const t = e.touches[0];
    if (e.touches.length !== 1 || !t) return;
    const beat = this.beatAt(t.clientX, t.clientY);
    if (!beat) return;
    const timer = window.setTimeout(() => {
      if (!this.touch) return;
      this.touch.selecting = true;
      navigator.vibrate?.(12);
      this.options.onLongPress();
      this.preview(this.touch.anchor, this.touch.anchor);
    }, LONG_PRESS_MS);
    this.touch = { anchor: beat, last: beat, x: t.clientX, y: t.clientY, timer, selecting: false, moved: false };
  }

  private onTouchMove(e: TouchEvent): void {
    const touch = this.touch;
    const t = e.touches[0];
    if (!touch || !t) return;
    if (!touch.selecting) {
      // Le doigt bouge avant l'appui long : c'est un défilement.
      if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > MOVE_TOLERANCE_PX) this.cancelTouch();
      return;
    }
    e.preventDefault(); // pendant la sélection, la page ne défile pas
    touch.moved = true;
    this.autoScroll(t.clientY);
    const beat = this.beatAt(t.clientX, t.clientY);
    if (beat && beat !== touch.last) {
      touch.last = beat;
      this.preview(touch.anchor, beat);
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    const touch = this.touch;
    if (!touch) return;
    window.clearTimeout(touch.timer);
    this.touch = null;
    if (touch.selecting) {
      e.preventDefault(); // évite le clic simulé après le geste
      if (touch.last !== touch.anchor || this.options.wholeBars()) this.select(touch.anchor, touch.last);
      else this.restorePrevious(touch.anchor);
    } else {
      this.seek(touch.anchor);
    }
  }

  private cancelTouch(): void {
    const touch = this.touch;
    if (!touch) return;
    window.clearTimeout(touch.timer);
    this.touch = null;
    if (touch.selecting) this.restorePrevious(touch.anchor);
  }
}
