// Pages Function: /api/geocode — proxy verso Nominatim (OpenStreetMap).
// Sta dietro a Cloudflare Pages perché Nominatim non manda header CORS (il browser
// non può chiamarlo direttamente), la sua policy vuole un User-Agent identificativo,
// e cachiamo i risultati (Cache API) per rispettarla e andare veloci.

interface Env {
  GEOCODER_UA?: string;
}

const DEFAULT_UA = 'carburante (+https://github.com/marcelloemme/carburante)';
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 giorni

interface GeoResult {
  label: string;
  lat: number;
  lon: number;
  type: string;
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < 3) return json({ error: 'query troppo corta (min 3 caratteri)' }, 400);

  // Cache per query normalizzata.
  const cacheKey = new Request(`https://geocode.internal/?q=${encodeURIComponent(q.toLowerCase())}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const nom = new URL('https://nominatim.openstreetmap.org/search');
  nom.searchParams.set('q', q);
  nom.searchParams.set('format', 'jsonv2');
  nom.searchParams.set('countrycodes', 'it'); // solo Italia
  nom.searchParams.set('addressdetails', '1');
  nom.searchParams.set('limit', '5');

  let upstream: Response;
  try {
    upstream = await fetch(nom, {
      headers: {
        'User-Agent': env.GEOCODER_UA || DEFAULT_UA,
        'Accept-Language': 'it',
      },
    });
  } catch {
    return json({ error: 'geocoder non raggiungibile' }, 502);
  }
  if (!upstream.ok) return json({ error: `geocoder: HTTP ${upstream.status}` }, 502);

  const raw = (await upstream.json()) as Array<Record<string, unknown>>;
  const results: GeoResult[] = raw.map((r) => ({
    label: String(r.display_name ?? ''),
    lat: Number(r.lat),
    lon: Number(r.lon),
    type: String(r.type ?? ''),
  }));

  const res = json({ q, results }, 200, {
    'cache-control': `public, max-age=${CACHE_TTL}`,
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
