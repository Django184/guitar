import { setAudioSession, unlockAudio } from '../audio/context';
import type { View } from '../shell/view';
import { isNumber, isOneOf, loadPref, savePref } from '../shell/storage';
import { allowSleep, keepAwake } from '../shell/wakeLock';
import { h } from '../ui/dom';
import { describeError } from '../ui/errors';
import { bindHoldRepeat } from '../ui/hold';
import { IN_TUNE_CENTS, createGauge } from './gauge';
import {
  A4_DEFAULT,
  TUNINGS,
  TUNING_IDS,
  type Tuning,
  type TuningId,
  clampA4,
  describeFrequency,
  getTuning,
  matchString,
  nearestString,
  noteName,
  stringNumber,
} from './notes';
import { PitchTracker, type PitchReading } from './pitchTracker';
import { PitchStabilizer } from './stabilizer';

/** Après ce délai sans son, on remet la stabilisation à zéro (nouvelle attaque). */
const RESET_AFTER_MS = 250;
/** Après ce délai sans son, l'affichage revient à l'état d'attente. */
const IDLE_AFTER_MS = 1500;

interface TunerDeps {
  /** Appelé juste avant d'ouvrir le micro (ex. couper le métronome, qui serait capté). */
  beforeStart: () => void;
}

export function createTunerView({ beforeStart }: TunerDeps): View {
  let tuning: Tuning = getTuning(loadPref<TuningId>('tuning', 'standard', isOneOf(TUNING_IDS)));
  let a4 = clampA4(loadPref('a4', A4_DEFAULT, isNumber));
  let lockedString: number | null = null;
  let lastFrequency: number | null = null;
  let lastSignalAt = 0;
  let starting = false;
  let animation = 0;

  const stabilizer = new PitchStabilizer();
  const gauge = createGauge();

  // --- Accordages -------------------------------------------------------------
  const tuningButtons = TUNINGS.map((t) =>
    h('button', { type: 'button', role: 'radio', 'data-tuning': t.id, onclick: () => selectTuning(t.id) }, t.label),
  );
  const tuningGroup = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Accordage' }, ...tuningButtons);

  // --- Lecture ----------------------------------------------------------------
  const letterEl = h('span', { class: 'note__letter' }, '–');
  const octaveEl = h('span', { class: 'note__octave' });
  const noteEl = h('div', { class: 'note', 'data-testid': 'note' }, letterEl, octaveEl);
  const solfegeEl = h('span', { class: 'readout__solfege' });
  const centsEl = h('span', { class: 'readout__cents', 'data-testid': 'cents' });
  const hintEl = h('p', { class: 'readout__hint' });
  const readout = h(
    'div',
    { class: 'readout' },
    noteEl,
    h('div', { class: 'readout__meta' }, solfegeEl, centsEl),
    hintEl,
  );

  // --- Cordes -----------------------------------------------------------------
  const stringsGroup = h('div', { class: 'strings', role: 'group', 'aria-label': 'Cordes' });
  const stringInfo = h('p', { class: 'strings__info', 'data-testid': 'string-info' });

  // --- Diapason ---------------------------------------------------------------
  const a4Value = h('output', { class: 'stepper__value', 'aria-live': 'polite' });
  const a4Minus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Baisser le diapason de 1 Hz' }, '−');
  const a4Plus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Monter le diapason de 1 Hz' }, '+');
  bindHoldRepeat(a4Minus, () => setA4(a4 - 1));
  bindHoldRepeat(a4Plus, () => setA4(a4 + 1));
  const a4Row = h(
    'div',
    { class: 'stepper' },
    h('span', { class: 'stepper__label' }, 'Diapason (La 4)'),
    h('div', { class: 'stepper__controls' }, a4Minus, a4Value, a4Plus),
  );

  // --- Démarrage --------------------------------------------------------------
  const alertEl = h('p', { class: 'alert', role: 'alert', hidden: true });
  const startButton = h('button', { type: 'button', class: 'btn btn--primary', 'aria-pressed': 'false' }, 'Démarrer');
  startButton.addEventListener('click', () => void toggle());

  const tracker = new PitchTracker({
    onReading: handleReading,
    onError: (error) => {
      showAlert(error.message);
      stopListening();
    },
  });

  const element = h(
    'section',
    { class: 'view view--tuner', 'aria-labelledby': 'view-title' },
    tuningGroup,
    h('div', { class: 'tuner__display' }, gauge.element, readout),
    h('div', { class: 'tuner__strings' }, stringsGroup, stringInfo),
    a4Row,
    h('div', { class: 'actions' }, alertEl, startButton),
  );

  // --- Comportement -----------------------------------------------------------
  function selectTuning(id: TuningId): void {
    tuning = getTuning(id);
    lockedString = null;
    savePref('tuning', id);
    renderTuning();
    renderReading();
  }

  function setA4(value: number): void {
    const next = clampA4(value);
    if (next === a4) return;
    a4 = next;
    savePref('a4', a4);
    a4Value.textContent = `${a4} Hz`;
    a4Minus.disabled = a4 <= 430;
    a4Plus.disabled = a4 >= 450;
    renderReading();
  }

  function toggleLock(index: number): void {
    lockedString = lockedString === index ? null : index;
    renderReading();
  }

  function renderTuning(): void {
    for (const button of tuningButtons) {
      button.setAttribute('aria-checked', String(button.dataset.tuning === tuning.id));
    }
    stringsGroup.replaceChildren(
      ...tuning.strings.map((midi, index) => {
        const note = noteName(midi);
        const number = stringNumber(index, tuning);
        return h(
          'button',
          {
            type: 'button',
            class: 'string',
            'data-index': index,
            'aria-pressed': 'false',
            'aria-label': `Corde ${number}, ${note.name} (${note.solfege})`,
            style: `--gauge: ${(3.6 - index * 0.5).toFixed(1)}px`,
            onclick: () => toggleLock(index),
          },
          h('span', { class: 'string__note' }, note.letter),
          h('span', { class: 'string__line', 'aria-hidden': 'true' }),
          h('span', { class: 'string__number' }, String(number)),
        );
      }),
    );
  }

  function handleReading(reading: PitchReading | null): void {
    const now = performance.now();
    if (reading) {
      lastSignalAt = now;
      const stable = stabilizer.push(reading.frequency);
      if (stable !== null) lastFrequency = stable;
    } else if (now - lastSignalAt > RESET_AFTER_MS) {
      stabilizer.reset();
      if (now - lastSignalAt > IDLE_AFTER_MS) lastFrequency = null;
    }
    renderReading();
  }

  function renderReading(): void {
    const listening = tracker.running;
    const stale = performance.now() - lastSignalAt > RESET_AFTER_MS;
    const strings = stringsGroup.querySelectorAll<HTMLButtonElement>('.string');

    if (lastFrequency === null) {
      letterEl.textContent = '–';
      octaveEl.textContent = '';
      solfegeEl.textContent = '';
      centsEl.textContent = '';
      hintEl.textContent = listening ? 'Jouez une corde à vide.' : 'Touchez « Démarrer » puis jouez une corde.';
      readout.className = 'readout is-idle';
      gauge.setTarget(null, false);
      strings.forEach((button, index) => {
        button.classList.remove('is-target', 'is-in-tune');
        button.setAttribute('aria-pressed', String(lockedString === index));
      });
      stringInfo.textContent =
        lockedString === null
          ? 'Touchez une corde pour la fixer.'
          : lockedText(lockedString);
      animate();
      return;
    }

    const note = describeFrequency(lastFrequency, a4);
    const match =
      lockedString === null ? nearestString(lastFrequency, tuning, a4) : matchString(lastFrequency, tuning, lockedString, a4);
    const cents = Math.round(match.cents);
    const inTune = Math.abs(match.cents) < IN_TUNE_CENTS;

    letterEl.textContent = note.letter;
    octaveEl.textContent = String(note.octave);
    solfegeEl.textContent = note.solfege;
    centsEl.textContent = cents === 0 ? '0 ct' : `${cents > 0 ? '+' : '−'}${Math.abs(cents)} ct`;
    hintEl.textContent = inTune ? 'Juste' : match.cents < 0 ? 'Trop bas : tendez la corde' : 'Trop haut : détendez la corde';
    readout.className = `readout ${inTune ? 'is-in-tune' : 'is-off'}${stale ? ' is-stale' : ''}`;
    gauge.setTarget(match.cents, inTune);

    strings.forEach((button, index) => {
      button.classList.toggle('is-target', index === match.index);
      button.classList.toggle('is-in-tune', index === match.index && inTune);
      button.setAttribute('aria-pressed', String(lockedString === index));
    });
    const target = noteName(match.midi);
    stringInfo.textContent =
      lockedString === null
        ? `Corde la plus proche : ${stringNumber(match.index, tuning)} (${target.name})`
        : lockedText(lockedString);
    animate();
  }

  function lockedText(index: number): string {
    const target = noteName(tuning.strings[index] ?? 40);
    return `Corde ${stringNumber(index, tuning)} (${target.name}) fixée. Touchez-la pour la libérer.`;
  }

  function animate(): void {
    if (animation) return;
    const tick = (): void => {
      animation = gauge.step() ? requestAnimationFrame(tick) : 0;
    };
    animation = requestAnimationFrame(tick);
  }

  function showAlert(message: string | null): void {
    alertEl.hidden = message === null;
    alertEl.textContent = message ?? '';
  }

  async function toggle(): Promise<void> {
    if (tracker.running) {
      stopListening();
      return;
    }
    if (starting) return;
    starting = true;
    showAlert(null);
    try {
      beforeStart();
      setAudioSession('play-and-record');
      const ctx = await unlockAudio(); // première instruction asynchrone : toujours dans le geste
      await tracker.start(ctx);
      keepAwake('tuner');
      startButton.textContent = 'Arrêter';
      startButton.setAttribute('aria-pressed', 'true');
    } catch (error) {
      setAudioSession('playback');
      showAlert(describeError(error));
    } finally {
      starting = false;
      renderReading();
    }
  }

  function stopListening(): void {
    tracker.stop();
    setAudioSession('playback');
    allowSleep('tuner');
    stabilizer.reset();
    lastFrequency = null;
    startButton.textContent = 'Démarrer';
    startButton.setAttribute('aria-pressed', 'false');
    renderReading();
  }

  document.addEventListener('visibilitychange', () => {
    // En arrière-plan, on rend le micro (batterie, confidentialité, indicateur iOS).
    if (document.visibilityState === 'hidden' && tracker.running) stopListening();
  });

  a4Value.textContent = `${a4} Hz`;
  a4Minus.disabled = a4 <= 430;
  a4Plus.disabled = a4 >= 450;
  renderTuning();
  renderReading();

  return {
    id: 'accordeur',
    title: 'Accordeur',
    element,
    enter() {
      renderReading();
    },
    leave() {
      if (tracker.running) stopListening();
    },
  };
}
