// Retour d'Android (et Échap) : le panneau ouvert se ferme d'abord, la partition reste à l'écran
// (ECOSYSTEME.md §4, N7). Repose sur CloseWatcher (Chrome 120 et suivants) ; ailleurs, rien ne change.
// Les feuilles (<dialog> modal : Réglages, options) se ferment déjà ainsi d'elles-mêmes.

interface Watcher {
  onclose: (() => void) | null;
  destroy(): void;
}
type WatcherClass = new () => Watcher;

export class BackClose {
  private watcher: Watcher | null = null;

  constructor(private readonly close: () => void) {}

  /** À appeler à chaque ouverture ou fermeture du panneau. */
  set(open: boolean): void {
    if (open && !this.watcher) {
      const Ctor = (window as unknown as { CloseWatcher?: WatcherClass }).CloseWatcher;
      if (!Ctor) return;
      try {
        const watcher = new Ctor();
        watcher.onclose = () => {
          if (this.watcher === watcher) this.watcher = null;
          this.close();
        };
        this.watcher = watcher;
      } catch {
        this.watcher = null;
      }
    } else if (!open && this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      watcher.destroy();
    }
  }
}
