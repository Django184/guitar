# Proxy de Pratique Guitare

Petit service gratuit (Cloudflare Workers) qui permet à l'app, publiée sur GitHub Pages, de télécharger une partition publique trouvée sur un autre site. Sans lui, le navigateur bloque ces téléchargements (règle CORS).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Django184/guitar/tree/main/proxy)

## Installation (une fois, 2 minutes)

Deux façons, au choix :

- **Relier tout le dépôt** (Workers & Pages → Create → Import a repository → `guitar`) : la
  configuration à la racine du dépôt (`wrangler.jsonc`) déploie ce proxy. Réglages de build : pas
  de commande de build, commande de déploiement `npx wrangler deploy`, dossier racine vide. Le
  Worker doit s'appeler `guitar` (sinon, changer `name` dans `wrangler.jsonc`).
- **Bouton ci-dessus** : Cloudflare copie ce dossier dans votre GitHub et le publie.

Ensuite :

1. Ouvrez l'adresse du Worker (onglet **Domains**, ligne « Production »), de la forme
   `https://guitar.<votre-nom>.workers.dev`. Elle doit afficher
   `{"ok":true,"name":"pratique-guitare-proxy","version":1}`.
2. Dans l'app, ouvrez **Réglages** (roue dentée en haut à droite) → **Proxy des partitions**,
   collez cette adresse et touchez **Enregistrer** (« Proxy prêt »).

À chaque modification du dépôt, Cloudflare redéploie le proxy tout seul. L'offre gratuite de
Cloudflare permet 100 000 requêtes par jour : bien plus que nécessaire.

## Garde-fous

- Seules les pages de l'app peuvent l'utiliser (`https://django184.github.io`, et `localhost` pour le développement). D'autres adresses peuvent être ajoutées dans la variable `ALLOWED_ORIGINS`.
- GET seulement, 8 Mo au plus par fichier.
- Il ne renvoie que des partitions (MIDI, MusicXML, Guitar Pro), reconnues à leur contenu. Les pages web et les autres fichiers sont refusés.
- Les sites dont les conditions interdisent l'accès automatisé (MuseScore, Songsterr, Ultimate Guitar) sont refusés. Leurs fichiers s'importent à la main dans l'app.
- Pas d'adresse IP ni de réseau interne.

## Routes

| Route | Rôle |
| --- | --- |
| `GET /` | Test de connexion : `{ "ok": true, "version": 1 }` |
| `GET /fetch?url=…` | Le fichier, s'il s'agit d'une partition |
| `GET /search?q=…` | Partitions trouvées dans les archives publiques (BitMidi) |

## Développement

```sh
cd proxy
npm install
npm run dev
```
