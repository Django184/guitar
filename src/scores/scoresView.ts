import type { View } from '../shell/view';
import { h } from '../ui/dom';
import { messageFor } from '../ui/errors';
import { ACCEPTED_EXTENSIONS, type Detection, detectScoreFile } from './formats';

/**
 * Phase 1 : l'écran Partitions vérifie déjà les fichiers importés
 * (format reconnu, fichier invalide, format non pris en charge, PDF à convertir).
 * Le rendu, la sélection et la lecture arrivent en Phase 2.
 */
export function createScoresView(): View {
  const input = h('input', { type: 'file', accept: ACCEPTED_EXTENSIONS, hidden: true });
  const result = h('div', { class: 'scores__result', 'aria-live': 'polite', 'data-testid': 'score-result' });
  const importButton = h('button', { type: 'button', class: 'btn btn--primary' }, 'Importer un fichier');

  importButton.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = ''; // permet de réimporter le même fichier
    if (!file) return;
    try {
      render(file.name, await detectScoreFile(file));
    } catch {
      result.replaceChildren(h('p', { class: 'alert' }, messageFor('file-unreadable')));
    }
  });

  function render(name: string, detection: Detection): void {
    switch (detection.kind) {
      case 'score':
        result.replaceChildren(
          h(
            'div',
            { class: 'card card--ok' },
            h('p', { class: 'card__title' }, `Fichier reconnu : ${detection.label}`),
            h('p', {}, `« ${name} » est lisible. Son affichage et sa lecture arriveront avec la prochaine version de l'app.`),
          ),
        );
        break;
      case 'pdf':
        result.replaceChildren(pdfGuide(name));
        break;
      case 'invalid':
      case 'unsupported':
        result.replaceChildren(h('p', { class: 'alert', role: 'alert' }, detection.message));
        break;
    }
  }

  const element = h(
    'section',
    { class: 'view view--scores', 'aria-labelledby': 'view-title' },
    h(
      'div',
      { class: 'scores__intro' },
      h(
        'p',
        { class: 'scores__lead' },
        'Importez une partition Guitar Pro, MusicXML ou MIDI pour la voir avec sa tablature, choisir un passage et le jouer en boucle, plus lentement.',
      ),
      h(
        'p',
        { class: 'muted' },
        "L'affichage et la lecture arrivent avec la prochaine version. Vous pouvez déjà vérifier qu'un fichier est reconnu.",
      ),
    ),
    result,
    h('div', { class: 'actions' }, input, importButton),
  );

  return {
    id: 'partitions',
    title: 'Partitions',
    element,
    enter() {},
    leave() {},
  };
}

function link(href: string, label: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

/** Message d'import PDF : pourquoi ce n'est pas lisible, et comment convertir. */
function pdfGuide(name: string): HTMLElement {
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
