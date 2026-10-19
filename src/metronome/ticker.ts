/**
 * Réveil régulier (toutes les 25 ms) qui déclenche la planification.
 * Il ne joue AUCUN son : il sert seulement à remplir la fenêtre d'anticipation.
 * Il tourne dans un Web Worker, dont les minuteries sont moins bridées que
 * celles de la page (onglet en arrière-plan, fil principal chargé).
 */
const WORKER_SOURCE = `
let id = null;
onmessage = (event) => {
  if (event.data === 'start' && id === null) {
    id = setInterval(() => postMessage('tick'), 25);
  } else if (event.data === 'stop' && id !== null) {
    clearInterval(id);
    id = null;
  }
};
`;

export class Ticker {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private fallbackId: number | undefined;

  constructor(private readonly onTick: () => void) {}

  start(): void {
    try {
      if (!this.worker) {
        this.workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        this.worker = new Worker(this.workerUrl);
        this.worker.onmessage = () => this.onTick();
      }
      this.worker.postMessage('start');
    } catch {
      // Workers indisponibles : minuterie classique (la précision reste assurée par l'horloge audio).
      this.fallbackId ??= window.setInterval(this.onTick, 25);
    }
  }

  stop(): void {
    this.worker?.postMessage('stop');
    if (this.fallbackId !== undefined) {
      window.clearInterval(this.fallbackId);
      this.fallbackId = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }
}
