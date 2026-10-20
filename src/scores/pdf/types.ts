/**
 * Primitives graphiques extraites d'un PDF, en coordonnées de page
 * (points PDF, origine en haut à gauche, y vers le bas).
 */

export interface Glyph {
  /** Caractère Unicode fourni par le PDF (ou dérivé de l'encodage de la police). */
  text: string;
  /** Point de code du premier caractère. */
  cp: number;
  /** Nom du glyphe dans la police, quand le PDF le donne (« noteheads.s2 », « uniE0A4 »…). */
  name?: string;
  /** Nom réel de la police, sans préfixe de sous-ensemble (« Leland », « Maestro »…). */
  font: string;
  /** Origine du glyphe (ligne de base), en points. */
  x: number;
  y: number;
  /** Taille de la police (corps), en points. */
  size: number;
  /** Chasse du glyphe, en points. */
  width: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PathItem {
  kind: 'stroke' | 'fill';
  /** Épaisseur du trait (chemins tracés), en points. */
  lineWidth: number;
  /** Sous-chemins, points déjà transformés. Les courbes sont réduites à leurs extrémités et points de contrôle. */
  subpaths: Point[][];
  hasCurve: boolean;
  box: Box;
}

/** Image posée sur la page (XObject), pour la lecture des tablatures dessinées en image. */
export interface PageImage {
  /** Identifiant de l'objet pdf.js (page.objs). */
  id: string;
  /** Emplacement sur la page, en points. */
  box: Box;
}

export interface PageData {
  index: number;
  width: number;
  height: number;
  glyphs: Glyph[];
  paths: PathItem[];
  /** Surface couverte par des images (pour reconnaître un PDF scanné), en points². */
  imageArea: number;
  /** Images (XObjects) de la page, dans l'ordre de dessin. */
  images?: PageImage[];
}
