// Normalizzazione dei nomi carburante.
//
// `descCarburante` nel file prezzi è TESTO LIBERO: ~57 diciture diverse, molte
// delle quali sono nomi commerciali (Blue Diesel, HVOlution, Shell V Power...).
// Per un confronto "il più economico" sensato le riduciamo a poche categorie
// canoniche. Questa tabella è volutamente semplice e va rifinita nel tempo:
// il dry-run stampa le diciture non mappate così le aggiungiamo qui.

export type CanonFuel =
  | 'benzina'
  | 'benzina_plus'
  | 'gasolio'
  | 'gasolio_plus'
  | 'gpl'
  | 'metano'
  | 'gnl'
  | 'hvo';

export const CANON_FUELS: CanonFuel[] = [
  'benzina', 'benzina_plus', 'gasolio', 'gasolio_plus', 'gpl', 'metano', 'gnl', 'hvo',
];

// Parole che marcano una variante "premium"/branded rispetto al prodotto base.
const PREMIUM = [
  'BLUE', 'BLU ', 'SUPREME', 'HI-Q', 'HIQ', 'PREMIUM', 'V-POWER', 'V POWER',
  'EXCELLIUM', 'ENERGY', 'ORO', 'DIESELMAX', 'SPECIAL', 'ARTICO', 'GELO',
  'ALPINO', 'IGLOO', 'PRESTAZ', 'ECOPLUS', 'S-DIESEL', 'E-DIESEL', 'EDIESEL',
  'SHELL V', 'F101', 'F-101', 'F 101', 'WR 100', 'PERFORM', 'GP DIESEL',
  'FUTURE', 'RACE', 'PLUS', '98', '100 OTTAN', '102', 'SPEED', 'RACING',
];

function isPremium(u: string): boolean {
  return PREMIUM.some((k) => u.includes(k));
}

// Nomi puramente commerciali che non contengono "benzina"/"gasolio" e vanno
// mappati esplicitamente (altrimenti cadono tra i non riconosciuti).
const OVERRIDES: Record<string, CanonFuel> = {
  'HIQ PERFORM+': 'benzina_plus', // IP HiQ Perform+ (98 ottani)
  'HIQ PERFORM': 'benzina_plus',
  'F101': 'benzina_plus', // Tamoil F101 premium
  'F-101': 'benzina_plus',
  'F 101': 'benzina_plus',
  'V-POWER': 'benzina_plus', // Shell V-Power (la variante diesel dice "Diesel")
  'V POWER': 'benzina_plus',
};

/**
 * Riduce una dicitura MIMIT a una categoria canonica, o `null` se non riconosciuta.
 * L'ordine dei controlli conta (GPL/metano/GNL/HVO prima di benzina/gasolio).
 */
export function classifyFuel(desc: string): CanonFuel | null {
  const u = desc.toUpperCase().trim();
  if (u === '') return null;

  if (OVERRIDES[u]) return OVERRIDES[u];

  if (u.includes('GPL')) return 'gpl';
  if (u.includes('GNL') || u.includes('L-GNC') || u.includes('LNG')) return 'gnl';
  if (u.includes('METANO') || u.includes('GNC')) return 'metano';
  if (u.includes('HVO') || u.includes('REHVO')) return 'hvo';

  if (u.includes('GASOLIO') || u.includes('DIESEL')) {
    return isPremium(u) ? 'gasolio_plus' : 'gasolio';
  }
  if (u.includes('BENZINA') || u.includes('VERDE') || u.includes('SUPER')) {
    return isPremium(u) ? 'benzina_plus' : 'benzina';
  }
  return null;
}
