// Build giornaliero: legge i CSV in data/, costruisce le tessere e le scrive in
// public/tiles/ + public/manifest.json. Gira in GitHub Actions (o in locale),
// NON nel Worker. Dopo, `wrangler deploy` pubblica public/ come asset statici.
//
//   node scripts/build-tiles.ts

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { buildDataset, TILE_DEG } from '../src/pipeline/tiles.ts';

const ANAG = 'data/anagrafica_impianti_attivi.csv';
const PREZZO = 'data/prezzo_alle_8.csv';
const OUT = 'public';
const TILES = `${OUT}/tiles`;

// Hash veloce (FNV-1a) per il change-detection lato client: il manifest tiene
// l'hash di ogni tessera, così il browser riscarica solo quelle cambiate.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Last-Modified della sorgente (scritto da fetch-data), usato come "versione
// sorgente": il gate del workflow ci fa il deploy solo quando avanza.
let sourceLastModified: string | null = null;
try {
  const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
  sourceLastModified = meta['prezzo_alle_8.csv']?.lastModified ?? null;
} catch { /* meta assente in dev: lasciamo null */ }

const t0 = performance.now();
const res = buildDataset(readFileSync(ANAG, 'latin1'), readFileSync(PREZZO, 'latin1'));

rmSync(TILES, { recursive: true, force: true });
mkdirSync(TILES, { recursive: true });

const tiles: Record<string, string> = {};
let stationCount = 0;
for (const [key, arr] of res.tiles) {
  const jsonStr = JSON.stringify(arr);
  writeFileSync(`${TILES}/${key}.json`, jsonStr);
  tiles[key] = fnv1a(jsonStr);
  stationCount += arr.length;
}

const manifest = {
  version: new Date().toISOString(),
  extractionDate: res.extractionDate,
  sourceLastModified,
  tileDeg: TILE_DEG,
  tileCount: res.tiles.size,
  stationCount,
  tiles,
};
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest));

console.log(
  `OK: ${res.tiles.size} tessere, ${stationCount} stazioni, estrazione ${res.extractionDate} ` +
  `(${(performance.now() - t0).toFixed(0)} ms)`,
);
if (res.stats.unmappedFuel.size) {
  console.warn(`attenzione: ${res.stats.unmappedFuel.size} diciture carburante non mappate`);
}
