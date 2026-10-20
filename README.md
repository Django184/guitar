# Pratique Guitare

PWA de pratique guitare : accordeur, métronome et partitions avec lecture sélective.
Installable sur iOS, Android et ordinateur, utilisable hors-ligne après le premier chargement.

**Version en ligne :** https://django184.github.io/guitar/ (déployée automatiquement à chaque
modification de `main`). C'est l'adresse à ouvrir sur le téléphone pour installer l'app.

## Intégration continue

Le workflow `.github/workflows/ci.yml` s'exécute à chaque pull request et à chaque push sur `main` :

- **check** : typecheck, tests unitaires, build, contrôle du manifeste et du service worker
  (police musicale et banque de sons comprises dans le précache) ;
- **e2e** : tests Playwright dans Chromium, profils ordinateur et mobile (écran tactile), sur le
  build de production. Le rapport (captures, traces) est joint à chaque exécution ;
- **deploy** (sur `main`, si les deux précédents passent) : publication sur GitHub Pages
  (réglage requis une seule fois : Settings › Pages › Source : « GitHub Actions ») ;
- **smoke** (après chaque déploiement) : attend que GitHub Pages serve le nouveau commit (balise
  `<meta name="app-version">`), puis rejoue sur le site publié les tests de la Phase 1 et du
  hors-ligne (accordeur, métronome, installation, partition ouverte et jouée sans réseau) ;
- **lockfile** (sur les pull requests) : crée ou met à jour `package-lock.json` sur la branche,
  pour que tous les jobs installent exactement les mêmes versions (`npm ci`).

Les annotations de chaque exécution (onglet « Checks ») résument les tests de bout en bout :
nombre de tests réussis ou ignorés, et vitesse mesurée de la boucle à 50 %.

## Prérequis

- Node.js 22.12 ou plus récent (exigé par Vite 8 et Vitest 5).
- Un navigateur récent : Safari 17+, Chrome / Edge 120+, Firefox 120+.

## Lancer en local (ordinateur)

```bash
npm ci        # installe les versions exactes de package-lock.json
npm run dev
```

Ouvrez http://localhost:5173. `localhost` est un contexte sécurisé : le micro fonctionne sans HTTPS.
En mode `dev`, le service worker est désactivé (pas de cache qui masque vos modifications).

Autres commandes :

```bash
npm test            # tests unitaires (YIN, métronome, formats, MIDI, tablature, bibliothèque…)
npm run typecheck   # vérification TypeScript stricte (app, tests et tests e2e)
npm run build       # typecheck + build de production dans dist/ (avec service worker)
npm run preview     # sert dist/ sur http://localhost:4173
npx playwright install chromium   # une fois, avant les tests de bout en bout
npm run test:e2e    # tests de bout en bout sur le build (lancer « npm run build » avant)
```

Les tests de bout en bout utilisent un micro simulé (La 110 Hz généré au lancement) et des
partitions générées. Les quatre fichiers Guitar Pro de la suite de tests d'alphaTab sont
téléchargés par la CI ; en local, placez-les dans `e2e/fixtures/download/` pour activer ces tests
(voir l'étape « Download Guitar Pro test files » du workflow).

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

## Partitions (Phase 2)

**Formats.** Guitar Pro 3 à 8 (`.gp3`, `.gp4`, `.gp5`, `.gpx`, `.gp`) et MusicXML (`.musicxml`,
`.xml`, `.mxl`) sont lus par [alphaTab](https://alphatab.net) 1.8. alphaTab ne lit pas le MIDI :
l'app le convertit en MusicXML (rythmes arrondis à la double croche, une voix par piste, batterie
ignorée). Quand un fichier n'a pas de tablature (MIDI, MusicXML, PDF sans tablature), l'app la
calcule : chaque note est placée sur une corde et une case en limitant les déplacements de la main ;
un message invite à vérifier les doigtés.

**PDF.** Les PDF exportés par un logiciel de partition (MuseScore, Guitar Pro, Finale, Sibelius,
Dorico, LilyPond…) sont lus directement dans l'app, sans réseau : leurs symboles sont des caractères
de police musicale et leurs lignes des tracés vectoriels, que l'app lit avec
[pdf.js](https://mozilla.github.io/pdf.js/) à leur position exacte. Elle reconnaît les portées et
systèmes (y compris les portées masquées d'un système à l'autre), les clés (clé de sol octaviée),
armures, chiffrages, altérations, notes, accords, silences, hampes, ligatures, crochets, points,
n-olets, liaisons de prolongation, deux voix par portée, les reprises, le titre et le tempo. Une
tablature est lue chiffre par chiffre (corde, case) ; son rythme vient de la portée de notation
jumelle, des hampes sous la tablature (style Guitar Pro), ou à défaut de l'espacement des colonnes.
L'accordage est déduit des notes de la portée jumelle, ou lu dans le texte (« Tuning: D A D G B E »,
« ⑥ = D », « Drop D », « Tune down 1/2 step », capodastre). Le résultat est converti en MusicXML et
conservé dans la bibliothèque ; un message invite à vérifier notes et rythmes.

Les **tablatures texte** (« ASCII », lignes `e|---0---|` en police à chasse fixe, courantes sur les
sites de tablatures) sont lues aussi, qu'elles soient écrites en caractères dans le PDF ou collées
en image (capture d'écran) : pour ces dernières, une reconnaissance de caractères dédiée, sans
dépendance, retrouve la grille (tirets des cordes, pas des colonnes) puis lit chaque case (chiffre,
barre, nom de corde) par comparaison à des gabarits. L'accordage vient des noms de cordes
(`D|` en bas : drop D) ou du texte, le capodastre et le chiffrage du texte (« Capo 2 », « 3/4 »).
Une tablature texte n'écrit pas le rythme : il est déduit de la position des chiffres dans la
mesure (ou, sans barres, de leur espacement), et un message invite à le vérifier à l'écoute.

Une partition scannée (portées en image) n'est pas lisible : l'app l'explique et propose la
conversion par MuseScore ou Audiveris. Le code est dans `src/scores/pdf/` (extraction, mise en page,
notation, tablature, rythme, tablatures texte et reconnaissance en image, MusicXML).

**Sélection.** À la souris : cliquer-glisser d'une mesure à l'autre. Au doigt : appui long
(0,4 s) sur la première mesure, puis glisser ; un simple glissement fait défiler la partition.
« Par mesure » (activé par défaut) étend la sélection aux bords des mesures ; désactivé, on
choisit note par note. Un clic ou un toucher bref place le curseur sans effacer la sélection.

**Lecture.** Boucle activable, vitesse de 25 à 100 % par pas de 5 % (appui long pour aller
vite), bouton « Début » pour revenir au début du passage. L'écran reste allumé pendant la lecture.
La lecture se met en pause quand on quitte l'écran ou qu'on démarre l'accordeur.

**Bibliothèque.** Chaque fichier importé est conservé dans IndexedDB avec ses réglages (piste,
vitesse, boucle, sélection), restaurés à la réouverture. Renommer et supprimer (avec « Annuler »)
depuis la liste. En navigation privée, la partition s'ouvre mais n'est pas conservée.

**Hors-ligne.** alphaTab, sa police musicale (Bravura, 0,3 Mo), la banque de sons SONiVOX
(1 Mo) et pdf.js (1,8 Mo, chargé seulement à l'import d'un PDF) sont précachés avec l'app : une
partition déjà importée s'ouvre et se joue sans réseau, et un PDF s'importe hors-ligne.

**Limite connue d'alphaTab 1.8.4.** S'abonner à l'événement `midiLoaded` provoque une récursion
infinie (`AlphaSynthWebWorkerApi.loadedMidiInfo`) ; l'app utilise `playerReady` à la place.

## Vérifier les critères d'acceptation de la Phase 2

Automatique (CI, job **e2e**, profils ordinateur et mobile) :

- un fichier GP3, GP5, GPX, GP7, MusicXML, MXL et MIDI s'affiche avec sa tablature ;
- un PDF de partition (gravé par alphaTab puis imprimé par Chromium pendant le test) est lu dans
  l'app : mêmes notes, mesures, positions et durées que la partition d'origine, tablature
  comprise ; une tablature texte imprimée en PDF, en caractères comme en image, donne les mêmes
  cases et l'accordage écrit ; un PDF sans musique ou illisible est expliqué, sans rien ajouter à
  la bibliothèque ;
- la sélection des mesures 5 à 8 (glissé souris, ou appui long + glissé au doigt) donne la bonne
  plage de lecture ; à 50 %, la lecture reste dans le passage, revient au début sans trou
  (jamais plus de 300 ms sans avancer, bouclage compris) et avance à la moitié du tempo ;
- la bibliothèque, la sélection et la vitesse sont retrouvées après rechargement ;
- hors-ligne, une partition importée s'ouvre et le son se charge depuis le cache.

Manuel (téléphone) : importez un fichier, appui long sur la mesure 5, glissez jusqu'à la 8,
réglez 50 %, touchez « Lire » : le passage boucle sans pause audible. Fermez l'app, passez
en mode avion, rouvrez-la : la partition est dans la bibliothèque et se joue.

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
  scores/               formats, conversion MIDI, tablature, bibliothèque IndexedDB,
                        lecteur alphaTab, sélection souris / doigt, écran Partitions
    pdf/                lecture des PDF : extraction pdf.js, portées et systèmes, notation,
                        tablature et accordage, rythme et voix, tablatures texte (caractères
                        ou image, reconnaissance dédiée), écriture MusicXML
  ui/                   helpers DOM, appui long, messages d'erreur en français
tests/                  tests Vitest (unitaires)
e2e/                    tests Playwright (bout en bout)
public/                 favicon et icônes PWA (font/ et soundfont/ copiés par le build)
```
