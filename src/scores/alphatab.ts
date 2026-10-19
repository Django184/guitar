/**
 * Chargement différé d'alphaTab (≈ 1 Mo) : la bibliothèque n'est téléchargée
 * et analysée qu'à la première ouverture de l'écran Partitions.
 */
import type * as AlphaTab from '@coderline/alphatab';
import { currentTheme, type Theme } from '../shell/theme';
import { AppError } from '../ui/errors';

export type AlphaTabModule = typeof AlphaTab;
export type Score = AlphaTab.model.Score;
export type Beat = AlphaTab.model.Beat;
export type Api = AlphaTab.AlphaTabApi;

let modulePromise: Promise<AlphaTabModule> | null = null;

export function loadAlphaTab(): Promise<AlphaTabModule> {
  modulePromise ??= import('@coderline/alphatab').catch((error: unknown) => {
    modulePromise = null;
    console.error(error);
    throw new AppError('module-failed');
  });
  return modulePromise;
}

/** Couleurs de rendu de la partition, accordées aux deux thèmes de l'app. */
export function scoreColors(theme: Theme = currentTheme()): Record<string, string> {
  return theme === 'dark'
    ? {
        mainGlyphColor: '#ede5d9',
        secondaryGlyphColor: '#ede5d966',
        scoreInfoColor: '#ede5d9',
        staffLineColor: '#6e5d53',
        barSeparatorColor: '#a8988a',
        barNumberColor: '#d6ae5e',
      }
    : {
        mainGlyphColor: '#1d1816',
        secondaryGlyphColor: '#1d181666',
        scoreInfoColor: '#1d1816',
        staffLineColor: '#a3aaa0',
        barSeparatorColor: '#5b554f',
        barNumberColor: '#8a6516',
      };
}

/** Dossier public de l'app (« / » en local, « /guitar/ » sur GitHub Pages). */
export const ASSET_BASE = import.meta.env.BASE_URL;

/**
 * Lit et valide une partition. Lève une AppError lisible si le fichier est illisible.
 * `withNotation` : affiche la portée de notation au-dessus de la tablature (le MusicXML
 * d'alphaTab n'affiche que la tablature dès qu'un accordage est déclaré).
 */
export function parseScore(at: AlphaTabModule, data: Uint8Array, withNotation = false): Score {
  try {
    const score = at.importer.ScoreLoader.loadScoreFromBytes(data, new at.Settings());
    if (withNotation) {
      for (const track of score.tracks) {
        for (const staff of track.staves) {
          if (!staff.showTablature || staff.showStandardNotation) continue;
          staff.showStandardNotation = true;
          // <staff-lines> décrit la tablature (6 cordes) : la portée de notation garde ses 5 lignes.
          staff.standardNotationLineCount = 5;
        }
      }
    }
    return score;
  } catch {
    throw new AppError(
      'file-invalid',
      "Fichier invalide : alphaTab n'a pas pu lire cette partition. Elle est peut-être corrompue ou d'une version non prise en charge.",
    );
  }
}
