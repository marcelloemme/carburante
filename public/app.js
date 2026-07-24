// Logica client: modalità "Indirizzo" (un punto) e "Tragitto" (A→B con percorsi
// alternativi). Tutto il calcolo di distanza/deviazione è locale, sulle tessere.

const FUEL_LABEL = {
  benzina: 'Benzina', benzina_plus: 'Benzina premium', gasolio: 'Gasolio',
  gasolio_plus: 'Gasolio premium', gpl: 'GPL', metano: 'Metano', gnl: 'GNL', hvo: 'HVO',
};

const state = {
  mode: 'single',
  manifest: null,
  single: { point: null },          // { lat, lon, label }
  route: { a: null, b: null, routes: [], selected: -1 },
};
const tileCache = new Map();
const $ = (id) => document.getElementById(id);

// ---------- geometria ----------
function tilesForRadius(lat, lon, radiusKm, deg) {
  const spanY = Math.max(1, Math.ceil(radiusKm / (deg * 111)));
  const spanX = Math.max(1, Math.ceil(radiusKm / (deg * 111 * Math.cos(lat * Math.PI / 180))));
  const ty = Math.floor(lat / deg), tx = Math.floor(lon / deg);
  const keys = [];
  for (let dy = -spanY; dy <= spanY; dy++)
    for (let dx = -spanX; dx <= spanX; dx++) keys.push(`${ty + dy}_${tx + dx}`);
  return keys;
}
// Corridoio: unione delle tessere entro `radiusKm` da ogni vertice del percorso.
function tilesForRoute(geometry, radiusKm, deg) {
  const s = new Set();
  for (const [la, lo] of geometry)
    for (const k of tilesForRadius(la, lo, radiusKm, deg)) s.add(k);
  return s;
}
function haversine(a1, o1, a2, o2) {
  const R = 6371, dLat = (a2 - a1) * Math.PI / 180, dLon = (o2 - o1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a1 * Math.PI / 180) * Math.cos(a2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// Proiezione locale in km (equirettangolare): ottima a queste scale, veloce.
function toXY(lat, lon, lat0) {
  return [lon * 111.320 * Math.cos(lat0 * Math.PI / 180), lat * 110.574];
}
// Distanza punto→segmento (in km) e parametro t∈[0,1] della proiezione.
function segInfo(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}
// Per una stazione: deviazione dal percorso (km) e distanza dalla partenza lungo il percorso (km).
function detourProgress(px, py, polyXY, cum) {
  let best = { detour: Infinity, progress: 0 };
  for (let i = 0; i < polyXY.length - 1; i++) {
    const [ax, ay] = polyXY[i], [bx, by] = polyXY[i + 1];
    const { d, t } = segInfo(px, py, ax, ay, bx, by);
    if (d < best.detour) {
      const segLen = Math.hypot(bx - ax, by - ay);
      best = { detour: d, progress: cum[i] + t * segLen };
    }
  }
  return best;
}

// ---------- dati ----------
async function loadManifest() {
  const r = await fetch('/manifest.json');
  if (!r.ok) throw new Error('manifest non disponibile (build non ancora eseguito?)');
  state.manifest = await r.json();
  const el = $('extraction');
  if (state.manifest.sourceLastModified) {
    const f = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    el.textContent = 'aggiornati il ' + f.format(new Date(state.manifest.sourceLastModified)).replace(',', ' alle');
  } else if (state.manifest.extractionDate) {
    el.textContent = 'estrazione ' + state.manifest.extractionDate;
  }
}
async function fetchTile(key) {
  if (tileCache.has(key)) return tileCache.get(key);
  const r = await fetch(`/tiles/${key}.json`);
  const arr = r.ok ? await r.json() : [];
  tileCache.set(key, arr);
  return arr;
}
async function geocode(q) {
  const r = await fetch('/api/geocode?q=' + encodeURIComponent(q));
  const data = await r.json();
  return data.results || [];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Riquadro candidati riusabile: geocodifica e lascia scegliere l'indirizzo.
async function pickAddress(inputEl, boxEl, onPick) {
  const q = inputEl.value.trim();
  if (q.length < 3) { boxEl.textContent = 'Scrivi almeno 3 caratteri.'; return; }
  boxEl.innerHTML = '<span class="status">Cerco l\'indirizzo…</span>';
  try {
    const results = await geocode(q);
    if (!results.length) { boxEl.innerHTML = '<span class="status">Nessun indirizzo trovato.</span>'; return; }
    boxEl.innerHTML = '';
    for (const res of results) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = res.label;
      b.onclick = () => {
        boxEl.innerHTML = `<span class="status">📍 ${escapeHtml(res.label)}</span>`;
        onPick({ lat: res.lat, lon: res.lon, label: res.label });
      };
      boxEl.appendChild(b);
    }
  } catch (e) {
    boxEl.innerHTML = '<span class="status">Errore: ' + escapeHtml(e.message) + '</span>';
  }
}

// ---------- modalità Indirizzo ----------
async function searchSingle() {
  const p = state.single.point, m = state.manifest;
  if (!p || !m) return;
  const fuel = $('fuel').value, self = $('mode').value === 's', radius = +$('radius').value;
  $('status').textContent = 'Cerco…';
  const keys = tilesForRadius(p.lat, p.lon, radius, m.tileDeg).filter((k) => m.tiles[k]);
  const arrays = await Promise.all(keys.map(fetchTile));
  const hits = [];
  for (const st of arrays.flat()) {
    const d = haversine(p.lat, p.lon, st.y, st.x);
    if (d > radius) continue;
    const price = st.p[fuel] ? (self ? st.p[fuel].s : st.p[fuel].r) : null;
    if (price == null) continue;
    hits.push({ st, price, dist: d });
  }
  hits.sort((a, b) => a.price - b.price);
  $('status').textContent =
    `${hits.length} distributori con ${FUEL_LABEL[fuel]} ${self ? 'self' : 'servito'} entro ${radius} km da ${p.label.split(',')[0]}`;
  renderList(hits, (h) => `<span class="dist">${h.dist.toFixed(1)} km</span>`);
}

// ---------- modalità Tragitto ----------
async function findRoutes() {
  const { a, b } = state.route;
  if (!a || !b) return;
  const box = $('routeChips');
  box.innerHTML = '<span class="status">Calcolo i percorsi…</span>';
  try {
    const r = await fetch(`/api/route?ay=${a.lat}&ax=${a.lon}&by=${b.lat}&bx=${b.lon}`);
    const data = await r.json();
    if (!r.ok || !data.routes || !data.routes.length) {
      box.innerHTML = '<span class="status">Nessun percorso trovato' + (data.error ? ' (' + escapeHtml(data.error) + ')' : '') + '.</span>';
      return;
    }
    state.route.routes = data.routes;
    state.route.selected = 0;
    renderChips();
    searchRoute();
  } catch (e) {
    box.innerHTML = '<span class="status">Errore percorso: ' + escapeHtml(e.message) + '</span>';
  }
}
function renderChips() {
  const box = $('routeChips');
  box.innerHTML = '';
  state.route.routes.forEach((rt, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.route.selected ? ' active' : '');
    const h = Math.floor(rt.durationMin / 60), mn = rt.durationMin % 60;
    b.innerHTML = `<b>${escapeHtml(rt.summary)}</b><span>${rt.distanceKm} km · ${h}h${String(mn).padStart(2, '0')}</span>`;
    b.onclick = () => { state.route.selected = i; renderChips(); searchRoute(); };
    box.appendChild(b);
  });
}
async function searchRoute() {
  const m = state.manifest, rt = state.route.routes[state.route.selected];
  if (!m || !rt) return;
  const fuel = $('fuel').value, self = $('mode').value === 's', maxDetour = +$('radius').value;
  $('status').textContent = 'Cerco lungo il percorso…';
  const geom = rt.geometry;
  const lat0 = geom[Math.floor(geom.length / 2)][0];
  const poly = geom.map(([la, lo]) => toXY(la, lo, lat0));
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum[i] = cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);

  const keys = [...tilesForRoute(geom, maxDetour, m.tileDeg)].filter((k) => m.tiles[k]);
  const arrays = await Promise.all(keys.map(fetchTile));
  const hits = [];
  for (const st of arrays.flat()) {
    const price = st.p[fuel] ? (self ? st.p[fuel].s : st.p[fuel].r) : null;
    if (price == null) continue;
    const [px, py] = toXY(st.y, st.x, lat0);
    const { detour, progress } = detourProgress(px, py, poly, cum);
    if (detour > maxDetour) continue;
    hits.push({ st, price, detour, progress });
  }
  hits.sort((a, b) => a.price - b.price);
  $('status').textContent =
    `${hits.length} distributori con ${FUEL_LABEL[fuel]} ${self ? 'self' : 'servito'} entro ${maxDetour} km dal percorso (${rt.distanceKm} km)`;
  renderList(hits, (h) => {
    const dev = h.detour < 0.3 ? 'sul percorso' : `+${h.detour.toFixed(1)} km`;
    return `<span class="dist">${Math.round(h.progress)} km dalla partenza<br><small>${dev}</small></span>`;
  });
}

// ---------- render lista condiviso ----------
function renderList(hits, rightHtml) {
  const ul = $('results');
  ul.innerHTML = '';
  for (const h of hits.slice(0, 40)) {
    const li = document.createElement('li');
    if (h === hits[0]) li.className = 'best';
    li.innerHTML =
      `<div><span class="price">${h.price.toFixed(3)} €</span>` +
      `<div class="meta">${escapeHtml(h.st.b)} · ${escapeHtml(h.st.c)}</div>` +
      (h.st.a ? `<div class="addr">${escapeHtml(h.st.a)}</div>` : '') +
      `</div>${rightHtml(h)}`;
    ul.appendChild(li);
  }
}

// Rilancia la ricerca attiva quando cambiano i controlli (carburante/modalità/raggio).
function rerun() {
  if (state.mode === 'single' && state.single.point) searchSingle();
  else if (state.mode === 'route' && state.route.selected >= 0) searchRoute();
}

// ---------- UI ----------
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('singleCard').hidden = mode !== 'single';
  $('routeCard').hidden = mode !== 'route';
  $('searchCard').hidden = true;
  $('results').innerHTML = '';
  $('status').textContent = '';
  $('radiusLabel').textContent = mode === 'route' ? 'Deviazione max' : 'Raggio';
}

function wire() {
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // Indirizzo singolo
  $('go').addEventListener('click', () => pickAddress($('q'), $('candidates'), (p) => {
    state.single.point = p; $('searchCard').hidden = false; searchSingle();
  }));
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });

  // Tragitto: partenza e arrivo
  $('goA').addEventListener('click', () => pickAddress($('qa'), $('candA'), (p) => { state.route.a = p; refreshFindBtn(); }));
  $('goB').addEventListener('click', () => pickAddress($('qb'), $('candB'), (p) => { state.route.b = p; refreshFindBtn(); }));
  $('qa').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('goA').click(); });
  $('qb').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('goB').click(); });
  $('findRoutes').addEventListener('click', () => { $('searchCard').hidden = false; findRoutes(); });

  for (const id of ['fuel', 'mode', 'radius']) $(id).addEventListener('change', rerun);
}
function refreshFindBtn() {
  $('findRoutes').disabled = !(state.route.a && state.route.b);
}

wire();
setMode('single');
loadManifest().catch((e) => { $('extraction').textContent = e.message; });
