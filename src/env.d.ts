/** Variables de build (fichier .env ou CI). */
interface ImportMetaEnv {
  /** Clé de l'API YouTube Data v3 (recherche de vidéos), restreinte au site publié. */
  readonly VITE_YOUTUBE_API_KEY?: string;
}
