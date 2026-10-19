/**
 * Garde l'écran allumé tant qu'au moins une activité le demande
 * (accordeur actif, métronome en marche, lecture de partition).
 * Le verrou est libéré par le système quand la page passe en arrière-plan :
 * on le redemande au retour au premier plan.
 */
export type WakeReason = 'tuner' | 'metronome' | 'player';

const reasons = new Set<WakeReason>();
let sentinel: WakeLockSentinel | null = null;
let pending = false;

function supported(): boolean {
  return 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function';
}

async function sync(): Promise<void> {
  if (!supported()) return;
  if (reasons.size > 0 && !sentinel && !pending && document.visibilityState === 'visible') {
    pending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
      });
      sentinel = lock;
      // Les raisons ont pu disparaître pendant la requête.
      if (reasons.size === 0) await release();
    } catch {
      // Refus (batterie faible, iframe, etc.) : l'app continue sans verrou.
    } finally {
      pending = false;
    }
  } else if (reasons.size === 0) {
    await release();
  }
}

async function release(): Promise<void> {
  const lock = sentinel;
  sentinel = null;
  if (lock && !lock.released) {
    try {
      await lock.release();
    } catch {
      // Déjà libéré.
    }
  }
}

export function keepAwake(reason: WakeReason): void {
  reasons.add(reason);
  void sync();
}

export function allowSleep(reason: WakeReason): void {
  reasons.delete(reason);
  void sync();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void sync();
});
