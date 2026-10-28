/**
 * Où trouver des transcriptions :
 * - BitMidi, archive publique de fichiers MIDI : recherche et téléchargement directs (son
 *   interface est ouverte aux autres sites, CORS) ;
 * - liens trouvés par Claude (claude.ai, avec l'abonnement de l'utilisateur) : un message
 *   prérempli s'ouvre, la réponse (JSON) est collée dans l'app ;
 * - fichiers importés à la main.
 * Les fichiers d'autres sites passent par le proxy de l'utilisateur (Cloudflare, gratuit),
 * qui ne renvoie que des partitions.
 */
import { loadPref, savePref } from '../../shell/storage';

export interface Found {
  title: string;
  url: string;
  /** Site d'origine (affiché). */
  source: string;
}

export class SearchFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchFailure';
  }
}

const BITMIDI = 'https://bitmidi.com';
/** Taille maximale d'une transcription téléchargée. */
const MAX_BYTES = 8 * 1024 * 1024;
/** Sites dont les conditions interdisent l'accès automatisé : import manuel seulement. */
const BLOCKED_HOSTS = ['musescore.com', 'songsterr.com', 'ultimate-guitar.com'];

export const isBlockedHost = (host: string): boolean => {
  const h = host.toLowerCase();
  return BLOCKED_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
};

/** Titre nettoyé pour la recherche : sans « tab », « partition », numéro de version… */
export function songQuery(title: string): string {
  return title
    .replace(/\.(pdf|gp\d?|gpx|mid|midi|musicxml|mxl|xml)$/i, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\b(guitar|guitare|tabs?|tablatures?|partitions?|sheet music|score|pdf|v\d+(\.\d+)*|version)\b/gi, ' ')
    .replace(/\s+-\s+|\s+–\s+/g, ' ')
    .replace(/[-–]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** Part des mots du titre présents dans le nom trouvé (0 à 1). */
export function titleMatch(query: string, name: string): number {
  const q = words(query);
  if (!q.length) return 0;
  const n = new Set(words(name));
  return q.filter((w) => n.has(w)).length / q.length;
}

interface BitMidiResponse {
  result?: { results?: Array<{ name?: string; downloadUrl?: string }> };
}

/** Recherche dans BitMidi : jusqu'à `limit` fichiers, les plus proches du titre d'abord. */
export async function searchBitMidi(title: string, artist = '', limit = 6, fetchFn: typeof fetch = fetch): Promise<Found[]> {
  const query = songQuery(title);
  if (!query) return [];
  const queries = [...new Set([query, artist ? `${query} ${artist}` : ''].filter(Boolean))];
  const seen = new Map<string, Found & { score: number }>();
  for (const q of queries) {
    let body: BitMidiResponse;
    try {
      const res = await fetchFn(`${BITMIDI}/api/midi/search?q=${encodeURIComponent(q)}&pageSize=20`);
      if (!res.ok) continue;
      body = (await res.json()) as BitMidiResponse;
    } catch {
      continue;
    }
    for (const r of body.result?.results ?? []) {
      if (!r.name || !r.downloadUrl) continue;
      const url = new URL(r.downloadUrl, BITMIDI).toString();
      const name = r.name.replace(/\.midi?$/i, '');
      // Au moins la moitié des mots du titre dans le nom du fichier.
      const score = titleMatch(query, name);
      if (score < 0.5 || seen.has(url)) continue;
      seen.set(url, { title: name, url, source: 'BitMidi', score });
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ title: t, url, source }) => ({ title: t, url, source }));
}

// --- Proxy -----------------------------------------------------------------------

const PROXY_PREF = 'rhythmProxy';
const isString = (v: unknown): v is string => typeof v === 'string';

/** Adresse du proxy de l'utilisateur (sans « / » final), ou null. */
export function proxyUrl(): string | null {
  const url = loadPref(PROXY_PREF, '', isString);
  return url || null;
}

/** Adresse saisie : https, sans chemin. Renvoie l'adresse retenue, ou null si invalide. */
export function normalizeProxy(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function saveProxyUrl(url: string | null): void {
  savePref(PROXY_PREF, url ?? '');
}

/** Le proxy répond-il ? */
export async function testProxy(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${url}/`);
    const body = (await res.json()) as { ok?: boolean; name?: string };
    return res.ok && body.ok === true && body.name === 'pratique-guitare-proxy';
  } catch {
    return false;
  }
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new SearchFailure('Fichier trop volumineux.');
  return bytes;
}

/**
 * Télécharge une transcription : directement si le site le permet (BitMidi), sinon par le
 * proxy de l'utilisateur.
 */
export async function download(url: string, proxy: string | null, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new SearchFailure('Adresse invalide.');
  }
  if (isBlockedHost(host)) throw new SearchFailure('Ce site interdit le téléchargement automatique : importez le fichier à la main.');
  const direct = host === 'bitmidi.com' || !proxy;
  if (direct) {
    try {
      const res = await fetchFn(url);
      if (res.ok) return await readCapped(res);
    } catch {
      // Site fermé aux autres sites (CORS) : par le proxy, s'il y en a un.
    }
    if (!proxy) throw new SearchFailure('Téléchargement impossible sans proxy.');
  }
  let res: Response;
  try {
    res = await fetchFn(`${proxy}/fetch?url=${encodeURIComponent(url)}`);
  } catch {
    throw new SearchFailure('Proxy injoignable.');
  }
  if (res.status === 415) throw new SearchFailure('Ce lien ne mène pas à une partition.');
  if (res.status === 403) throw new SearchFailure('Lien refusé par le proxy.');
  if (!res.ok) throw new SearchFailure('Téléchargement impossible.');
  return readCapped(res);
}

// --- Pont claude.ai -------------------------------------------------------------------

/** Message prérempli pour Claude : liens directs vers des fichiers, réponse en JSON. */
export function claudePrompt(title: string, artist = ''): string {
  const song = `« ${songQuery(title) || title} »${artist ? ` (${artist})` : ''}`;
  return [
    `Cherche sur le web des transcriptions téléchargeables gratuitement du morceau ${song}.`,
    'Je veux des liens DIRECTS vers les fichiers (pas vers des pages) : Guitar Pro (.gp, .gp5, .gpx), MusicXML (.musicxml, .mxl) ou MIDI (.mid).',
    'Priorité : guitare avec le rythme ; sinon piano ou un autre instrument qui joue la mélodie. Plusieurs versions différentes, c’est mieux (jusqu’à 6).',
    'Exclus MuseScore, Songsterr et Ultimate Guitar (téléchargement automatique interdit).',
    'Vérifie que chaque lien mène bien au fichier. Réponds uniquement avec ce JSON, sans autre texte :',
    '{"sources":[{"url":"https://…","titre":"…","instrument":"guitare|piano|…"}]}',
  ].join('\n');
}

/** Lien qui ouvre claude.ai avec le message prérempli (il reste à l'envoyer). */
export const claudeLink = (prompt: string): string => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

/** Liens de la réponse de Claude : le JSON demandé, ou à défaut toutes les adresses du texte. */
export function parseClaudeAnswer(text: string): Found[] {
  const out: Found[] = [];
  const add = (url: unknown, title: unknown): void => {
    if (typeof url !== 'string') return;
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    if (isBlockedHost(parsed.hostname) || out.some((f) => f.url === parsed.toString())) return;
    const name = typeof title === 'string' && title.trim() ? title.trim() : decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname);
    out.push({ title: name, url: parsed.toString(), source: parsed.hostname.replace(/^www\./, '') });
  };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(text.slice(start, end + 1)) as { sources?: Array<Record<string, unknown>> };
      for (const s of json.sources ?? []) add(s.url, s.titre ?? s.title);
    } catch {
      // Pas du JSON valide : les adresses du texte.
    }
  }
  if (!out.length) for (const m of text.matchAll(/https?:\/\/[^\s"'<>()[\]{}]+/g)) add(m[0].replace(/[.,;:!?]+$/, ''), null);
  return out;
}
