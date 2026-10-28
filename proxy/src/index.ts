/**
 * Proxy de Pratique Guitare (Cloudflare Workers, offre gratuite).
 *
 * L'app, publiée sur GitHub Pages, ne peut pas lire elle-même les fichiers d'autres sites (CORS).
 * Ce petit service le fait pour elle, avec trois garde-fous pour ne pas devenir un proxy ouvert :
 * - seules les pages de l'app (origines autorisées) peuvent l'appeler ;
 * - GET seulement, 8 Mo au plus ;
 * - il ne renvoie que des partitions (MIDI, MusicXML, Guitar Pro), reconnues à leur signature :
 *   jamais une page web ou un autre fichier.
 * Les sites dont les conditions interdisent l'accès automatisé (MuseScore, Songsterr,
 * Ultimate Guitar) sont refusés : leurs fichiers s'importent à la main dans l'app.
 *
 * Routes :
 * - GET /                 → { ok, version } (test de connexion depuis l'app)
 * - GET /fetch?url=…      → le fichier, s'il s'agit d'une partition (MIDI, MusicXML, Guitar Pro)
 * - GET /search?q=…       → partitions trouvées dans les archives publiques (BitMidi)
 */

export interface Env {
  /** Origines supplémentaires autorisées, séparées par des virgules (variable du Worker). */
  ALLOWED_ORIGINS?: string;
}

export const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_ORIGINS = ['https://django184.github.io', 'http://localhost:5173', 'http://localhost:4173'];
const USER_AGENT = 'PratiqueGuitareProxy/1 (+https://github.com/Django184/guitar)';

/** Sites refusés (conditions d'utilisation), sous-domaines compris. */
const BLOCKED_HOSTS = ['musescore.com', 'songsterr.com', 'ultimate-guitar.com'];

/** Adresse que le proxy accepte de lire : http(s), nom de domaine public, site non refusé. */
export function allowedTarget(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  // Adresses IP écrites telles quelles : jamais (réseau interne).
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return false;
  return !BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
}

export type ScoreKind = 'midi' | 'musicxml' | 'mxl' | 'guitarpro';

/** Nature d'un fichier d'après ses premiers octets ; null si ce n'est pas une partition lisible. */
export function detectKind(bytes: Uint8Array): ScoreKind | null {
  const latin1 = (from: number, length: number): string => {
    let out = '';
    for (const b of bytes.subarray(from, from + length)) out += String.fromCharCode(b);
    return out;
  };
  if (latin1(0, 4) === 'MThd' || (latin1(0, 4) === 'RIFF' && latin1(8, 4) === 'RMID')) return 'midi';
  // Archive ZIP : MusicXML compressé (.mxl) ou Guitar Pro 7 et 8 (.gp), reconnus à leurs fichiers.
  if (latin1(0, 4) === 'PK\u0003\u0004') {
    const names = latin1(0, bytes.length);
    if (names.includes('Content/score.gpif')) return 'guitarpro';
    if (names.includes('META-INF/container.xml')) return 'mxl';
    return null;
  }
  // Guitar Pro 6 (.gpx) : conteneur BCFZ / BCFS.
  if (latin1(0, 4) === 'BCFZ' || latin1(0, 4) === 'BCFS') return 'guitarpro';
  // Guitar Pro 3 à 5 : « FICHIER GUITAR PRO vX.YY » après un octet de longueur.
  const headerLength = bytes[0] ?? 0;
  if (headerLength > 0 && headerLength < 64 && /GUITARE? PRO/.test(latin1(1, headerLength).toUpperCase())) return 'guitarpro';
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '');
  if (/^\s*</.test(head) && /<score-(partwise|timewise)\b/.test(head)) return 'musicxml';
  return null;
}

const CONTENT_TYPE: Record<ScoreKind, string> = {
  midi: 'audio/midi',
  musicxml: 'application/vnd.recordare.musicxml+xml',
  mxl: 'application/zip',
  guitarpro: 'application/octet-stream',
};

export function allowedOrigins(env: Env): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Score-Kind, X-Final-Url',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

/** Lit au plus MAX_BYTES octets ; null si le fichier est plus gros. */
async function readCapped(response: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function fetchScore(target: string, headers: Record<string, string>): Promise<Response> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return json({ error: 'url' }, 400, headers);
  }
  if (!allowedTarget(url)) return json({ error: 'forbidden' }, 403, headers);
  // Redirections suivies une à une : chaque étape doit être une adresse autorisée.
  let upstream: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    try {
      upstream = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, redirect: 'manual' });
    } catch {
      return json({ error: 'unreachable' }, 502, headers);
    }
    const location = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('Location') : null;
    if (!location) break;
    try {
      url = new URL(location, url);
    } catch {
      return json({ error: 'url' }, 502, headers);
    }
    if (!allowedTarget(url)) return json({ error: 'forbidden' }, 403, headers);
    upstream = null;
  }
  if (!upstream) return json({ error: 'redirects' }, 502, headers);
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502, headers);
  const bytes = await readCapped(upstream);
  if (!bytes) return json({ error: 'too-large' }, 413, headers);
  const kind = detectKind(bytes);
  if (!kind) return json({ error: 'not-a-score' }, 415, headers);
  return new Response(bytes, {
    status: 200,
    headers: { ...headers, 'Content-Type': CONTENT_TYPE[kind], 'X-Score-Kind': kind, 'X-Final-Url': url.toString(), 'Cache-Control': 'public, max-age=86400' },
  });
}

export interface SearchResult {
  title: string;
  url: string;
  source: string;
  format: 'midi' | 'musicxml' | 'guitarpro';
}

interface BitMidiResponse {
  result?: { results?: Array<{ id?: number; name?: string; downloadUrl?: string }> };
}

/** Recherche dans BitMidi (archive publique de fichiers MIDI). */
export async function searchBitMidi(query: string, fetchFn: typeof fetch = fetch): Promise<SearchResult[]> {
  const api = `https://bitmidi.com/api/midi/search?q=${encodeURIComponent(query)}&pageSize=10`;
  const response = await fetchFn(api, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) return [];
  const body = (await response.json().catch(() => ({}))) as BitMidiResponse;
  return (body.result?.results ?? [])
    .filter((r) => r.downloadUrl && r.name)
    .map((r) => ({
      title: (r.name as string).replace(/\.midi?$/i, ''),
      url: new URL(r.downloadUrl as string, 'https://bitmidi.com').toString(),
      source: 'BitMidi',
      format: 'midi' as const,
    }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = allowedOrigins(env);
    const known = allowed.includes(origin);
    const headers = corsHeaders(known ? origin : (allowed[0] as string));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, headers);
    const url = new URL(request.url);
    // Test de connexion : ouvert à tous (rien n'est relayé).
    if (url.pathname === '/') return json({ ok: true, name: 'pratique-guitare-proxy', version: VERSION }, 200, headers);
    if (!known) return json({ error: 'origin' }, 403, headers);
    if (url.pathname === '/fetch') return fetchScore(url.searchParams.get('url') ?? '', headers);
    if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
      if (!q) return json({ results: [] }, 200, headers);
      const results = await searchBitMidi(q).catch(() => []);
      return json({ results }, 200, { ...headers, 'Cache-Control': 'public, max-age=3600' });
    }
    return json({ error: 'not-found' }, 404, headers);
  },
};
