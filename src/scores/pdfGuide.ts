import { h } from '../ui/dom';

function link(href: string, label: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

export type PdfGuideReason = 'scanned' | 'no-music' | 'protected';

const REASONS: Record<PdfGuideReason, string> = {
  scanned:
    "Ce PDF est une image (partition scannée ou photographiée) : l'app lit seulement les PDF exportés par un logiciel de partition (MuseScore, Guitar Pro, Finale, Sibelius, Dorico, LilyPond…). Convertissez-le en MusicXML, puis importez le fichier obtenu.",
  'no-music':
    "Aucune portée ni tablature n'a été reconnue dans ce PDF. S'il s'agit bien d'une partition, convertissez-la en MusicXML, puis importez le fichier obtenu.",
  protected: 'Ce PDF est protégé par un mot de passe. Enregistrez-en une copie sans protection, ou convertissez-le en MusicXML.',
};

/** Message d'import PDF non lisible : pourquoi, et comment convertir. */
export function pdfGuide(name: string, reason: PdfGuideReason = 'scanned'): HTMLElement {
  return h(
    'div',
    { class: 'card card--guide' },
    h('p', { class: 'card__title' }, `« ${name} » doit d'abord être converti`),
    h('p', {}, REASONS[reason]),
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        'Sur ordinateur, ouvrez le PDF avec ',
        link('https://musescore.org/fr', 'MuseScore Studio'),
        " (gratuit, import PDF via le service en ligne de musescore.com) ou avec ",
        link('https://github.com/Audiveris/audiveris', 'Audiveris'),
        ' (gratuit, fonctionne hors-ligne).',
      ),
      h('li', {}, 'Corrigez les erreurs de reconnaissance : rythmes, altérations, liaisons.'),
      h('li', {}, 'Exportez en MusicXML (.musicxml ou .mxl), puis importez ce fichier ici.'),
    ),
  );
}
