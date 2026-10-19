# Pratique Guitare

PWA de pratique guitare : accordeur, métronome et (Phase 2) partitions avec lecture sélective.
Installable sur iOS, Android et ordinateur, utilisable hors-ligne après le premier chargement.

**Version en ligne :** https://django184.github.io/guitar/ (déployée automatiquement à chaque
modification de `main`). C'est l'adresse à ouvrir sur le téléphone pour installer l'app.

## Intégration continue

Le workflow `.github/workflows/ci.yml` s'exécute à chaque pull request et à chaque push sur `main` :
typecheck, tests, build, puis contrôle du manifeste et du service worker générés. Sur `main`, le
site est ensuite publié sur GitHub Pages (réglage requis une seule fois : Settings › Pages ›
Source : « GitHub Actions »).

## Prérequis

- Node.js 22.12 ou plus récent (exigé par Vite 8 et Vitest 5).
- Un navigateur récent : Safari 17+, Chrome / Edge 120+, Firefox 120+.

## Lancer en local (ordinateur)

```bash
npm install
npm run dev
```

Ouvrez http://localhost:5173. `localhost` est un contexte sécurisé : le micro fonctionne sans HTTPS.
En mode `dev`, le service worker est désactivé (pas de cache qui masque vos modifications).

Autres commandes :

```bash
npm test            # tests unitaires (YIN, notes, métronome, formats, erreurs)
npm run typecheck   # vérification TypeScript stricte
npm run build       # typecheck + build de production dans dist/ (avec service worker)
npm run preview     # sert dist/ sur http://localhost:4173
```

## Tester sur téléphone (HTTPS obligatoire pour le micro)

Méthode la plus simple : ouvrir la version en ligne sur GitHub Pages (ci-dessus).

Pour tester une modification locale avant de la pousser : un tunnel HTTPS Cloudflare, gratuit et
sans compte.

1. Installez `cloudflared` une fois :
   - macOS : `brew install cloudflared`
   - Windows : `winget install --id Cloudflare.cloudflared`
   - Linux : paquet `.deb` / `.rpm` sur https://github.com/cloudflare/cloudflared/releases
2. Construisez et servez la version de production (le service worker n'existe qu'en build) :
   ```bash
   npm run build
   npm run preview
   ```
3. Dans un second terminal :
   ```bash
   cloudflared tunnel --url http://localhost:4173
   ```
4. Ouvrez sur le téléphone l'adresse `https://….trycloudflare.com` affichée.

`vite.config.ts` autorise déjà les hôtes `.trycloudflare.com` (et ngrok), sinon Vite refuserait la requête.

Pourquoi pas l'adresse IP locale ? En `http://192.168.x.x`, le navigateur bloque le micro et le service
worker. Un certificat auto-signé ne suffit pas non plus : iOS refuse d'installer un service worker
sur un certificat non approuvé. L'alternative sans tunnel est `mkcert`, mais il faut alors installer
et approuver son certificat racine sur le téléphone (Réglages › Général › Informations › Réglages
des certificats sur iPhone).

## Vérifier les critères d'acceptation de la Phase 1

**Accordeur : un La à 110 Hz affiche « A2 » à ±2 cents.**
- Automatique : `npm test` (signaux synthétiques à 44,1 et 48 kHz, avec harmoniques, bruit et
  fondamentale faible).
- Manuel : jouez un La de 110 Hz depuis un générateur de son (une autre machine ou un second
  téléphone), touchez « Démarrer » : l'écran affiche A2, 0 ct, aiguille verte, corde 5.

**Métronome : pas de dérive audible sur 5 minutes à 120 BPM, premier temps distinct.**
- Automatique : `npm test` vérifie que le 600e temps tombe exactement à +300 s (erreur < 1 ns).
- Manuel : lancez le métronome à 120 BPM et un chronomètre en même temps ; à 5:00, le clic coïncide
  toujours avec le chronomètre. Le premier temps est plus aigu (1568 Hz contre 1047 Hz) et plus fort.

**Installation et hors-ligne.**
1. Ouvrez l'app (GitHub Pages ou tunnel) ; attendez le message « L'app est prête : elle fonctionne maintenant
   hors-ligne ».
2. Installez-la :
   - iPhone / iPad (Safari) : bouton Partager › « Sur l'écran d'accueil ».
   - Android (Chrome) : menu ⋮ › « Installer l'application » (ou le bouton « Installer » de l'app).
   - Ordinateur (Chrome / Edge) : bouton « Installer » de l'app ou icône dans la barre d'adresse.
3. Passez en mode avion, puis ouvrez l'app depuis l'écran d'accueil : elle démarre, l'accordeur et
   le métronome fonctionnent.

L'adresse `trycloudflare.com` change à chaque lancement du tunnel : pour une installation durable,
installez l'app depuis la version GitHub Pages.

## Notes iOS

- L'audio démarre sur un geste (bouton « Démarrer ») : exigence de Safari.
- Sur les Safari récents (API Audio Session), l'app déclare une session « lecture » pour le
  métronome (son sur le haut-parleur, comme une app de musique) et « lecture et enregistrement »
  pour l'accordeur. Vérifiez le volume média si le métronome semble muet.
- Le micro est rendu dès qu'on quitte l'accordeur ou que l'app passe en arrière-plan.
- Le maintien de l'écran allumé (Wake Lock) est disponible dans Safari 16.4+ ; dans une app
  installée sur l'écran d'accueil, il fonctionne à partir d'iOS 18.4.

## Structure

```
src/
  main.ts               point d'entrée : écrans, routage, thème, PWA
  styles.css            thèmes sombre (défaut) et clair, mise en page mobile / bureau
  shell/                routage par hash, thème, préférences, Wake Lock, PWA, messages
  audio/                AudioContext partagé (déblocage iOS), micro
  tuner/                YIN, notes et accordages, stabilisation, cadran, écran Accordeur
  metronome/            horloge des temps, clics, Worker, tap tempo, écran Métronome
  scores/               reconnaissance des formats, écran Partitions (Phase 1 : import vérifié)
  ui/                   helpers DOM, appui long, messages d'erreur en français
tests/                  tests Vitest
public/                 favicon et icônes PWA
```
