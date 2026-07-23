// Costruzione del dataset a tessere a partire dai due CSV MIMIT.
//
// Idea: pre-processiamo una volta al giorno e suddividiamo l'Italia in una griglia
// geografica. Il client scarica solo le tessere vicine ai suoi indirizzi preferiti.

import { parseCsv, t } from './parse.ts';
import { classifyFuel, type CanonFuel } from './fuels.ts';

/** Lato della cella della griglia, in gradi. Vedi scelta di TILE_DEG nel README. */
export const TILE_DEG = 0.5;

// Bounding box Italia (con isole) per scartare coordinate palesemente errate.
const IT_BBOX = { latMin: 35, latMax: 48, lonMin: 6, lonMax: 19 };

export interface Station {
  i: number; // idImpianto
  b: string; // bandiera
  t: 0 | 1 | 2; // tipo: 0 stradale, 1 autostradale, 2 pompe bianche
  y: number; // lat
  x: number; // lon
  c: string; // comune
  // prezzi per carburante canonico: [self, servito] (null se assente)
  p: Partial<Record<CanonFuel, { s: number | null; r: number | null }>>;
}

export interface BuildResult {
  extractionDate: string | null;
  tiles: Map<string, Station[]>;
  stats: {
    stationsInAnagrafica: number;
    stationsWithBadCoords: number;
    stationsPriced: number; // impianti con almeno un prezzo valido
    priceRows: number;
    unmappedFuel: Map<string, number>;
    fuelCounts: Map<CanonFuel, number>;
    malformedAnagrafica: number;
    malformedPrezzo: number;
  };
}

export function tileKey(lat: number, lon: number): string {
  const ty = Math.floor(lat / TILE_DEG);
  const tx = Math.floor(lon / TILE_DEG);
  return `${ty}_${tx}`;
}

function tipoCode(s: string): 0 | 1 | 2 {
  const u = s.toUpperCase();
  if (u.includes('AUTOSTRAD')) return 1;
  if (u.includes('POMPE BIANCHE')) return 2;
  return 0;
}

function validCoord(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 || lon === 0) return false;
  return (
    lat >= IT_BBOX.latMin && lat <= IT_BBOX.latMax &&
    lon >= IT_BBOX.lonMin && lon <= IT_BBOX.lonMax
  );
}

/** Indice di colonna per nome header (dalla testa). */
function columnIndex(header: string[], name: string): number {
  return header.findIndex((h) => t(h).toLowerCase() === name.toLowerCase());
}

/**
 * Offset dalla CODA per una colonna: le colonne dopo i campi di testo variabili
 * (Nome Impianto, Indirizzo) sono ancorate a destra, così restano leggibili anche
 * quando un campo contiene il separatore e la riga ha colonne in più.
 */
function tailOffset(header: string[], name: string): number {
  return header.length - columnIndex(header, name);
}
const fromEnd = (row: string[], offset: number): string => row[row.length - offset] ?? '';

export function buildDataset(anagraficaText: string, prezzoText: string): BuildResult {
  const anag = parseCsv(anagraficaText);
  const prezzo = parseCsv(prezzoText);

  // --- Anagrafica -> mappa impianti ---
  // Testa (prima dei campi di testo variabili): ancorate a sinistra.
  const aHead = {
    id: columnIndex(anag.header, 'idImpianto'),
    bandiera: columnIndex(anag.header, 'Bandiera'),
    tipo: columnIndex(anag.header, 'Tipo Impianto'),
  };
  // Coda: ancorate a destra (robuste al separatore dentro Nome Impianto/Indirizzo).
  const aTail = {
    comune: tailOffset(anag.header, 'Comune'),
    lat: tailOffset(anag.header, 'Latitudine'),
    lon: tailOffset(anag.header, 'Longitudine'),
  };

  const stations = new Map<number, Station>();
  let badCoords = 0;
  for (const row of anag.rows) {
    const id = parseInt(t(row[aHead.id]), 10);
    if (!Number.isFinite(id)) continue;
    const lat = parseFloat(t(fromEnd(row, aTail.lat)));
    const lon = parseFloat(t(fromEnd(row, aTail.lon)));
    if (!validCoord(lat, lon)) { badCoords++; continue; }
    stations.set(id, {
      i: id,
      b: t(row[aHead.bandiera]),
      t: tipoCode(t(row[aHead.tipo])),
      y: Math.round(lat * 1e6) / 1e6,
      x: Math.round(lon * 1e6) / 1e6,
      c: t(fromEnd(row, aTail.comune)),
      p: {},
    });
  }

  // --- Prezzi -> aggancio agli impianti ---
  const pHead = {
    id: columnIndex(prezzo.header, 'idImpianto'),
    desc: columnIndex(prezzo.header, 'descCarburante'),
  };
  const pTail = {
    prezzo: tailOffset(prezzo.header, 'prezzo'),
    isSelf: tailOffset(prezzo.header, 'isSelf'),
  };

  const unmappedFuel = new Map<string, number>();
  const fuelCounts = new Map<CanonFuel, number>();
  const priced = new Set<number>();

  for (const row of prezzo.rows) {
    const id = parseInt(t(row[pHead.id]), 10);
    const st = stations.get(id);
    if (!st) continue; // impianto senza anagrafica valida (o coord scartate)

    const price = parseFloat(t(fromEnd(row, pTail.prezzo)).replace(',', '.'));
    if (!Number.isFinite(price) || price <= 0) continue;

    const descRaw = row.slice(pHead.desc, row.length - pTail.prezzo).join(' ');
    const canon = classifyFuel(t(descRaw));
    if (!canon) {
      unmappedFuel.set(t(descRaw), (unmappedFuel.get(t(descRaw)) ?? 0) + 1);
      continue;
    }
    fuelCounts.set(canon, (fuelCounts.get(canon) ?? 0) + 1);

    const self = t(fromEnd(row, pTail.isSelf)) === '1';
    const slot = (st.p[canon] ??= { s: null, r: null });
    if (self) slot.s = slot.s === null ? price : Math.min(slot.s, price);
    else slot.r = slot.r === null ? price : Math.min(slot.r, price);
    priced.add(id);
  }

  // --- Distribuzione in tessere (solo impianti con almeno un prezzo) ---
  const tiles = new Map<string, Station[]>();
  for (const st of stations.values()) {
    if (Object.keys(st.p).length === 0) continue;
    const key = tileKey(st.y, st.x);
    (tiles.get(key) ?? tiles.set(key, []).get(key)!).push(st);
  }

  return {
    extractionDate: prezzo.extractionDate ?? anag.extractionDate,
    tiles,
    stats: {
      stationsInAnagrafica: anag.rows.length,
      stationsWithBadCoords: badCoords,
      stationsPriced: priced.size,
      priceRows: prezzo.rows.length,
      unmappedFuel,
      fuelCounts,
      malformedAnagrafica: anag.malformed,
      malformedPrezzo: prezzo.malformed,
    },
  };
}

/** Distanza in km tra due punti (Haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Chiavi delle tessere che coprono il punto e TUTTI i suoi vicini entro `radiusKm`.
 * Non restituisce mai solo la tessera in cui cade il punto: il blocco è sempre
 * almeno 3×3 (Math.max(1, …)), così un punto sul bordo/angolo vede comunque le
 * tessere adiacenti. Gli span sono separati per lat/lon perché un grado di
 * longitudine in Italia è più corto (~82 km) di uno di latitudine (~111 km):
 * senza `cos(lat)` le tessere longitudinali verrebbero sotto-coperte a raggi larghi.
 */
export function tilesForRadius(lat: number, lon: number, radiusKm: number): string[] {
  const kmPerDegLat = 111;
  const kmPerDegLon = 111 * Math.cos((lat * Math.PI) / 180);
  const spanY = Math.max(1, Math.ceil(radiusKm / (TILE_DEG * kmPerDegLat)));
  const spanX = Math.max(1, Math.ceil(radiusKm / (TILE_DEG * kmPerDegLon)));
  const ty = Math.floor(lat / TILE_DEG);
  const tx = Math.floor(lon / TILE_DEG);
  const keys: string[] = [];
  for (let dy = -spanY; dy <= spanY; dy++) {
    for (let dx = -spanX; dx <= spanX; dx++) {
      keys.push(`${ty + dy}_${tx + dx}`);
    }
  }
  return keys;
}
