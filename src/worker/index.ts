// Worker "leggero": serve la PWA e le tessere (asset statici) e fa da proxy per il
// geocoding. Il lavoro pesante (build giornaliero delle tessere) NON gira qui —
// sul piano gratuito il limite è 10 ms di CPU per invocazione, mentre il parsing
// dei CSV costa ~170 ms. Quello gira su GitHub Actions (vedi .github/workflows).

import { handleGeocode } from './geocode.ts';

export interface Env {
  /** Asset statici (public/): PWA, /manifest.json, /tiles/*.json */
  ASSETS: Fetcher;
  /** User-Agent da inviare a Nominatim (policy d'uso). Configurabile via var. */
  GEOCODER_UA?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/geocode') {
      return handleGeocode(request, env, ctx);
    }

    // Tutto il resto (PWA + tessere + manifest) è servito come asset statico.
    return env.ASSETS.fetch(request);
  },
};
