// Dry-run locale della pipeline sui CSV reali (quelli già scaricati in scratchpad).
// Non tocca Cloudflare: valida tiling, normalizzazione carburanti e una query.
//
//   node scripts/dry-run.ts <anagrafica.csv> <prezzo.csv>

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildDataset, haversineKm, tilesForRadius, TILE_DEG, type Station } from '../src/pipeline/tiles.ts';

const [anagPath, prezzoPath] = process.argv.slice(2);
if (!anagPath || !prezzoPath) {
  console.error('uso: node scripts/dry-run.ts <anagrafica.csv> <prezzo.csv>');
  process.exit(1);
}

const anagText = readFileSync(anagPath, 'latin1');
const prezzoText = readFileSync(prezzoPath, 'latin1');

const t0 = performance.now();
const res = buildDataset(anagText, prezzoText);
const t1 = performance.now();

const s = res.stats;
console.log('===== BUILD =====');
console.log('estrazione            :', res.extractionDate);
console.log('build time            :', (t1 - t0).toFixed(0), 'ms');
console.log('impianti anagrafica   :', s.stationsInAnagrafica);
console.log('  coord scartate      :', s.stationsWithBadCoords);
console.log('  righe malformate    :', s.malformedAnagrafica);
console.log('impianti con prezzo    :', s.stationsPriced);
console.log('righe prezzo           :', s.priceRows, '(malformate:', s.malformedPrezzo + ')');

console.log('\n===== CARBURANTI (canonici) =====');
for (const [f, n] of [...s.fuelCounts].sort((a, b) => b[1] - a[1])) {
  console.log('  ', f.padEnd(14), n);
}
const unmappedTotal = [...s.unmappedFuel.values()].reduce((a, b) => a + b, 0);
console.log('  righe NON mappate   :', unmappedTotal);
if (s.unmappedFuel.size) {
  console.log('  diciture non mappate (top 15):');
  for (const [d, n] of [...s.unmappedFuel].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log('     ', String(n).padStart(5), d);
  }
}

// ---- Dimensioni delle tessere ----
console.log(`\n===== TESSERE (TILE_DEG = ${TILE_DEG}°) =====`);
const counts: number[] = [];
const gzSizes: number[] = [];
let totalGz = 0;
let biggest = { key: '', n: 0, gz: 0 };
for (const [key, arr] of res.tiles) {
  counts.push(arr.length);
  const gz = gzipSync(Buffer.from(JSON.stringify(arr))).length;
  gzSizes.push(gz);
  totalGz += gz;
  if (arr.length > biggest.n) biggest = { key, n: arr.length, gz };
}
counts.sort((a, b) => a - b);
gzSizes.sort((a, b) => a - b);
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
console.log('tessere popolate      :', res.tiles.size);
console.log('stazioni/tessera      : mediana', pct(counts, 0.5), ' p95', pct(counts, 0.95), ' max', counts.at(-1));
console.log('kB gzip per tessera   : mediana', (pct(gzSizes, 0.5) / 1024).toFixed(1),
            ' p95', (pct(gzSizes, 0.95) / 1024).toFixed(1),
            ' max', (gzSizes.at(-1)! / 1024).toFixed(1));
console.log('tessera più densa     :', biggest.key, `(${biggest.n} staz, ${(biggest.gz / 1024).toFixed(1)} kB gz)`);
console.log('dataset intero (gz)   :', (totalGz / 1024 / 1024).toFixed(2), 'MB');

// ---- Query di prova ----
function query(name: string, lat: number, lon: number, radiusKm: number, fuel: keyof Station['p'], self: boolean) {
  const keys = tilesForRadius(lat, lon, radiusKm);
  let bytesFetched = 0;
  const cand: Station[] = [];
  for (const k of keys) {
    const arr = res.tiles.get(k);
    if (!arr) continue;
    bytesFetched += gzipSync(Buffer.from(JSON.stringify(arr))).length;
    cand.push(...arr);
  }
  const q0 = performance.now();
  const hits = cand
    .map((st) => ({ st, d: haversineKm(lat, lon, st.y, st.x) }))
    .filter((h) => h.d <= radiusKm)
    .map((h) => ({ ...h, price: self ? h.st.p[fuel]?.s : h.st.p[fuel]?.r }))
    .filter((h): h is typeof h & { price: number } => typeof h.price === 'number')
    .sort((a, b) => a.price - b.price);
  const q1 = performance.now();

  console.log(`\n===== QUERY: ${name} — ${fuel} ${self ? 'self' : 'servito'} entro ${radiusKm} km =====`);
  console.log('tessere toccate       :', keys.length, `(scaricati ~${(bytesFetched / 1024).toFixed(1)} kB gz)`);
  console.log('stazioni candidate    :', cand.length, ' → nel raggio con quel prezzo:', hits.length);
  console.log('tempo query           :', (q1 - q0).toFixed(2), 'ms');
  console.log('top 5 più economici:');
  for (const h of hits.slice(0, 5)) {
    console.log('   ', h.price!.toFixed(3), '€  ', h.d.toFixed(1).padStart(4), 'km  ', h.st.b.padEnd(12), h.st.c);
  }
}

query('Milano Duomo', 45.4642, 9.19, 10, 'gasolio', true);
query('Roma Termini', 41.9009, 12.5028, 5, 'benzina', true);
query('paesino Appennino (Norcia)', 42.7936, 13.0966, 25, 'gpl', false);
