import { describe, expect, it } from 'vitest';
import { type Finger, type FingerNote, THUMB, fingerNotes } from '../src/scores/fingering/fingering';

/* Doigtés de la main gauche : programmation dynamique sur toute la séquence. */

/** Cordes nommées comme sur une tablature (de l'aiguë à la grave) → indice (0 = la plus grave). */
const STRING: Record<string, number> = { e: 5, B: 4, G: 3, D: 2, A: 1, E: 0, d: 0 };

interface Spec {
  /** « e5 », « A7 »… */
  notes: string[];
  /** Durée jusqu'à l'événement suivant (noires). */
  step?: number;
  /** Durée du son (noires) ; par défaut, jusqu'à l'événement suivant. */
  hold?: number;
  legato?: boolean;
  slide?: boolean;
}

/** Suite d'événements → notes (identifiant : « index:corde+case »). */
function phrase(specs: Spec[]): FingerNote[] {
  const out: FingerNote[] = [];
  let t = 0;
  specs.forEach((spec, i) => {
    const step = spec.step ?? 0.5;
    for (const n of spec.notes) {
      const [, name, fret] = /^([eBGDAEd])(\d+)$/.exec(n) as RegExpExecArray;
      out.push({
        id: `${i}:${n}`,
        string: STRING[name as string] as number,
        fret: Number(fret),
        start: t,
        end: t + (spec.hold ?? step),
        legato: spec.legato,
        slide: spec.slide,
      });
    }
    t += step;
  });
  return out;
}

/** Doigts dans l'ordre des notes, sous la forme « e5:2 ». */
function fingers(specs: Spec[], overrides?: Map<string, Finger>): string[] {
  const notes = phrase(specs);
  const result = fingerNotes(notes, { overrides });
  return notes.map((n) => `${n.id.split(':')[1]}:${result.get(n.id) === THUMB ? 'T' : result.get(n.id)}`);
}

describe('Doigtés de la main gauche', () => {
  it('cordes à vide : aucun doigt', () => {
    expect(fingers([{ notes: ['E0', 'B0'] }, { notes: ['G0'] }])).toEqual(['E0:0', 'B0:0', 'G0:0']);
  });

  it('accords ouverts : Do, La, Mi', () => {
    expect(fingers([{ notes: ['A3', 'D2', 'G0', 'B1', 'e0'] }])).toEqual(['A3:3', 'D2:2', 'G0:0', 'B1:1', 'e0:0']);
    expect(fingers([{ notes: ['A0', 'D2', 'G2', 'B2', 'e0'] }])).toEqual(['A0:0', 'D2:1', 'G2:2', 'B2:3', 'e0:0']);
    expect(fingers([{ notes: ['E0', 'A2', 'D2', 'G1', 'B0', 'e0'] }])).toEqual(['E0:0', 'A2:2', 'D2:3', 'G1:1', 'B0:0', 'e0:0']);
  });

  it('accord barré (Fa) : l’index couvre les cordes à la première case', () => {
    expect(fingers([{ notes: ['E1', 'A3', 'D3', 'G2', 'B1', 'e1'] }])).toEqual(['E1:1', 'A3:3', 'D3:4', 'G2:2', 'B1:1', 'e1:1']);
  });

  it('chromatisme : un doigt par case, sans déplacer la main', () => {
    expect(fingers([{ notes: ['A5'] }, { notes: ['A6'] }, { notes: ['A7'] }, { notes: ['A8'] }])).toEqual(['A5:1', 'A6:2', 'A7:3', 'A8:4']);
  });

  it('gamme pentatonique en 5e position', () => {
    const box = ['E5', 'E8', 'A5', 'A7', 'D5', 'D7', 'G5', 'G7', 'B5', 'B8', 'e5', 'e8'];
    expect(fingers(box.map((n) => ({ notes: [n] })))).toEqual(['E5:1', 'E8:4', 'A5:1', 'A7:3', 'D5:1', 'D7:3', 'G5:1', 'G7:3', 'B5:1', 'B8:4', 'e5:1', 'e8:4']);
  });

  it('hammer-on : deux doigts différents sur la même corde', () => {
    const result = fingers([{ notes: ['G5'] }, { notes: ['G7'], legato: true }]);
    expect(result[0]).not.toBe(result[1]?.replace('G7', 'G5'));
    expect(result).toEqual(['G5:1', 'G7:3']);
  });

  it('note tenue : elle garde son doigt pendant que la mélodie bouge', () => {
    const result = fingers([
      { notes: ['A3', 'B1'], step: 0.5, hold: 2 },
      { notes: ['B3'] },
      { notes: ['B1'] },
      { notes: ['e3'] },
    ]);
    const bass = result[0] as string;
    expect(bass).toBe('A3:3');
    // La mélodie n'utilise pas le doigt de la basse tenue.
    for (const r of result.slice(1)) if (!r.startsWith('A3')) expect(r.endsWith(':3')).toBe(false);
  });

  it('doigt imposé : respecté, et la suite se réorganise autour', () => {
    const run: Spec[] = [{ notes: ['A5'] }, { notes: ['A6'] }, { notes: ['A7'] }];
    const forced = new Map<string, Finger>([['0:A5', 2]]);
    const result = fingers(run, forced);
    expect(result[0]).toBe('A5:2');
    expect(result).toEqual(['A5:2', 'A6:3', 'A7:4']);
  });

  it('reproduit les doigtés de l’exemple (mesure 1, drop D)', () => {
    // Capture fournie : e5+D4, G6, e4, e5+D4, e7+A7, e5+B0, e7+A7.
    const bar: Spec[] = [
      { notes: ['e5', 'D4'] },
      { notes: ['G6'] },
      { notes: ['e4'] },
      { notes: ['e5', 'D4'] },
      { notes: ['e7', 'A7'] },
      { notes: ['e5', 'B0'] },
      { notes: ['e7', 'A7'] },
    ];
    expect(fingers(bar)).toEqual(['e5:2', 'D4:1', 'G6:3', 'e4:1', 'e5:2', 'D4:1', 'e7:4', 'A7:3', 'e5:2', 'B0:0', 'e7:4', 'A7:3']);
  });

  it('changements de position de l’exemple (mesure 2) : main placée pour chaque passage', () => {
    // e9+D0, e14+A12, e12+D0, e7+A7, e9+D9, B10+A7, B9.
    const bar: Spec[] = [
      { notes: ['e9', 'D0'] },
      { notes: ['e14', 'A12'] },
      { notes: ['e12', 'D0'] },
      { notes: ['e7', 'A7'] },
      { notes: ['e9', 'D9'] },
      { notes: ['B10', 'A7'] },
      { notes: ['B9'] },
    ];
    const result = fingers(bar);
    expect(result).toContain('e14:3');
    expect(result).toContain('A12:1');
    expect(result).toContain('e12:1');
    expect(result).toContain('B10:4');
    expect(result).toContain('B9:3');
  });

  it('reproduit les doigtés de l’exemple (mesure 6) et son grand écart de la mesure 4', () => {
    const bar6: Spec[] = [
      { notes: ['e5', 'D0'] },
      { notes: ['G2'] },
      { notes: ['e4'] },
      { notes: ['e5', 'D0'] },
      { notes: ['e7'] },
      { notes: ['e9', 'A7'] },
      { notes: ['e5', 'B0'] },
      { notes: ['e4', 'A7'] },
    ];
    expect(fingers(bar6).filter((r) => !r.endsWith(':0'))).toEqual(['e5:4', 'G2:1', 'e4:3', 'e5:4', 'e7:1', 'e9:3', 'A7:1', 'e5:2', 'e4:1', 'A7:4']);
    // Index en 4, auriculaire en 9 : cinq cases, permis seulement faute de mieux.
    const stretch = fingers([{ notes: ['e5', 'D0'] }, { notes: ['B9', 'A4'] }, { notes: ['D7'] }, { notes: ['D6'] }, { notes: ['e4'] }]);
    expect(stretch).toContain('B9:4');
    expect(stretch).toContain('A4:1');
  });

  it('accord impossible (cinq cases différentes) : des doigts quand même, sans erreur', () => {
    const result = fingers([{ notes: ['E1', 'A3', 'D5', 'G7', 'B9'] }]);
    expect(result.every((r) => /:[1-4T]$/.test(r))).toBe(true);
  });

  it('rapide : 2 000 événements en moins d’une seconde', () => {
    let seed = 7;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const specs: Spec[] = Array.from({ length: 2000 }, () => {
      const base = 1 + Math.floor(rnd() * 9);
      const count = 1 + Math.floor(rnd() * 3);
      const names = ['E', 'A', 'D', 'G', 'B', 'e'];
      const used = new Set<number>();
      const notes: string[] = [];
      while (notes.length < count) {
        const s = Math.floor(rnd() * 6);
        if (used.has(s)) continue;
        used.add(s);
        notes.push(`${names[s]}${base + Math.floor(rnd() * 4)}`);
      }
      return { notes, step: 0.25 };
    });
    // Mise en route du compilateur JIT à part (les autres fichiers de test tournent en parallèle).
    fingers(specs.slice(0, 200));
    const started = performance.now();
    const result = fingers(specs);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.every((r) => /:[0-4T]$/.test(r))).toBe(true);
  });
});
