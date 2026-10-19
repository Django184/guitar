import type { RouteId } from './router';

/** Un écran de l'app. Créé une fois, affiché / masqué par le routeur. */
export interface View {
  readonly id: RouteId;
  readonly title: string;
  readonly element: HTMLElement;
  /** L'écran devient visible. */
  enter(): void;
  /** L'écran est quitté : libérer micro, minuteries d'affichage, etc. */
  leave(): void;
}
