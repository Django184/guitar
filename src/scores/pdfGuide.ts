import { h } from '../ui/dom';

function link(href: string, label: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

/** Message d'import PDF : pourquoi ce n'est pas lisible, et comment convertir. */
export function pdfGuide(name: string): HTMLElement {
  return h(
    'div',
    { class: 'card card--guide' },
    h('p', { class: 'card__title' }, `« ${name} » doit d'abord être converti`),
    h(
      'p',
      {},
      "Un PDF contient une image de la partition, pas les notes elles-mêmes : l'app ne peut pas les lire de façon fiable. Convertissez-le en MusicXML, puis importez le fichier obtenu.",
    ),
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
      h('li', {}, 'Corrigez les erreurs de reconnaissance : rythmes, altérations, liaisons.'),
      h('li', {}, 'Exportez en MusicXML (.musicxml ou .mxl), puis importez ce fichier ici.'),
    ),
    h(
      'p',
      { class: 'muted' },
      "La tablature d'un PDF est rarement reconnue : après conversion, vérifiez les positions sur le manche.",
    ),
  );
}
