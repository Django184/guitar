import type { RouteId } from './router';

/** Un écran de l'app. Créé une fois, affiché / masqué par le routeur. */
export interface View {
  readonly id: RouteId;
  readonly title: string;
  readonly element: HTMLElement;
  /** L'écran devient visible. `param` : sous-chemin de l'adresse (ex. identifiant de partition). */
  enter(param: string | null): void;
  /** L'adresse change sans quitter l'écran (ex. ouverture d'une partition). */
  update?(param: string | null): void;
  /** L'écran est quitté : libérer micro, minuteries d'affichage, etc. */
  leave(): void;
}
