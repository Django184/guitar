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
   - Android (Chrome) : menu ⋮ › « Installer l'application » (ou Réglages › « Installer l'app »).
   - Ordinateur (Chrome / Edge) : Réglages › « Installer l'app », ou icône dans la barre d'adresse.
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

Les **tablatures dessinées en image** (cordes en traits continus, cases posées dans une
interruption du trait : exports de logiciels ou de sites, souvent une image par ligne) sont lues de
la même façon : cordes retrouvées comme traits fins également espacés (les noms cerclés, flèches et
bandeaux grisés qui les précèdent sont écartés), traits effacés, puis chaque case lue par les mêmes
gabarits, en noir comme en couleur ; les notes alignées verticalement sont jouées ensemble, les
barres verticales au milieu de la ligne découpent les mesures. Le texte de la page donne le titre,
l'accordage et le capodastre (« STANDARD TUN CAPO FRET 4 »).

**Interface.** Une action principale par écran, en bas, sous le pouce (Démarrer, Lire,
Importer). Ce qui se règle une fois va dans **Réglages** (roue dentée de la barre du haut :
thème, diapason, proxy des partitions, clé YouTube, installation) ; ce qui concerne une partition
dans ses **options** (⋯ dans le lecteur : piste, doigtés, sélection par mesure, puis Rythme,
Enrichir, Vidéo de référence, qui ouvrent chacun leur panneau). Pendant la lecture, la barre du
haut s'efface au profit de la partition. Titres et chiffres (tempo, notes, vitesse) sont en
Barlow Condensed (licence OFL, `public/fonts/`) ; le reste en police système.

**Vidéo de référence et rythme calé.** « Vidéo de référence » (options ⋯ du lecteur) lie à la partition un
enregistrement : une vidéo YouTube (trouvée automatiquement à partir du titre, ou lien collé), un
fichier audio, ou une vidéo (un enregistrement d'écran, par exemple) dont l'app ne garde que le son.
La vidéo YouTube est jouée par le lecteur officiel, jamais téléchargée : l'app ne lit que sa
position. Deux façons de caler la partition dessus :

- **Taper le rythme** : pendant l'écoute (ralentie au besoin), on touche « Note » (ou la barre
  d'espace) à chaque note ou accord ; le curseur montre la note attendue ;
- **Écoute automatique** : l'app retrouve elle-même chaque note de la tablature dans le son
  (attaques du flux spectral, ce qui apparaît à chaque attaque ramené à ses 12 classes de hauteur,
  puis appariement ordonné avec les notes, transposition comprise). Un fichier audio est analysé
  directement. Le son d'une vidéo YouTube n'est pas accessible au site ; il arrive à l'analyse sans
  micro ni haut-parleurs :
  - **sur ordinateur (Chrome, Edge)**, par le partage du son de l'onglet (`getDisplayMedia`) pendant
    que la vidéo joue : le son est capté avant la carte son, rien n'est écrit dans un fichier ;
  - **sur iPhone ou Android**, par un enregistrement d'écran (Centre de contrôle → Enregistrement
    de l'écran, micro coupé ; ou l'enregistreur d'Android avec les sons multimédias) importé dans
    l'app et analysé aussitôt. La piste AAC est lue directement dans le conteneur MP4 / MOV et
    réécrite en flux ADTS (Safari ne décode pas les .mov de l'iPhone tels quels), sans rejouer la
    vidéo ; seul le son est gardé (WAV mono 32 kHz, silence retiré), sur l'appareil, à la place de
    la vidéo ;
  - en dernier recours (hors iPhone, sans partage d'onglet), au micro pendant la lecture.

Pour une tablature texte, les instants trouvés donnent le rythme : une programmation dynamique
sur (position dans la mesure, tempo) arrondit chaque écart à la double croche en laissant le tempo
varier doucement (barres de mesure respectées quand la tablature en avait). L'aperçu se garde ou
s'annule, et « Valeurs ×2 / ÷2 » corrige une lecture au tempo double ou moitié. Pour toute partition,
le calage donne des points de synchronisation : avec « Suivre la vidéo », c'est l'enregistrement
qui joue (vitesse, boucle et passage compris) et le curseur le suit.

La recherche automatique utilise l'API YouTube Data v3 avec une clé gratuite (Google Cloud),
restreinte au site publié : variable de dépôt `YOUTUBE_API_KEY` (Settings → Secrets and variables
→ Actions → Variables), lue au build (`VITE_YOUTUBE_API_KEY`), ou clé saisie dans Réglages (gardée sur
l'appareil). Sans clé, l'app ouvre la recherche YouTube et on colle le lien.

Une partition scannée (portées en image) n'est pas lisible : l'app l'explique et propose la
conversion par MuseScore ou Audiveris. Le code est dans `src/scores/pdf/` (extraction, mise en page,
notation, tablature, rythme, tablatures texte et reconnaissance en image, MusicXML).

**Sélection.** À la souris : cliquer-glisser d'une mesure à l'autre. Au doigt : appui long
(0,4 s) sur la première mesure, puis glisser ; un simple glissement fait défiler la partition.
« Sélection par mesure » (options ⋯, activé par défaut) étend la sélection aux bords des mesures ; désactivé, on
choisit note par note. Un clic ou un toucher bref place le curseur sans effacer la sélection.

**Lecture.** Une seule rangée sous la partition : retour au début du passage, Lire, boucle,
vitesse de 25 à 100 % par pas de 5 % (appui long pour aller vite). L'écran reste allumé pendant la lecture.
La lecture se met en pause quand on quitte l'écran ou qu'on démarre l'accordeur.

**Bibliothèque.** Chaque fichier importé est conservé dans IndexedDB avec ses réglages (piste,
vitesse, boucle, sélection), restaurés à la réouverture. Renommer et supprimer (avec « Annuler »)
depuis la liste. En navigation privée, la partition s'ouvre mais n'est pas conservée.

**Doigtés de la main gauche.** Sur la tablature, une pastille colorée à gauche de chaque case
indique le doigt (1 index, 2 majeur, 3 annulaire, 4 auriculaire, T pouce), comme dans les méthodes ;
« Doigtés » (options ⋯) les affiche ou les masque. Ils sont optimisés sur toute la pièce par
programmation dynamique (Viterbi, `src/scores/fingering/`), et non note par note :

- chaque instant où une note frettée commence a pour états les affectations jouables de doigts aux
  notes qui sonnent (écart de 4 cases, 5 en position haute ou faute de mieux ; barré de l'index,
  ou de l'annulaire sur des cordes voisines ; pouce sur les deux cordes graves) ;
- coût propre : écartement (progressif), doigts serrés, auriculaire, barré, pouce ; coût de
  passage : déplacement de la main (surtout le fait de bouger, pondéré par le temps disponible),
  même case jouée d'un autre doigt, doigt qui saute d'une note à l'autre, hammer-on ou pull-off
  d'un même doigt, glissé changeant de doigt ; une note qui sonne encore garde son doigt (ou est
  lâchée, moyennant un coût) ;
- second passage : un accord ou motif qui revient garde de préférence son doigté le plus fréquent.

Les doigts écrits dans un fichier Guitar Pro sont respectés. Toucher une pastille ouvre un menu
(1, 2, 3, 4, T, Auto) : le doigt choisi est imposé et le reste de la pièce se réorganise autour ;
les corrections sont gardées avec la partition (effacées si son rythme est réécrit). Sur la
capture d'exemple fournie, les mesures 1 et 6 sont reproduites à l'identique, et 24 doigts sur 28
des mesures 4 à 6, non utilisées pour le réglage, coïncident (les autres sont des variantes
jouables). Calcul : environ 0,2 s pour un morceau de 400 attaques.

**Rythme retrouvé dans des transcriptions.** Une tablature lue dans un PDF n'a pas de rythme : il
est deviné d'après l'espacement des chiffres. « Rythme » (options ⋯, ou le lien « Retrouver le
rythme » sous le titre) le retrouve dans des
transcriptions du même morceau, sans toucher aux notes (cordes et cases restent celles de la
tablature) — `src/scores/rhythm/` :

1. **Recherche** : [BitMidi](https://bitmidi.com) (archive publique de fichiers MIDI, logiciel libre,
   interface ouverte aux autres sites) est interrogé avec le titre, et ses fichiers téléchargés
   directement. D'autres sources s'ajoutent à la main : liens trouvés par Claude (bouton
   « Demander à Claude » : claude.ai s'ouvre avec un message prérempli, à envoyer ; on colle sa
   réponse, un petit JSON, dans l'app), ou fichiers importés (Guitar Pro, MusicXML, MIDI).
   MuseScore, Songsterr et Ultimate Guitar interdisent l'accès automatisé : leurs fichiers
   s'importent à la main.
2. **Alignement** de la tablature dans chaque transcription : hauteurs des notes seulement,
   transposition et octave estimées, programmation dynamique qui suit toute la tablature et saute
   l'introduction, la fin et l'accompagnement (une paire dans un accord épais prouve moins qu'une
   note seule). Chaque piste est essayée, et la voix du dessus d'un piano à part. Contrôle : la même
   recherche avec la tablature à l'envers ; une transcription n'est retenue que si elle fait
   nettement mieux (sinon c'est un autre morceau dans la même tonalité).
3. **Vote** : pour chaque paire de notes consécutives, chaque source retenue donne l'écart qui les
   sépare (ramené à l'échelle de la référence si elle écrit en valeurs doublées). L'écart le plus
   soutenu l'emporte. La référence — une version pour guitare, sinon la source la plus fiable —
   donne la mesure, le chiffrage et le tempo.
   Les mesures où les sources se contredisent, ou qu'aucune ne couvre, sont surlignées dans
   l'aperçu, avec un bouton par mesure pour l'écouter en boucle.
4. **Aperçu** (portée et tablature), puis « Garder » ou « Annuler ».

Calibrage (corpus music21 : quatuors, sonates, ragtime) : la bonne pièce, même réduite au piano,
transposée et en valeurs doublées, obtient une vraisemblance d'au moins 0,8 par note et 0,45 de
plus qu'à l'envers ; une autre pièce du même style, au plus 0,4 et 0,15. Avec deux sources, les
écarts entre notes sont justes à 98-100 %.

Les liens d'autres sites passent par un **proxy** gratuit que l'on installe sur son propre compte
Cloudflare (dossier `proxy/` ; on relie tout le dépôt, la configuration `wrangler.jsonc` à la
racine le déploie, ou bouton « Deploy to Cloudflare » de son [README](proxy/README.md)) : il ne
sert que les pages de l'app et ne renvoie que des partitions.
Son adresse se colle une fois dans Réglages › « Proxy des partitions ».

**Enrichissement (désactivé par défaut).** « Enrichir » (options ⋯) propose d'ajouter à la tablature
des notes prises dans les transcriptions qui la contiennent (`src/scores/embellish/`) : la basse et
des notes de l'accord sur les temps, et les notes de passage de la mélodie d'une source entre deux
notes de la tablature. Chaque note proposée doit être :

- **jouable** : corde libre, case à vide ou dans la position de la main (4 cases d'écart, 5 en
  position haute, d'après les notes jouées au même instant ou juste autour), forme tenable à quatre
  doigts (barré compris, sans pouce : vérifié par l'optimiseur de doigtés) ; au plus deux notes
  ajoutées par temps ;
- **cohérente** : présente dans au moins la moitié des sources qui couvrent cet instant, sans
  frottement d'un demi-ton avec les notes déjà là, sous la mélodie (qui reste en haut).

Les notes ajoutées s'affichent en couleur dans un aperçu (portée et tablature), entourées ; un appui
en retire une, un bouton par famille (Basse, Accords, Passages) les retire ou les remet toutes.
« Garder » les écrit dans la tablature.

**Banque de sons.** La lecture utilise [GeneralUser GS](https://www.schristiancollins.com/generaluser)
2.0.3 de S. Christian Collins : la banque General MIDI gratuite la plus recommandée (261 instruments,
13 batteries), sous une licence qui autorise son usage et sa modification dans un logiciel
(`public/sons/GeneralUser-GS-LICENSE.txt`). Elle remplace SONiVOX (1 Mo), la banque d'exemple
d'alphaTab, très sommaire. Autre raison du choix : ses 920 échantillons sont tous mono, or le
synthétiseur d'alphaTab 1.8.4 ignore les échantillons stéréo — avec MS Basic (MuseScore 4) ou
FluidR3Mono, le piano et plusieurs cordes seraient muets.

Le synthétiseur d'alphaTab (un portage de TinySoundFont) s'écarte de la norme SoundFont : il ignore
les modulateurs, le décalage de début des échantillons en SF3, et additionne certaines valeurs de
la zone globale à celles des zones. `scripts/sf2-to-sf3.py` prépare donc la banque pour lui, à partir
du SF2 d'origine (dépôt [mrbumpy409/GeneralUser-GS](https://github.com/mrbumpy409/GeneralUser-GS),
commit `684543d`, SHA-256 `9575028c…cfe`) :

- échantillons compressés en Ogg Vorbis (qualité 0,8, −1 dB, réglages conseillés par l'auteur),
  suivis d'un peu de silence pour que le décodage couvre toujours l'original : 32 → 13,5 Mo ;
- décalages de début et points de boucle inscrits dans les échantillons (copies découpées) ;
- atténuation et accord écrits zone par zone, atténuation × 0,4 comme FluidSynth (lecteur de
  référence de la banque) ;
- effet des modulateurs de vélocité et de hauteur (ouverture du filtre, enveloppes) calculé pour
  la nuance « f » d'alphaTab (vélocité 95) et inscrit dans les réglages.

Vérification (moteur d'alphaTab exécuté depuis ses sources, une note par instrument, comparé à
FluidSynth jouant le SF2 d'origine) : aucun instrument muet ; volume à ±1,5 dB de FluidSynth
(écart-type, 134 sons), guitares à ±0,6 dB, basses à ±1,1 dB ; timbre (centre spectral) à 1,4 demi-ton près
en médiane, contre 7,6 pour SONiVOX ; crêtes d'un accord de six cordes comparables à SONiVOX.
Écarts restants : quelques sons de synthé (enveloppe de filtre propre à alphaTab), et ni
réverbération ni chorus (non pris en charge par alphaTab).

**Hors-ligne.** alphaTab, sa police musicale (Bravura, 0,3 Mo), la banque de sons (13,5 Mo) et
pdf.js (1,8 Mo, chargé seulement à l'import d'un PDF) sont précachés avec l'app : une partition
déjà importée s'ouvre et se joue sans réseau, et un PDF s'importe hors-ligne.

**Limite connue d'alphaTab 1.8.4.** S'abonner à l'événement `midiLoaded` provoque une récursion
infinie (`AlphaSynthWebWorkerApi.loadedMidiInfo`) ; l'app utilise `playerReady` à la place.

## Vérifier les critères d'acceptation de la Phase 2

Automatique (CI, job **e2e**, profils ordinateur et mobile) :

- un fichier GP3, GP5, GPX, GP7, MusicXML, MXL et MIDI s'affiche avec sa tablature ;
- un PDF de partition (gravé par alphaTab puis imprimé par Chromium pendant le test) est lu dans
  l'app : mêmes notes, mesures, positions et durées que la partition d'origine, tablature
  comprise ; une tablature texte imprimée en PDF, en caractères comme en image, donne les mêmes
  cases et l'accordage écrit ; une tablature dessinée en image (cordes en traits, noms cerclés)
  donne les mêmes cases, cordes, accords et capodastre ; un PDF sans musique ou illisible est expliqué, sans rien ajouter à
  la bibliothèque ;
- une tablature texte jouée avec un autre rythme que son espacement (guitare synthétisée, fichier
  WAV) est recalée par l'écoute automatique comme en tapant le rythme : positions et tempo exacts,
  lecture qui suit l'enregistrement, calage conservé à la réouverture ;
- le même jeu dans un enregistrement d'écran (vidéo QuickTime, son AAC) donne le même rythme : seul
  le son est gardé ; avec une vidéo YouTube (lecteur simulé), le son de l'onglet (ordinateur) ou un
  enregistrement d'écran importé depuis l'écoute automatique (téléphone) recalent le rythme sans
  micro ;
- la sélection des mesures 5 à 8 (glissé souris, ou appui long + glissé au doigt) donne la bonne
  plage de lecture ; à 50 %, la lecture reste dans le passage, revient au début sans trou
  (jamais plus de 300 ms sans avancer, bouclage compris) et avance à la moitié du tempo ;
- la bibliothèque, la sélection et la vitesse sont retrouvées après rechargement ;
- une tablature texte au rythme deviné retrouve son rythme dans des transcriptions (BitMidi
  simulé : guitare, piano en valeurs doublées, autre morceau du même nom écarté) : positions et
  tempo exacts, mesure où les sources se contredisent surlignée et jouable en boucle ; les liens
  donnés par Claude passent par le proxy (simulé), un fichier importé s'ajoute au vote ;
- l'enrichissement, désactivé par défaut, ajoute des notes en couleur (une par anneau), une note
  retirée d'un appui disparaît de l'aperçu, et les notes gardées sont dans la tablature ;
- les doigtés s'affichent sur la tablature (une pastille par note frettée), une correction
  faite à la main est gardée à la réouverture, et « Doigtés » (options ⋯) les masque ;
- hors-ligne, une partition importée s'ouvre et le son se charge depuis le cache ; la banque
  utilisée est GeneralUser GS (et, en test unitaire, le fichier livré respecte ce qu'exige le
  synthétiseur d'alphaTab : échantillons mono, blocs RIFF pairs, zones sans valeurs additives).

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
    fingering/          doigtés de la main gauche : optimisation (Viterbi), lien avec la
                        partition, pastilles et menu de correction
    embellish/          enrichissement : basse, accords et notes de passage jouables, aperçu
    rhythm/             rythme retrouvé dans des transcriptions : recherche (BitMidi, Claude,
                        proxy), lecture des sources, alignement, vote, panneau Rythme
    sync/               enregistrement de référence : YouTube (lecteur, recherche), fichier
                        audio, son d'une vidéo MP4 / MOV, son de l'onglet, micro, alignement
                        audio, rythme et tempo retrouvés, panneau Vidéo
  ui/                   helpers DOM, appui long, messages d'erreur en français
tests/                  tests Vitest (unitaires) ; fixtures/ : vidéos de test (sons synthétisés)
e2e/                    tests Playwright (bout en bout)
public/                 favicon et icônes PWA, sons/ : banque de sons GeneralUser GS et sa licence
                        (font/ et soundfont/ copiés par le build)
proxy/                  proxy Cloudflare Workers (gratuit, à installer sur son compte) : partitions
                        d'autres sites pour l'app
scripts/                sf2-to-sf3.py : préparation d'une banque SF2 pour alphaTab (FFmpeg, libvorbis)
```
