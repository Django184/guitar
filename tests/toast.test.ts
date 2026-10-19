// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hideToast, showToast } from '../src/shell/toast';

function setup(): { text: () => string; button: HTMLButtonElement; toast: HTMLElement } {
  document.body.innerHTML =
    '<div id="toast" hidden><span class="toast__text"></span><button class="toast__action" type="button" hidden></button></div>';
  const toast = document.getElementById('toast') as HTMLElement;
  return {
    toast,
    text: () => (toast.hidden ? '' : (toast.querySelector('.toast__text')?.textContent ?? '')),
    button: toast.querySelector('.toast__action') as HTMLButtonElement,
  };
}

describe('Messages temporaires', () => {
  it('une information n’écrase pas un message avec « Annuler » : elle attend son tour', () => {
    const { text, button } = setup();
    let undone = false;
    showToast('« Étude » supprimée.', { label: 'Annuler', run: () => (undone = true) });
    showToast("L'app est prête : elle fonctionne maintenant hors-ligne.");
    expect(text()).toBe('« Étude » supprimée.');
    expect(button.hidden).toBe(false);

    button.click();
    expect(undone).toBe(true);
    expect(text()).toBe("L'app est prête : elle fonctionne maintenant hors-ligne.");
    expect(button.hidden).toBe(true);
    hideToast();
    expect(text()).toBe('');
  });

  it('une information remplace une autre information', () => {
    const { text } = setup();
    showToast('Premier');
    showToast('Second');
    expect(text()).toBe('Second');
    hideToast();
    expect(text()).toBe('');
  });

  it('une mise à jour en attente (persistante) réapparaît après un « Annuler »', () => {
    const { text, button } = setup();
    showToast('Une nouvelle version est disponible.', { label: 'Mettre à jour', run: () => {} }, 0);
    showToast('« Étude » supprimée.', { label: 'Annuler', run: () => {} });
    expect(text()).toBe('« Étude » supprimée.');
    hideToast();
    expect(text()).toBe('Une nouvelle version est disponible.');
    expect(button.textContent).toBe('Mettre à jour');
    hideToast();
  });
});
