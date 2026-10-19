import { byId } from '../ui/dom';

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastRequest {
  message: string;
  action?: ToastAction;
  durationMs: number;
}

/** Durée minimale d'un message avec action (« Annuler », « Mettre à jour ») : le temps de le lire et d'agir. */
const ACTION_MIN_MS = 10_000;

let current: ToastRequest | null = null;
/** Messages en attente : un message avec action n'est jamais écrasé par une simple information. */
const queue: ToastRequest[] = [];
let hideTimer: number | undefined;
let remaining = 0;
let shownAt = 0;
const bound = new WeakSet<HTMLElement>();

function schedule(ms: number): void {
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
  remaining = ms;
  shownAt = performance.now();
  if (ms > 0) hideTimer = window.setTimeout(hideToast, ms);
}

/**
 * Le message ne disparaît pas pendant qu'on le survole ou qu'il a le focus clavier,
 * et un toucher sur le texte le ferme.
 */
function bindOnce(toast: HTMLElement): void {
  if (bound.has(toast)) return;
  bound.add(toast);
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

function display(request: ToastRequest): void {
  const toast = byId('toast');
  const text = toast.querySelector<HTMLElement>('.toast__text');
  const button = toast.querySelector<HTMLButtonElement>('.toast__action');
  if (!text || !button) return;
  bindOnce(toast);

  current = request;
  text.textContent = request.message;
  const { action } = request;
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
  const { durationMs } = request;
  schedule(durationMs > 0 && action ? Math.max(durationMs, ACTION_MIN_MS) : durationMs);
}

/**
 * Affiche un message bref par-dessus la barre de titre (jamais sur les commandes de l'écran).
 * `durationMs = 0` garde le message jusqu'à l'action (ex. mise à jour disponible).
 * Un message avec action reste affiché : une simple information attend son tour, et un
 * message persistant remplacé par une autre action réapparaît ensuite.
 */
export function showToast(message: string, action?: ToastAction, durationMs = 5000): void {
  const request: ToastRequest = { message, action, durationMs };
  if (current?.action) {
    if (!action) {
      queue.push(request);
      return;
    }
    if (current.durationMs === 0) queue.unshift(current);
  }
  display(request);
}

/** Ferme le message affiché et passe au suivant, s'il y en a un. */
export function hideToast(): void {
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
  remaining = 0;
  current = null;
  byId('toast').hidden = true;
  const next = queue.shift();
  if (next) display(next);
}
