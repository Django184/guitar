import { afterEach, describe, expect, it } from 'vitest';
import worker, { allowedTarget, detectKind, searchBitMidi } from '../proxy/src/index';

const APP = 'https://django184.github.io';
const bytes = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(new TextEncoder().encode(text));
const realFetch = globalThis.fetch;

/** Remplace fetch pour le Worker : réponses selon l'adresse demandée. */
function stubFetch(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes[url];
    if (!route) throw new Error(`fetch inattendu : ${url}`);
    return route();
  }) as typeof fetch;
}

const call = (path: string, origin: string | null = APP, method = 'GET'): Promise<Response> =>
  worker.fetch(new Request(`https://proxy.example.workers.dev${path}`, { method, headers: origin ? { Origin: origin } : {} }), {});

describe('proxy : nature des fichiers', () => {
  it('reconnaît les partitions à leur signature', () => {
    expect(detectKind(bytes('MThd\0\0\0\x06'))).toBe('midi');
    expect(detectKind(bytes('PK\x03\x04....META-INF/container.xml'))).toBe('mxl');
    expect(detectKind(bytes('PK\x03\x04....Content/score.gpif'))).toBe('guitarpro');
    expect(detectKind(bytes('BCFZ....'))).toBe('guitarpro');
    expect(detectKind(bytes('\x18FICHIER GUITAR PRO v5.00'))).toBe('guitarpro');
    expect(detectKind(bytes('<?xml version="1.0"?>\n<!DOCTYPE score-partwise>\n<score-partwise version="4.0">'))).toBe('musicxml');
  });

  it('refuse les pages web et les autres fichiers', () => {
    expect(detectKind(bytes('<!doctype html><html><body>score-partwise</body></html>'))).toBeNull();
    expect(detectKind(bytes('%PDF-1.7'))).toBeNull();
    expect(detectKind(bytes('PK\x03\x04....setup.exe'))).toBeNull();
    expect(detectKind(new Uint8Array())).toBeNull();
  });
});

describe('proxy : adresses lues', () => {
  it('accepte un site public', () => {
    expect(allowedTarget(new URL('https://bitmidi.com/uploads/1.mid'))).toBe(true);
    expect(allowedTarget(new URL('http://www.example.org/a.gp5'))).toBe(true);
  });

  it('refuse les sites dont les conditions interdisent l’accès automatisé', () => {
    expect(allowedTarget(new URL('https://musescore.com/user/1/scores/2'))).toBe(false);
    expect(allowedTarget(new URL('https://www.songsterr.com/a/wsa/x'))).toBe(false);
    expect(allowedTarget(new URL('https://tabs.ultimate-guitar.com/tab/x'))).toBe(false);
  });

  it('refuse le réseau interne et les autres protocoles', () => {
    expect(allowedTarget(new URL('http://localhost:8080/a.mid'))).toBe(false);
    expect(allowedTarget(new URL('http://192.168.1.10/a.mid'))).toBe(false);
    expect(allowedTarget(new URL('http://[::1]/a.mid'))).toBe(false);
    expect(allowedTarget(new URL('ftp://example.org/a.mid'))).toBe(false);
    expect(allowedTarget(new URL('https://user:pw@example.org/a.mid'))).toBe(false);
  });
});

describe('proxy : requêtes', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('répond au test de connexion et aux pré-vérifications CORS', async () => {
    const hello = await call('/');
    expect(hello.status).toBe(200);
    expect(((await hello.json()) as { ok: boolean }).ok).toBe(true);
    const pre = await call('/fetch', APP, 'OPTIONS');
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(APP);
  });

  it('ne sert que les pages de l’app', async () => {
    const res = await call('/fetch?url=https%3A%2F%2Fexample.org%2Fa.mid', 'https://evil.example');
    expect(res.status).toBe(403);
    expect((await call('/fetch?url=x', null)).status).toBe(403);
  });

  it('relaie un fichier MIDI', async () => {
    const midi = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0]);
    stubFetch({ 'https://example.org/a.mid': () => new Response(midi) });
    const res = await call(`/fetch?url=${encodeURIComponent('https://example.org/a.mid')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Score-Kind')).toBe('midi');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(midi);
  });

  it('refuse une page web et une redirection vers un site refusé', async () => {
    stubFetch({
      'https://example.org/page': () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } }),
      'https://example.org/go': () => new Response(null, { status: 302, headers: { Location: 'https://musescore.com/score/1' } }),
    });
    expect((await call(`/fetch?url=${encodeURIComponent('https://example.org/page')}`)).status).toBe(415);
    expect((await call(`/fetch?url=${encodeURIComponent('https://example.org/go')}`)).status).toBe(403);
    expect((await call(`/fetch?url=${encodeURIComponent('https://musescore.com/score/1')}`)).status).toBe(403);
  });

  it('suit une redirection autorisée', async () => {
    stubFetch({
      'https://example.org/go': () => new Response(null, { status: 301, headers: { Location: '/files/a.gp5' } }),
      'https://example.org/files/a.gp5': () => new Response(bytes('\x18FICHIER GUITAR PRO v5.00')),
    });
    const res = await call(`/fetch?url=${encodeURIComponent('https://example.org/go')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Score-Kind')).toBe('guitarpro');
    expect(res.headers.get('X-Final-Url')).toBe('https://example.org/files/a.gp5');
  });

  it('cherche dans BitMidi', async () => {
    const api = 'https://bitmidi.com/api/midi/search?q=megalovania&pageSize=10';
    const body = { result: { results: [{ id: 7, name: 'Megalovania.mid', downloadUrl: '/uploads/7.mid' }, { id: 8, name: '' }] } };
    stubFetch({ [api]: () => Response.json(body) });
    expect(await searchBitMidi('megalovania')).toEqual([
      { title: 'Megalovania', url: 'https://bitmidi.com/uploads/7.mid', source: 'BitMidi', format: 'midi' },
    ]);
    const res = await call('/search?q=megalovania');
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
  });
});
