/**
 * Structured logger. One JSON line per call, written to stdout — picked up by
 * `wrangler tail` and the Workers Logs UI. Keys stay in logfmt-able order so
 * grepping stays ergonomic (`event=... imei=... cmd=...`).
 */

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  event: string;
  level?: LogLevel;
  [key: string]: unknown;
}

export function log(fields: LogFields): void {
  const { level = "info", ...rest } = fields;
  const record = {
    ts: new Date().toISOString(),
    level,
    ...rest,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}
