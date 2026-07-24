// Pages Function: /api/route — proxy verso OpenRouteService (ORS).
// Dato A e B (coordinate), restituisce 2-3 percorsi alternativi, ciascuno con
// geometria (semplificata, in [lat,lon]), distanza/durata e un riassunto delle
// strade principali (es. "A4 · A26 · SS25").
//
// La chiave ORS sta in env.ORS_API_KEY (secret di runtime di Cloudflare Pages;
// in locale in .dev.vars). Cache dei risultati per non consumare il piano free.

interface Env {
  ORS_API_KEY?: string;
}

const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
const CACHE_TTL = 60 * 60 * 24 * 7; // 7 giorni (i percorsi cambiano poco)
const MAX_GEOMETRY_POINTS = 600; // semplifichiamo per payload piccolo e calcoli veloci

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

/** Riduce il numero di vertici della polilinea mantenendo inizio e fine. */
function simplify(coords: number[][]): number[][] {
  if (coords.length <= MAX_GEOMETRY_POINTS) return coords;
  const step = Math.ceil(coords.length / MAX_GEOMETRY_POINTS);
  const out: number[][] = [];
  for (let i = 0; i < coords.length; i += step) out.push(coords[i]!);
  const last = coords[coords.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// Sigle strada (autostrade, statali, provinciali, raccordi…). Globale: un nome
// può contenerne più d'una (es. "Svincolo A4 - A31, A31").
const REF_G = /\b(?:A\d+[a-z]*|SS\s?\d+|SP\s?\d+|SR\s?\d+|RA\s?\d+|E\d+|T\d+)\b/gi;
// ORS dà il nome come "Autostrada della Valdastico, A31": la strada reale è
// l'ULTIMA sigla (non lo svincolo di provenienza).
function roadRef(name: string): string | null {
  const all = name.match(REF_G);
  const last = all?.[all.length - 1];
  return last ? last.replace(/\s+/g, '').toUpperCase() : null;
}

/** Riassunto delle strade principali percorse, in ordine — es. "SP349 · A31 · A35". */
function summarizeRoads(segments: Array<{ steps?: Array<{ name?: string; distance?: number }> }>): string {
  const order: string[] = [];
  const dist: Record<string, number> = {};
  const isRef: Record<string, boolean> = {};
  for (const seg of segments) {
    for (const st of seg.steps ?? []) {
      const raw = (st.name ?? '').trim();
      if (!raw || raw === '-') continue;
      const ref = roadRef(raw);
      const label = ref ?? raw;
      if (!(label in dist)) { order.push(label); isRef[label] = ref !== null; }
      dist[label] = (dist[label] ?? 0) + (st.distance ?? 0);
    }
  }
  const byDist = (a: string, b: string) => (dist[b] ?? 0) - (dist[a] ?? 0);
  // Tutte le strade CON SIGLA percorse per almeno 3 km, in ordine di percorrenza:
  // completo ma senza le tante vie urbane brevi.
  let picked = order.filter((n) => isRef[n] && (dist[n] ?? 0) >= 3000);
  // Percorso tutto urbano (nessuna sigla) → la più lunga, per non restare vuoti.
  if (!picked.length) {
    const longest = [...order].sort(byDist)[0];
    if (longest) picked = [longest];
  }
  // Tetto di sicurezza: se sono davvero tante, tieni le 8 più lunghe (ma in ordine).
  if (picked.length > 8) {
    const keep = new Set([...picked].sort(byDist).slice(0, 8));
    picked = picked.filter((n) => keep.has(n));
  }
  return picked.join(' · ');
}

interface OrsFeature {
  geometry?: { coordinates?: number[][] };
  properties?: {
    summary?: { distance?: number; duration?: number };
    segments?: Array<{ steps?: Array<{ name?: string; distance?: number }> }>;
  };
}

function transformRoute(f: OrsFeature) {
  const coords = f.geometry?.coordinates ?? []; // ORS: [lon, lat]
  const geometry = simplify(coords).map(([lon, lat]) => [lat, lon]); // → [lat, lon]
  const sum = f.properties?.summary ?? {};
  const summary = summarizeRoads(f.properties?.segments ?? []);
  return {
    geometry,
    distanceKm: Math.round((sum.distance ?? 0) / 100) / 10,
    durationMin: Math.round((sum.duration ?? 0) / 60),
    summary: summary || 'percorso',
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!env.ORS_API_KEY) return json({ error: 'routing non configurato (manca ORS_API_KEY)' }, 503);
  const key = env.ORS_API_KEY;

  const u = new URL(request.url);
  const ay = Number(u.searchParams.get('ay')); // lat partenza
  const ax = Number(u.searchParams.get('ax')); // lon partenza
  const by = Number(u.searchParams.get('by')); // lat arrivo
  const bx = Number(u.searchParams.get('bx')); // lon arrivo
  if (![ay, ax, by, bx].every(Number.isFinite)) return json({ error: 'coordinate mancanti/non valide' }, 400);

  const rk = (n: number) => n.toFixed(4);
  const cacheKey = new Request(`https://route.internal/v2?a=${rk(ay)},${rk(ax)}&b=${rk(by)},${rk(bx)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const coordinates = [[ax, ay], [bx, by]]; // ORS vuole [lon, lat]
  const callOrs = (withAlternatives: boolean): Promise<Response> => {
    const body: Record<string, unknown> = { coordinates, instructions: true };
    if (withAlternatives) body.alternative_routes = { target_count: 3, weight_factor: 1.6, share_factor: 0.6 };
    return fetch(ORS_URL, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  let upstream: Response;
  try {
    upstream = await callOrs(true);
    // Le alternative ORS valgono solo fino a ~100 km (errore code 2004):
    // sui tragitti più lunghi ripieghiamo su un percorso singolo.
    if (upstream.status === 400) {
      const txt = await upstream.clone().text().catch(() => '');
      if (txt.includes('2004')) upstream = await callOrs(false);
    }
  } catch {
    return json({ error: 'routing non raggiungibile' }, 502);
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: `routing: HTTP ${upstream.status}`, detail: detail.slice(0, 200) }, 502);
  }

  const data = (await upstream.json()) as { features?: OrsFeature[] };
  const seen = new Set<string>();
  const routes = (data.features ?? []).map(transformRoute).filter((r) => {
    const k = `${r.summary}|${Math.round(r.distanceKm)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const res = json({ routes }, 200, { 'cache-control': `public, max-age=${CACHE_TTL}` });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
