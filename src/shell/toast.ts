import { byId } from '../ui/dom';

interface ToastAction {
  label: string;
  run: () => void;
}

/** Durée minimale d'un message avec action (« Annuler », « Mettre à jour ») : le temps de le lire et d'agir. */
const ACTION_MIN_MS = 10_000;

let hideTimer: number | undefined;
let remaining = 0;
let shownAt = 0;
let bound = false;

function schedule(ms: number): void {
  window.clearTimeout(hideTimer);
  remaining = ms;
  shownAt = performance.now();
  if (ms > 0) hideTimer = window.setTimeout(hideToast, ms);
}

/**
 * Le message ne disparaît pas pendant qu'on le survole ou qu'il a le focus clavier,
 * et un toucher sur le texte le ferme.
 */
function bindOnce(toast: HTMLElement): void {
  if (bound) return;
  bound = true;
  const pause = (): void => {
    if (remaining <= 0 || hideTimer === undefined) return;
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
    remaining = Math.max(1500, remaining - (performance.now() - shownAt));
  };
  const resume = (): void => {
    if (!toast.hidden && remaining > 0 && hideTimer === undefined) schedule(remaining);
  };
  toast.addEventListener('pointerenter', pause);
  toast.addEventListener('pointerleave', resume);
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', resume);
  toast.querySelector('.toast__text')?.addEventListener('click', hideToast);
}

/**
 * Affiche un message bref par-dessus la barre de titre (jamais sur les commandes de l'écran).
 * `durationMs = 0` garde le message jusqu'à l'action (ex. mise à jour disponible).
 */
export function showToast(message: string, action?: ToastAction, durationMs = 5000): void {
  const toast = byId('toast');
  const text = toast.querySelector<HTMLElement>('.toast__text');
  const button = toast.querySelector<HTMLButtonElement>('.toast__action');
  if (!text || !button) return;
  bindOnce(toast);

  text.textContent = message;
  if (action) {
    button.textContent = action.label;
    button.hidden = false;
    button.onclick = () => {
      hideToast();
      action.run();
    };
  } else {
    button.hidden = true;
    button.onclick = null;
  }
  toast.hidden = false;
  schedule(durationMs > 0 && action ? Math.max(durationMs, ACTION_MIN_MS) : durationMs);
}

export function hideToast(): void {
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
  remaining = 0;
  byId('toast').hidden = true;
}
