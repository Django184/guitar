import { registerSW } from 'virtual:pwa-register';
import { showToast } from './toast';

/**
 * Enregistre le service worker généré par vite-plugin-pwa (précache Workbox).
 * Mode « prompt » : une nouvelle version est proposée, jamais imposée
 * (un rechargement automatique couperait le métronome en pleine séance).
 */
export function setupPwa(): void {
  if (!('serviceWorker' in navigator)) return;

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      showToast(
        'Une nouvelle version est disponible.',
        { label: 'Mettre à jour', run: () => void updateServiceWorker(true) },
        0,
      );
    },
    onOfflineReady() {
      showToast("L'app est prête : elle fonctionne maintenant hors-ligne.");
    },
    onRegisterError(error: unknown) {
      console.warn("Service worker non enregistré : l'app ne fonctionnera pas hors-ligne.", error);
    },
  });
}
