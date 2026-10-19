import { describe, expect, it } from 'vitest';
import { parseLocation } from '../src/shell/router';

describe('Routage par hash', () => {
  it('écrans connus, avec ou sans sous-chemin', () => {
    expect(parseLocation('#/metronome')).toEqual({ route: 'metronome', param: null });
    expect(parseLocation('#/partitions')).toEqual({ route: 'partitions', param: null });
    expect(parseLocation('#/partitions/abc-123')).toEqual({ route: 'partitions', param: 'abc-123' });
  });

  it('identifiant encodé', () => {
    expect(parseLocation('#/partitions/a%20b')).toEqual({ route: 'partitions', param: 'a b' });
    expect(parseLocation('#/partitions/%E0%A4%A')).toEqual({ route: 'partitions', param: null });
  });

  it('adresse vide ou inconnue : accordeur', () => {
    expect(parseLocation('')).toEqual({ route: 'accordeur', param: null });
    expect(parseLocation('#/inconnu/42')).toEqual({ route: 'accordeur', param: null });
  });
});
