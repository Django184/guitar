/**
 * YouTube : lecteur intégré (API IFrame), liens, et recherche (API YouTube Data v3, avec la clé
 * de l'utilisateur). La vidéo n'est jamais téléchargée : le lecteur officiel la joue, et l'app
 * lit seulement sa position.
 */
import { MediaClock, type MediaState, type ReferenceMedia } from './media';

const ID = /^[A-Za-z0-9_-]{11}$/;

/** Identifiant de vidéo dans un lien YouTube (ou l'identifiant seul) ; null sinon. */
export function parseYouTubeUrl(text: string): string | null {
  const value = text.trim();
  if (ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    if (!id) {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = m?.[1] ?? null;
    }
  }
  return id && ID.test(id) ? id : null;
}

/** Recherche à partir du titre de la partition : sans « tab », « partition »…, plus « guitar ». */
export function searchQuery(title: string, artist = ''): string {
  const cleaned = `${title} ${artist}`
    .replace(/\b(tabs?|tablatures?|partitions?|sheet music|score|pdf|v\d+(\.\d+)*)\b/gi, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /guitar|guitare/i.test(cleaned) ? cleaned : `${cleaned} guitar`.trim();
}

export const youtubeSearchUrl = (query: string): string => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

const KEY_STORAGE = 'pg.youtubeKey';

/** Clé de l'API YouTube : saisie dans l'app (cet appareil), sinon celle intégrée au site. */
export function youtubeKey(): string {
  try {
    const own = localStorage.getItem(KEY_STORAGE);
    if (own) return own;
  } catch {
    // Stockage indisponible : clé du site.
  }
  // Clé intégrée au build (variable VITE_YOUTUBE_API_KEY de la CI), absente hors de Vite.
  const builtIn: unknown = import.meta.env?.VITE_YOUTUBE_API_KEY;
  return typeof builtIn === 'string' ? builtIn.trim() : '';
}

export function saveYoutubeKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Navigation privée : la clé ne sera pas retenue.
  }
}

export interface VideoResult {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
}

export type SearchProblem = 'key' | 'quota' | 'referer' | 'network';

export class SearchError extends Error {
  constructor(
    readonly problem: SearchProblem,
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface SearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> };
  }>;
  error?: { message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
}

/** Vidéos intégrables correspondant à la recherche (8 au plus). */
export async function searchYouTube(query: string, key: string, fetchFn: typeof fetch = fetch): Promise<VideoResult[]> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '8',
    q: query,
    key,
  });
  let response: Response;
  try {
    response = await fetchFn(`https://www.googleapis.com/youtube/v3/search?${params}`);
  } catch {
    throw new SearchError('network', 'Recherche impossible : vérifiez la connexion.');
  }
  const body = (await response.json().catch(() => ({}))) as SearchResponse;
  if (!response.ok) {
    const reasons = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])].map((e) => e.reason ?? '').join(' ');
    if (/quota|dailyLimit|rateLimit/i.test(reasons)) {
      throw new SearchError('quota', 'Le quota de recherches YouTube du jour est épuisé : collez un lien, ou réessayez demain.');
    }
    if (/referer|referrer/i.test(reasons)) {
      throw new SearchError('referer', "La clé YouTube n'autorise pas ce site : ajoutez son adresse aux restrictions de la clé.");
    }
    if (/key|forbidden|badRequest|API_KEY/i.test(reasons) || response.status === 400 || response.status === 403) {
      throw new SearchError('key', 'La clé YouTube est refusée : vérifiez-la (API « YouTube Data API v3 » activée ?).');
    }
    throw new SearchError('network', 'Recherche YouTube indisponible pour le moment.');
  }
  return (body.items ?? [])
    .map((item) => ({
      id: item.id?.videoId ?? '',
      title: decodeEntities(item.snippet?.title ?? ''),
      channel: decodeEntities(item.snippet?.channelTitle ?? ''),
      thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? '',
    }))
    .filter((v) => ID.test(v.id));
}

/* ------------------------------------------------------------------ */
/* Lecteur                                                             */
/* ------------------------------------------------------------------ */

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  setVolume(volume: number): void;
  getVolume(): number;
  getVideoData?(): { title?: string; author?: string };
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      host?: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadIframeApi(): Promise<YTNamespace> {
  const w = window as Window & { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
  if (w.YT?.Player) return Promise.resolve(w.YT);
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      apiPromise = null;
      reject(new Error("YouTube n'a pas pu être chargé : vérifiez la connexion."));
    }, 20000);
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      resolve(w.YT as YTNamespace);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      apiPromise = null;
      reject(new Error("YouTube n'a pas pu être chargé : vérifiez la connexion."));
    };
    document.head.append(script);
  });
  return apiPromise;
}

const ERRORS: Record<number, string> = {
  2: 'Lien YouTube invalide.',
  5: 'Cette vidéo ne peut pas être lue dans le navigateur.',
  100: "Cette vidéo n'existe plus ou est privée.",
  101: "L'auteur de cette vidéo interdit sa lecture hors de YouTube : choisissez-en une autre.",
  150: "L'auteur de cette vidéo interdit sa lecture hors de YouTube : choisissez-en une autre.",
};

/** Vidéo YouTube jouée par le lecteur officiel intégré. */
export class YouTubeMedia implements ReferenceMedia {
  readonly element: HTMLElement;
  private player: YTPlayer | null = null;
  private readonly clock = new MediaClock();
  private listeners: Array<(state: MediaState, message?: string) => void> = [];
  private state = -1;
  private frame = 0;
  private rate = 1;
  private pendingSeek: number | null = null;

  private constructor(readonly id: string) {
    const target = document.createElement('div');
    this.element = document.createElement('div');
    this.element.className = 'media__video';
    this.element.append(target);
  }

  /** Crée le lecteur ; l'élément doit être inséré dans la page avant la fin du chargement. */
  static create(id: string): { media: YouTubeMedia; ready: Promise<void> } {
    const media = new YouTubeMedia(id);
    const ready = loadIframeApi().then(
      (YT) =>
        new Promise<void>((resolve, reject) => {
          const target = media.element.firstElementChild as HTMLElement;
          media.player = new YT.Player(target, {
            videoId: id,
            host: 'https://www.youtube-nocookie.com',
            width: '100%',
            height: '100%',
            playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
            events: {
              onReady: () => {
                media.emit('ready');
                resolve();
              },
              onStateChange: (e) => media.onStateChange(e.data),
              onError: (e) => {
                const message = ERRORS[e.data] ?? 'La vidéo ne peut pas être lue.';
                media.emit('error', message);
                reject(new Error(message));
              },
            },
          });
        }),
    );
    return { media, ready };
  }

  private emit(state: MediaState, message?: string): void {
    this.listeners.forEach((l) => l(state, message));
  }

  private onStateChange(data: number): void {
    this.state = data;
    const player = this.player;
    if (player) this.clock.observe(player.getCurrentTime(), data === 1, this.rate);
    if (data === 1) {
      if (this.pendingSeek !== null) this.pendingSeek = null;
      this.emit('playing');
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(this.poll);
    } else if (data === 2) this.emit('paused');
    else if (data === 0) this.emit('ended');
  }

  private readonly poll = (): void => {
    const player = this.player;
    if (!player || this.state !== 1) return;
    this.clock.observe(player.getCurrentTime(), true, this.rate);
    this.frame = requestAnimationFrame(this.poll);
  };

  get duration(): number {
    return this.player?.getDuration() ?? 0;
  }

  /** Titre et chaîne de la vidéo (connus une fois le lecteur prêt). */
  get info(): { title: string; channel: string } {
    const data = this.player?.getVideoData?.() ?? {};
    return { title: data.title ?? '', channel: data.author ?? '' };
  }

  get playing(): boolean {
    return this.state === 1;
  }

  currentTime(): number {
    if (this.pendingSeek !== null) return this.pendingSeek;
    return this.clock.estimate(this.state === 1, this.rate);
  }

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  seek(seconds: number): void {
    const t = Math.max(0, seconds);
    this.clock.reset();
    this.pendingSeek = t;
    this.player?.seekTo(t, true);
    // Hors lecture, la position est connue tout de suite.
    if (this.state !== 1) {
      this.clock.observe(t, false, this.rate);
      this.pendingSeek = null;
    }
  }

  get playbackRate(): number {
    return this.rate;
  }

  /** Vitesse la plus proche permise par YouTube. */
  set playbackRate(rate: number) {
    const player = this.player;
    if (!player) return;
    const allowed = player.getAvailablePlaybackRates?.() ?? [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const nearest = allowed.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a), 1);
    player.setPlaybackRate(nearest);
    this.rate = player.getPlaybackRate?.() || nearest;
    this.clock.reset();
  }

  get volume(): number {
    return (this.player?.getVolume() ?? 100) / 100;
  }

  set volume(value: number) {
    this.player?.setVolume(Math.round(Math.min(1, Math.max(0, value)) * 100));
  }

  onState(listener: (state: MediaState, message?: string) => void): void {
    this.listeners.push(listener);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.listeners = [];
    try {
      this.player?.destroy();
    } catch {
      // Lecteur déjà détruit avec la page.
    }
    this.player = null;
    this.element.remove();
  }
}
