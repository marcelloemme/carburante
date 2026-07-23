// Scarica i due CSV MIMIT in data/ usando richieste CONDIZIONALI (ETag).
// Se il file non è cambiato dall'ultima volta, il server risponde 304 e non
// scarichiamo nulla. Registra anche il Last-Modified in data/meta.json, che il
// build usa per marcare la "versione sorgente" nel manifest.
//
//   node scripts/fetch-data.ts

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = 'https://www.mimit.gov.it/images/exportCSV';
const FILES = ['anagrafica_impianti_attivi.csv', 'prezzo_alle_8.csv'];
const DATA_DIR = new URL('../data/', import.meta.url);
const META_FILE = new URL('../data/meta.json', import.meta.url);

interface FileMeta { lastModified: string | null; etag: string | null }

mkdirSync(DATA_DIR, { recursive: true });
const meta: Record<string, FileMeta> = existsSync(META_FILE)
  ? JSON.parse(readFileSync(META_FILE, 'utf8'))
  : {};

for (const name of FILES) {
  const headers: Record<string, string> = {};
  const prev = meta[name]?.etag;
  if (prev) headers['If-None-Match'] = prev;

  const res = await fetch(`${BASE}/${name}`, { headers });
  if (res.status === 304) {
    console.log(`= ${name}: invariato (304), uso la copia locale`);
    continue;
  }
  if (!res.ok) {
    console.error(`! ${name}: HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(new URL(name, DATA_DIR), buf);
  meta[name] = {
    lastModified: res.headers.get('last-modified'),
    etag: res.headers.get('etag'),
  };
  console.log(`↓ ${name}: ${(buf.length / 1024 / 1024).toFixed(2)} MB  (Last-Modified: ${meta[name].lastModified})`);
}

writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
