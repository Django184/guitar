import { byId } from '../ui/dom';

interface ToastAction {
  label: string;
  run: () => void;
}

let hideTimer: number | undefined;

/**
 * Affiche un message bref au-dessus de la barre d'onglets.
 * `durationMs = 0` garde le message jusqu'à l'action (ex. mise à jour disponible).
 */
export function showToast(message: string, action?: ToastAction, durationMs = 5000): void {
  const toast = byId('toast');
  const text = toast.querySelector<HTMLElement>('.toast__text');
  const button = toast.querySelector<HTMLButtonElement>('.toast__action');
  if (!text || !button) return;

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

  window.clearTimeout(hideTimer);
  if (durationMs > 0) hideTimer = window.setTimeout(hideToast, durationMs);
}

export function hideToast(): void {
  window.clearTimeout(hideTimer);
  byId('toast').hidden = true;
}
