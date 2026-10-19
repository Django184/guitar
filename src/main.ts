import './styles.css';
import { Metronome } from './metronome/metronome';
import { createMetronomeView } from './metronome/metronomeView';
import { DEFAULT_BPM, METERS, type Meter } from './metronome/scheduler';
import { createScoresView } from './scores/scoresView';
import { setupInstallButton, setupPwa } from './shell/pwa';
import { type RouteId, startRouter } from './shell/router';
import { isNumber, isOneOf, loadPref } from './shell/storage';
import { setupThemeToggle } from './shell/theme';
import type { View } from './shell/view';
import { createTunerView } from './tuner/tunerView';
import { byId } from './ui/dom';

const metronome = new Metronome(
  loadPref('bpm', DEFAULT_BPM, isNumber),
  loadPref<Meter>('meter', '4/4', isOneOf(METERS)),
);

const scores = createScoresView();

const views: Record<RouteId, View> = {
  // Le micro capterait les clics et la partition : on coupe tout avant d'accorder.
  accordeur: createTunerView({
    beforeStart: () => {
      metronome.stop();
      scores.pause();
    },
  }),
  metronome: createMetronomeView(metronome),
  partitions: scores,
};

const main = byId('main');
const title = byId('view-title');
const navItems = document.querySelectorAll<HTMLAnchorElement>('.nav__item');

for (const view of Object.values(views)) {
  view.element.hidden = true;
  main.append(view.element);
}

let current: View | null = null;

startRouter(({ route, param }, initial) => {
  const next = views[route];
  if (current === next) {
    next.update?.(param);
    return;
  }
  current?.leave();
  if (current) current.element.hidden = true;

  next.element.hidden = false;
  next.enter(param);
  current = next;

  title.textContent = next.title;
  document.title = `${next.title} · Pratique Guitare`;
  navItems.forEach((item) => {
    if (item.dataset.route === route) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  // Lecteurs d'écran et clavier : le focus suit le changement d'écran.
  if (!initial) title.focus({ preventScroll: true });
});

// Retour au premier plan, ou tout nouveau toucher : relance l'audio si iOS l'a suspendu.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') metronome.resumeIfInterrupted();
});
document.addEventListener('pointerdown', () => metronome.resumeIfInterrupted(), { capture: true });

setupThemeToggle(byId<HTMLButtonElement>('theme-btn'));
setupInstallButton(byId<HTMLButtonElement>('install-btn'));
setupPwa();
