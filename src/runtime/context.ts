/**
 * Context module. Provides helper functions to derive contextual
 * information such as the nearest named place and a brief weather
 * summary based on coordinates. These functions can be implemented
 * using public APIs (e.g. Nominatim, OpenWeather) but are stubbed
 * here for simplicity.
 */

export async function getNearestPlaceAndWeather(opts: {
  lat?: number;
  lon?: number;
}): Promise<string> {
  const { lat, lon } = opts;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return 'Location unknown.';
  }
  // Stubbed: return a generic description. In production you could
  // call a reverse geocoding service and a weather API to build a
  // concise summary. Keep the response short and user‑friendly.
  return `Near coordinates ${lat.toFixed(4)}, ${lon.toFixed(4)}. Weather: clear skies.`;
}