# Changelog

Évolutions notables de Pratique Guitare. Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versionnement sémantique.
La version est définie dans `package.json` et affichée dans Réglages avec le commit publié.

## [1.0.0] - 2026-11-03

Première version numérotée, alignée sur le socle de l'écosystème.

### Ajouté
- `src/socle.css` : tokens communs de l'écosystème (espacement, typographie, rayons, ombres, durées, focus), avec les alias de rôles de couleur. Aucun changement visuel, sauf le contour de focus.
- Version sémantique affichée dans Réglages (« Version 1.0.0 (commit) »).
- Dependabot : mises à jour npm et actions GitHub signalées chaque mois.

### Modifié
- TypeScript 7 (même version majeure que Panier Témoin).
- Contour de focus de 3 px au lieu de 2 px (socle de l'écosystème).

## Historique avant 1.0.0

- 2026-10-31 · Dépôt repassé de privé à public ; republication manuelle du site possible (PR #16).
- 2026-10-28 · Interface épurée : Réglages, options de partition, lecteur sobre (PR #15).
- 2026-10-28 · PDF : tablatures dessinées en image (PR #14).
- 2026-10-28 · Proxy déployable en reliant tout le dépôt à Cloudflare (PR #13).
- 2026-10-28 · Enrichissement, désactivé par défaut (PR #12).
- 2026-10-28 · Rythme retrouvé dans des transcriptions et proxy Cloudflare (PR #11).
- 2026-10-28 · Doigtés de la main gauche optimisés sur toute la pièce (PR #10).
- 2026-10-28 · Banque de sons GeneralUser GS préparée pour alphaTab (PR #9).
- 2026-10-28 · Vidéo : son analysé sans micro ni haut-parleurs (PR #8).
- 2026-10-20 · Vidéo de référence, rythme calé par l'écoute ou en tapant (PR #7).
- 2026-10-20 · Import PDF : tablatures texte, en caractères ou en image (PR #6).
- 2026-10-20 · Import PDF : lecture des partitions dans l'app (PR #5).
- 2026-10-19 · Messages : file d'attente, « Annuler » jamais écrasé (PR #4).
- 2026-10-19 · CI : test du site publié, verrouillage des dépendances (PR #3).
- 2026-10-19 · Phase 2 : partitions (alphaTab), sélection, boucle, vitesse, bibliothèque (PR #2).
- 2026-10-19 · Phase 1 : coquille PWA, accordeur et métronome (PR #1).
