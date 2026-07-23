# carburante

Trova i distributori **più vicini ed economici** a partire dai tuoi indirizzi,
usando i dati giornalieri dell'Osservaprezzi carburanti del MIMIT.

Obiettivo: veloce, sempre aggiornato, funzionante offline (PWA). L'utente salva i
suoi indirizzi preferiti (geocodificati e confermati su mappa), sceglie un raggio in
km, e vede i distributori ordinati per prezzo, anche su mappa.

## Fonte dati (MIMIT / Osservaprezzi)

Due CSV sovrascritti ogni mattina (~08:45–08:51 ora italiana, verificato via
`Last-Modified`):

- Prezzi: `https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv`
  → `idImpianto | descCarburante | prezzo | isSelf | dtComu`
- Anagrafica: `https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv`
  → `idImpianto | Gestore | Bandiera | Tipo Impianto | Nome Impianto | Indirizzo | Comune | Provincia | Latitudine | Longitudine`

Chiave di join: `idImpianto`.

### Cose non ovvie (verificate empiricamente, non assumerle a memoria)

- **Riga 0** = `Estrazione del YYYY-MM-DD` (da scartare); l'header è la riga 1.
- **Il separatore cambia nel tempo**: `;` nei file 2023, `|` nei 2026. Va dedotto
  dall'header, mai hardcodato (`sniffDelimiter`).
- **Separatore dentro i campi**: alcune righe hanno un `|` nel campo Nome Impianto
  (es. `X | gestori.prezzibenzina.it`). I campi utili sono ancorati agli **estremi**
  della riga (id/bandiera/tipo da sinistra; comune/lat/lon da destra), così non si
  perdono righe.
- **Coordinate già nel file** (lat/lon reali): niente geocoding degli indirizzi
  (che sono testo libero e sporco). ~0,45% di coord assenti/`(0,0)` da scartare.
- **`idImpianto` è stabile e non riciclato**: progressivo crescente, sopravvive ai
  cambi di gestore/bandiera. Sicuro come chiave per uno storico per-stazione.
- **`descCarburante` è testo libero** (~57 diciture): normalizzato in categorie
  canoniche in `src/pipeline/fuels.ts` (tabella da rifinire nel tempo).
- **URL**: path stabile dal 2017 ma il **dominio cambia** (`mise.gov.it` →
  `mimit.gov.it`); tenere gli URL in config e seguire i redirect.
- **Change detection**: usare richieste condizionali `If-None-Match` (ETag) → `304`
  a costo zero quando il file non è cambiato (vedi `scripts/fetch-data.ts`).

## Architettura

- **Ingest (Worker + Cron)**: la mattina, GET condizionale ai due CSV; se cambiati,
  parse → join → normalizza carburanti → scarta coord invalide → calcola prezzo min
  per carburante (self/servito) → **suddivide in tessere geografiche** e le pubblica
  su R2 con un `manifest.json` (versione + hash per tessera).
- **Client (PWA)**: preferiti in IndexedDB (restano sul dispositivo). Per una
  ricerca scarica **solo le tessere vicine**, salta quelle con hash invariato
  (cache), calcola distanze (Haversine) e ordina per prezzo **in locale**. Mappa con
  Leaflet/MapLibre + tile OSM.

### Perché le tessere (e `TILE_DEG`)

Griglia di `TILE_DEG` gradi (default `0.5` ≈ 55×41 km). Sui dati reali: **212
tessere**, mediana 65 stazioni/tessera, dataset intero **~0.6 MB gz**. Una ricerca
tocca ~9 tessere (~30–70 kB gz, poi in cache) e filtra in **<1 ms**. Tunabile: più
piccolo = meno over-fetch per query ma più tessere.

## Sviluppo

```bash
npm install
npm run fetch-data   # scarica i CSV in data/ (condizionale via ETag)
npm run dry-run      # valida pipeline + tiling + query di prova sui dati reali
npm run typecheck
```

Licenza: AGPL-3.0-or-later.
