import type { View } from '../shell/view';
import { savePref } from '../shell/storage';
import { h, isEditableTarget } from '../ui/dom';
import { describeError } from '../ui/errors';
import { bindHoldRepeat } from '../ui/hold';
import type { Metronome } from './metronome';
import { MAX_BPM, METERS, MIN_BPM, beatsPerBar } from './scheduler';
import { TapTempo } from './tapTempo';

export function createMetronomeView(metronome: Metronome): View {
  const tapTempo = new TapTempo();
  let active = false;

  // --- Temps de la mesure -----------------------------------------------------
  const beatsRow = h('div', { class: 'beats', 'aria-hidden': 'true', 'data-testid': 'beats' });

  // --- Tempo ------------------------------------------------------------------
  const bpmValue = h('output', { class: 'tempo__value', 'data-testid': 'bpm' });
  const tempoDisplay = h('div', { class: 'tempo' }, bpmValue, h('span', { class: 'tempo__unit' }, 'BPM'));

  const slider = h('input', {
    type: 'range',
    class: 'slider',
    min: MIN_BPM,
    max: MAX_BPM,
    step: 1,
    'aria-label': 'Tempo en battements par minute',
  });
  slider.addEventListener('input', () => metronome.setBpm(slider.valueAsNumber));

  const minus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Ralentir de 1 BPM' }, '−');
  const plus = h('button', { type: 'button', class: 'btn btn--square', 'aria-label': 'Accélérer de 1 BPM' }, '+');
  bindHoldRepeat(minus, () => metronome.setBpm(metronome.bpm - 1));
  bindHoldRepeat(plus, () => metronome.setBpm(metronome.bpm + 1));
  const tempoRow = h('div', { class: 'tempo-row' }, minus, slider, plus);

  // --- Mesure -----------------------------------------------------------------
  const meterButtons = METERS.map((meter) =>
    h(
      'button',
      { type: 'button', role: 'radio', 'data-meter': meter, onclick: () => metronome.setMeter(meter) },
      meter,
    ),
  );
  const meterGroup = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Mesure' }, ...meterButtons);

  // --- Actions ----------------------------------------------------------------
  const alertEl = h('p', { class: 'alert', role: 'alert', hidden: true });
  const tapButton = h('button', { type: 'button', class: 'btn btn--tap', 'aria-label': 'Tap tempo : tapez la pulsation' }, 'Tap');
  const playButton = h('button', { type: 'button', class: 'btn btn--primary', 'aria-pressed': 'false' }, 'Démarrer');

  const tap = (): void => {
    const bpm = tapTempo.tap(performance.now());
    tapButton.classList.remove('is-hit');
    void tapButton.offsetWidth; // relance l'animation de retour visuel
    tapButton.classList.add('is-hit');
    if (bpm !== null) metronome.setBpm(bpm);
  };
  // pointerdown plutôt que click : l'instant de la tape est capté sans le délai du relâchement.
  tapButton.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    tap();
  });
  tapButton.addEventListener('click', (event) => {
    if (event.detail === 0) tap(); // clavier
  });

  const togglePlayback = (): void => {
    alertEl.hidden = true;
    if (metronome.isPlaying) {
      metronome.stop();
      return;
    }
    metronome.start().catch((error: unknown) => {
      alertEl.textContent = describeError(error);
      alertEl.hidden = false;
    });
  };
  playButton.addEventListener('click', togglePlayback);

  const element = h(
    'section',
    { class: 'view view--metronome', 'aria-labelledby': 'view-title' },
    beatsRow,
    tempoDisplay,
    tempoRow,
    meterGroup,
    h('p', { class: 'hint-keys' }, 'Clavier : Espace pour démarrer, flèches pour ±1, T pour taper.'),
    h('div', { class: 'actions actions--split' }, alertEl, tapButton, playButton),
  );

  // --- Rendu ------------------------------------------------------------------
  function renderBeats(): void {
    const count = beatsPerBar(metronome.meter);
    if (beatsRow.childElementCount === count) return;
    beatsRow.replaceChildren(
      ...Array.from({ length: count }, (_, index) =>
        h('span', {
          class: `beat${index === 0 ? ' beat--strong' : ''}${metronome.meter === '6/8' && index === 3 ? ' beat--medium' : ''}`,
        }),
      ),
    );
  }

  function render(): void {
    renderBeats();
    bpmValue.textContent = String(metronome.bpm);
    slider.value = String(metronome.bpm);
    slider.setAttribute('aria-valuetext', `${metronome.bpm} battements par minute`);
    minus.disabled = metronome.bpm <= MIN_BPM;
    plus.disabled = metronome.bpm >= MAX_BPM;
    for (const button of meterButtons) {
      button.setAttribute('aria-checked', String(button.dataset.meter === metronome.meter));
    }
    playButton.textContent = metronome.isPlaying ? 'Arrêter' : 'Démarrer';
    playButton.setAttribute('aria-pressed', String(metronome.isPlaying));
  }

  metronome.onChange(() => {
    savePref('bpm', metronome.bpm);
    savePref('meter', metronome.meter);
    render();
  });

  metronome.onBeat((beat) => {
    renderBeats();
    const dots = beatsRow.children;
    for (let i = 0; i < dots.length; i++) {
      dots[i]?.classList.toggle('is-on', beat !== null && i === beat.beatInBar);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!active) return;
    const isArrow = event.key.startsWith('Arrow');
    if (event.repeat && !isArrow) return;
    if (event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePlayback();
        break;
      case 'ArrowUp':
      case 'ArrowRight':
        event.preventDefault();
        metronome.setBpm(metronome.bpm + 1);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        event.preventDefault();
        metronome.setBpm(metronome.bpm - 1);
        break;
      case 't':
      case 'T':
        tap();
        break;
      default:
    }
  });

  render();

  return {
    id: 'metronome',
    title: 'Métronome',
    element,
    enter() {
      active = true;
      render();
    },
    leave() {
      // Le métronome continue de jouer pendant qu'on consulte une partition.
      active = false;
      tapTempo.reset();
    },
  };
}
