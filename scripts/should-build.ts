// "Gate" del deploy. Costruiamo e pubblichiamo SOLO se il CSV del MIMIT è più
// recente di quello già online. Così i tentativi orari del workflow sono no-op
// (pochi secondi) finché il file del giorno non compare; poi UNO fa il deploy e
// tutti gli altri restano no-op. Assorbe ora legale e ritardi del ministero.
//
//   SITE_URL=https://carburante.<sub>.workers.dev node scripts/should-build.ts

import { appendFileSync } from 'node:fs';

const CSV = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const siteUrl = process.env.SITE_URL?.replace(/\/$/, '');

// Last-Modified della sorgente (HEAD: nessun download).
async function sourceLastModified(): Promise<number> {
  const r = await fetch(CSV, { method: 'HEAD' });
  const lm = r.headers.get('last-modified');
  return lm ? Date.parse(lm) : NaN;
}

// sourceLastModified già online (dal manifest pubblicato). 0 se assente.
async function deployedLastModified(): Promise<number> {
  if (!siteUrl) return 0;
  try {
    const r = await fetch(`${siteUrl}/manifest.json?t=${Date.now()}`);
    if (!r.ok) return 0;
    const j = (await r.json()) as { sourceLastModified?: string };
    return j.sourceLastModified ? Date.parse(j.sourceLastModified) || 0 : 0;
  } catch {
    return 0;
  }
}

const src = await sourceLastModified();
const deployed = await deployedLastModified();
// Se non riusciamo a leggere la sorgente, meglio provare a costruire (fail-safe).
const build = !Number.isFinite(src) ? true : src > deployed;

console.log(
  `sorgente: ${Number.isFinite(src) ? new Date(src).toUTCString() : '??'} | ` +
  `online: ${deployed ? new Date(deployed).toUTCString() : '(nessuno)'} | build=${build}`,
);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
