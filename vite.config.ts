import { alphaTab } from '@coderline/alphatab-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Couleur de fond du thème sombre (par défaut), reprise par l'écran de démarrage.
const ROSEWOOD = '#1a1311';

// Hôtes autorisés pour tester sur téléphone via un tunnel HTTPS (voir README).
const TUNNEL_HOSTS = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app'];

// Chemin de publication : « / » (Cloudflare Pages, https://pratique-guitare.pages.dev, depuis 1.2.0 ;
// avant : « /guitar/ » sur GitHub Pages).
const BASE = process.env.BASE_PATH ?? '/';

// Version publiée (commit), lue par le test de fumée pour savoir que le nouveau site est en ligne.
const APP_VERSION = process.env.APP_VERSION ?? 'dev';

// Version sémantique : une seule source, package.json (affichée dans Réglages avec le commit).
const APP_SEMVER = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

/**
 * Politique de sécurité du contenu (ECOSYSTEME.md §8.3), écrite une seule fois : balise <meta> dans la
 * page (vérifiée par les tests de bout en bout, qui servent le build sans en-têtes) et en-tête HTTP
 * dans `_headers` (Cloudflare Pages), avec `frame-ancestors`, qui n'agit qu'en en-tête.
 * Exceptions, toutes liées à une fonction :
 * - YouTube (D-007) : API IFrame (script), lecteur intégré (cadre), recherche (googleapis), vignettes ;
 * - BitMidi et le proxy de l'utilisateur (*.workers.dev) : transcriptions pour retrouver le rythme ;
 * - `blob:` : Worker de l'horloge du métronome, enregistrement de référence lu depuis la bibliothèque ;
 * - `'wasm-unsafe-eval'` : décodeurs d'images de pdf.js ;
 * - `style-src 'unsafe-inline'` : alphaTab pose ses propres balises <style> (police musicale, curseurs).
 */
function csp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.map((h) => `'${h}'`).join(' ')} 'wasm-unsafe-eval' blob: https://www.youtube.com https://s.ytimg.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.ytimg.com",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' blob: data: https://www.googleapis.com https://bitmidi.com https://*.workers.dev",
    "worker-src 'self' blob:",
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

const inlineScriptHashes = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `sha256-${createHash('sha256').update(m[1] ?? '').digest('base64')}`,
  );

let builtCsp = '';

export default defineConfig({
  base: BASE,
  define: { __APP_SEMVER__: JSON.stringify(APP_SEMVER) },
  server: {
    host: true,
    allowedHosts: TUNNEL_HOSTS,
  },
  preview: {
    host: true,
    allowedHosts: TUNNEL_HOSTS,
  },
  plugins: [
    {
      name: 'app-version',
      transformIndexHtml: (html: string) => html.replace('%APP_VERSION%', APP_VERSION),
    },
    {
      // Au build seulement : en développement, Vite injecte ses propres scripts en ligne.
      name: 'securite',
      apply: 'build',
      // Après la production de index.html : la politique de l'en-tête est celle de la page.
      enforce: 'post',
      transformIndexHtml: {
        order: 'post',
        handler(html: string) {
          builtCsp = csp(inlineScriptHashes(html));
          return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${builtCsp}" />`);
        },
      },
      generateBundle(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type === 'asset') {
          const html = String(page.source);
          builtCsp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? builtCsp;
        }
        if (!builtCsp) this.error('Politique de sécurité introuvable dans index.html');
        const headers = [
          '/*',
          `  Content-Security-Policy: ${builtCsp}; frame-ancestors 'none'`,
          '  X-Content-Type-Options: nosniff',
          '  Referrer-Policy: strict-origin-when-cross-origin',
          '  Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=()',
          '/sw.js',
          '  Cache-Control: no-cache',
          '/version.json',
          '  Cache-Control: no-cache',
          '',
        ].join('\n');
        this.emitFile({ type: 'asset', fileName: '_headers', source: headers });
        this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version: APP_SEMVER, commit: APP_VERSION })}\n` });
      },
    },
    // alphaTab : Web Worker de rendu, Audio Worklet du synthétiseur, police Bravura
    // (public/font/) copiés à chaque build (sa banque SONiVOX, public/soundfont/, ne sert plus :
    // l'app joue GeneralUser GS, public/sons/).
    alphaTab(),
    VitePWA({
      // « prompt » : la mise à jour ne recharge jamais la page en pleine séance de métronome.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        id: BASE,
        name: 'Pratique Guitare',
        short_name: 'Guitare',
        description: 'Accordeur, métronome et partitions pour travailler la guitare.',
        lang: 'fr',
        dir: 'ltr',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'any',
        background_color: ROSEWOOD,
        theme_color: ROSEWOOD,
        categories: ['music', 'education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Hors-ligne complet : app, alphaTab, lecteur de PDF (pdf.js et son worker .mjs),
        // police musicale (woff2), police des chiffres (woff) et banque de sons (GeneralUser GS en sf3, 13,5 Mo).
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico}', 'font/Bravura.woff2', 'assets/*.woff', 'sons/*.sf3'],
        globIgnores: ['font/Bravura.svg'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
