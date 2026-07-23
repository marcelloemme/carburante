// Parsing dei CSV dell'Osservaprezzi MIMIT.
//
// Peculiarità del formato verificate sui dati reali (vedi memoria del progetto):
//  - La riga 0 è "Estrazione del YYYY-MM-DD" e va scartata.
//  - La riga 1 è l'header.
//  - Il separatore CAMBIA nel tempo: ';' nei file più vecchi (2023), '|' in quelli
//    recenti (2026). Non va MAI hardcodato: lo deduciamo contando i separatori
//    candidati nell'header.

export interface ParsedCsv {
  /** Data dichiarata nella prima riga ("Estrazione del ..."), se presente. */
  extractionDate: string | null;
  header: string[];
  /** Righe dati già divise in campi (stringhe grezze, non trim-mate). */
  rows: string[][];
  /** Righe scartate perché con numero di colonne diverso dall'header. */
  malformed: number;
}

const CANDIDATE_DELIMITERS = ['|', ';', '\t', ','] as const;

/** Deduce il separatore contando le occorrenze nell'header. */
export function sniffDelimiter(headerLine: string): string {
  let best = '|';
  let bestCount = -1;
  for (const d of CANDIDATE_DELIMITERS) {
    const count = headerLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string): ParsedCsv {
  // Normalizza i fine-riga e togli eventuale BOM.
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');

  let idx = 0;
  let extractionDate: string | null = null;
  const first = (lines[0] ?? '').trim();
  const m = first.match(/Estrazione del\s+(\d{4}-\d{2}-\d{2})/i);
  if (m) {
    extractionDate = m[1] ?? null;
    idx = 1;
  }

  const headerLine = lines[idx] ?? '';
  const delimiter = sniffDelimiter(headerLine);
  const header = headerLine.split(delimiter);
  const expected = header.length;

  // Teniamo le righe con ALMENO tante colonne quante l'header: alcune righe hanno
  // il separatore dentro un campo di testo (es. Nome Impianto = "X | gestori...").
  // I campi utili stanno a posizioni fisse rispetto agli estremi, quindi le
  // ancoriamo dai due lati (vedi buildDataset). Scartiamo solo le righe TROPPO corte.
  const rows: string[][] = [];
  let malformed = 0;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    const fields = line.split(delimiter);
    if (fields.length < expected) {
      malformed++;
      continue;
    }
    rows.push(fields);
  }

  return { extractionDate, header, rows, malformed };
}

/** Trim di un campo, gestendo spazi e tab interni ai valori del MIMIT. */
export function t(s: string | undefined): string {
  return (s ?? '').replace(/^[\s]+|[\s]+$/g, '');
}
