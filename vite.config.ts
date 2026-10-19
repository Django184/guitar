import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Couleur de fond du thème sombre (par défaut), reprise par l'écran de démarrage.
const ROSEWOOD = '#1a1311';

// Hôtes autorisés pour tester sur téléphone via un tunnel HTTPS (voir README).
const TUNNEL_HOSTS = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app'];

// Chemin de publication : « / » en local, « /guitar/ » sur GitHub Pages (fixé par la CI).
const BASE = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: BASE,
  server: {
    host: true,
    allowedHosts: TUNNEL_HOSTS,
  },
  preview: {
    host: true,
    allowedHosts: TUNNEL_HOSTS,
  },
  plugins: [
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
