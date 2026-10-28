# Proxy de Pratique Guitare

Petit service gratuit (Cloudflare Workers) qui permet à l'app, publiée sur GitHub Pages, de télécharger une partition publique trouvée sur un autre site. Sans lui, le navigateur bloque ces téléchargements (règle CORS).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Django184/guitar/tree/main/proxy)

## Installation (une fois, 2 minutes)

1. Cliquez sur le bouton ci-dessus et connectez-vous à Cloudflare.
2. Acceptez les choix proposés, puis cliquez sur **Create and deploy**. Cloudflare copie ce dossier dans votre GitHub et publie le service.
3. Copiez l'adresse affichée à la fin, de la forme `https://pratique-guitare-proxy.<votre-nom>.workers.dev`.
4. Dans l'app, ouvrez une partition, puis **Rythme** → **Réglages**, et collez cette adresse.

L'offre gratuite de Cloudflare permet 100 000 requêtes par jour : bien plus que nécessaire.

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
