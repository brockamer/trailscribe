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
