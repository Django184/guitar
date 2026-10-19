/**
 * Bouton « appui long » : un pas immédiat, puis répétition qui accélère tant que
 * le doigt reste posé. Utilisé pour ±1 BPM et ±1 Hz de diapason.
 * Le clavier (Entrée / Espace) déclenche un seul pas par activation.
 */
export function bindHoldRepeat(el: HTMLElement, step: () => void): void {
  let timer: number | undefined;
  let delay = 0;

  const stop = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const repeat = (): void => {
    step();
    delay = Math.max(35, delay * 0.85);
    timer = window.setTimeout(repeat, delay);
  };

  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // Capture indisponible : l'arrêt se fera sur pointerup / pointercancel.
    }
    stop();
    step();
    delay = 110;
    timer = window.setTimeout(repeat, 420);
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    el.addEventListener(type, stop);
  }

  // Activation au clavier : « click » avec detail === 0.
  el.addEventListener('click', (event) => {
    if (event.detail === 0) step();
  });

  el.addEventListener('contextmenu', (event) => event.preventDefault());
}
