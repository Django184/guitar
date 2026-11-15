import { describe, expect, it } from 'vitest';
import { keyOf, markedState, readMark, rememberPosition } from '../src/shell/navigation';

describe('Navigation et reprise', () => {
  it('clé d’écran : route et identifiant encodé', () => {
    expect(keyOf({ route: 'partitions', param: null })).toBe('#/partitions');
    expect(keyOf({ route: 'partitions', param: 'a b' })).toBe('#/partitions/a%20b');
    expect(keyOf({ route: 'accordeur', param: null })).toBe('#/accordeur');
  });

  it('marque d’historique lue avec tolérance, posée sans perdre l’écran d’origine', () => {
    expect(readMark(null)).toEqual({ vu: false, depuis: null });
    expect(readMark({ vu: true, depuis: '#/partitions' })).toEqual({ vu: true, depuis: '#/partitions' });
    expect(markedState(null, '#/partitions')).toEqual({ vu: true, depuis: '#/partitions' });
    expect(markedState({ autre: 1, depuis: '#/partitions' }, '#/metronome')).toEqual({ autre: 1, vu: true, depuis: '#/partitions' });
  });

  it('positions : la dernière en dernier, plafond, valeurs arrondies et jamais négatives', () => {
    let p: Record<string, number> = {};
    p = rememberPosition(p, '#/partitions', 120.4);
    p = rememberPosition(p, '#/accordeur', -3);
    p = rememberPosition(p, '#/partitions', 300);
    expect(Object.keys(p)).toEqual(['#/accordeur', '#/partitions']);
    expect(p).toEqual({ '#/accordeur': 0, '#/partitions': 300 });
    for (let i = 0; i < 5; i++) p = rememberPosition(p, `#/partitions/${i}`, i, 3);
    expect(Object.keys(p)).toEqual(['#/partitions/2', '#/partitions/3', '#/partitions/4']);
  });
});
