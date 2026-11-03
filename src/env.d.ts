/** Variables de build (fichier .env ou CI). */
interface ImportMetaEnv {
  /** Clé de l'API YouTube Data v3 (recherche de vidéos), restreinte au site publié. */
  readonly VITE_YOUTUBE_API_KEY?: string;
}

/** Version sémantique (package.json), injectée au build par vite.config.ts. */
declare const __APP_SEMVER__: string;
