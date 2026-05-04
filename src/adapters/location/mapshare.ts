import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

/**
 * One breadcrumb position parsed out of a Garmin MapShare KML feed.
 *
 * Sourced from Placemark elements with a TimeStamp (the trailing LineString
 * Placemark has no TimeStamp and is filtered out by the parser).
 */
export interface KmlPing {
  /** Milliseconds since epoch. */
  t: number;
  lat: number;
  lon: number;
  /** Meters above mean sea level. */
  alt: number;
  /** Over-ground speed in km/h, as Garmin reports it. */
  velocityKmh: number;
  /** True bearing in degrees (0-360). */
  courseDeg: number;
  /** True if Garmin marked the GPS fix as valid for this point. */
  validFix: boolean;
}

export class MapShareError extends Error {
  public readonly status: number;
  constructor(opts: { status: number; message: string }) {
    super(opts.message);
    this.name = "MapShareError";
    this.status = opts.status;
  }
}

/**
 * Regex-based KML parser for Garmin MapShare share-page feeds.
 *
 * Garmin's KML schema is tightly constrained — a single XML namespace, fixed
 * ExtendedData field names, no embedded HTML. So we extract Placemark blocks
 * and per-field values via regex rather than pulling a full XML parser into
 * the Workers bundle.
 *
 * The trailing Placemark in a Garmin share KML has no TimeStamp — it's the
 * route LineString summarizing the whole session. We filter it by requiring
 * a TimeStamp/when block per ping.
 *
 * Returned pings are sorted oldest-first by timestamp.
 */
export function parsePings(kml: string): KmlPing[] {
  const pings: KmlPing[] = [];
  const placemarkRe = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let match: RegExpExecArray | null;
  while ((match = placemarkRe.exec(kml)) !== null) {
    const block = match[1];
    const whenMatch = /<TimeStamp>\s*<when>([^<]+)<\/when>/.exec(block);
    if (!whenMatch) continue;
    const t = Date.parse(whenMatch[1]);
    if (!Number.isFinite(t)) continue;

    const lat = readNumberField(block, "Latitude");
    const lon = readNumberField(block, "Longitude");
    const alt = readNumberField(block, "Elevation");
    const velocityKmh = readNumberField(block, "Velocity");
    const courseDeg = readNumberField(block, "Course");
    const validFixRaw = readStringField(block, "Valid GPS Fix");

    if (lat === null || lon === null) continue;

    pings.push({
      t,
      lat,
      lon,
      alt: alt ?? 0,
      velocityKmh: velocityKmh ?? 0,
      courseDeg: courseDeg ?? 0,
      validFix: validFixRaw === "True",
    });
  }
  pings.sort((a, b) => a.t - b.t);
  return pings;
}

function readStringField(block: string, name: string): string | null {
  const re = new RegExp(
    `<Data name="${name}">\\s*<value>([\\s\\S]*?)<\\/value>\\s*<\\/Data>`,
  );
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

function readNumberField(block: string, name: string): number | null {
  const raw = readStringField(block, name);
  if (raw === null) return null;
  const m = /^(-?\d+(?:\.\d+)?)/.exec(raw);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET the operator's MapShare KML feed for a session window.
 *
 * URL composes from MAPSHARE_BASE (the Garmin host root, e.g.
 * https://share.garmin.com — must NOT include the per-tenant slug) +
 * /Feed/Share/<MAPSHARE_KEY> + d1/d2 ISO 8601 query params. The same
 * MAPSHARE_BASE is used by link builders (where/share/blast) which compose
 * the public page URL as `${MAPSHARE_BASE}/${MAPSHARE_KEY}`.
 * d1/d2 are inclusive bounds in UTC.
 *
 * No retry — Garmin's share endpoint is fast and the caller (handleStopTrack)
 * runs inside withCheckpoint; transient failures bubble up so a Garmin webhook
 * retry can re-attempt. Throws MapShareError with the HTTP status on non-200.
 */
export async function fetchMapShareKml(
  env: Env,
  startedAtMs: number,
  closedAtMs: number,
): Promise<string> {
  const d1 = new Date(startedAtMs).toISOString();
  const d2 = new Date(closedAtMs).toISOString();
  const url = `${env.MAPSHARE_BASE}/Feed/Share/${env.MAPSHARE_KEY}?d1=${d1}&d2=${d2}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.google-earth.kml+xml" },
  });
  if (!res.ok) {
    log({
      event: "mapshare_fetch_failed",
      level: "warn",
      status: res.status,
      url,
    });
    throw new MapShareError({
      status: res.status,
      message: `MapShare fetch returned HTTP ${res.status}`,
    });
  }
  return res.text();
}
