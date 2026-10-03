/**
 * Core domain types for TrailScribe.
 *
 * α-MVP command set per PRD §2: `!post`, `!mail`, `!todo`, `!ping`, `!help`, `!cost`.
 * Phase 2 adds: `!where`, `!weather`, `!drop`, `!brief`, `!ai`, `!camp`, `!share`,
 * `!blast`, `!postimg` (see plans/phase-2-extended-commands.md P2-02 + P2-18).
 */

export type ParsedCommand =
  | { type: "ping" }
  | { type: "help" }
  | { type: "cost" }
  | { type: "post"; note?: string }
  | { type: "mail"; to: string; subj?: string; body?: string }
  | { type: "todo"; task: string }
  | { type: "where" }
  | { type: "weather" }
  | { type: "drop"; note: string }
  | { type: "brief"; windowDays?: number }
  | { type: "ai"; question: string }
  | { type: "camp"; query: string }
  | { type: "share"; to: string; note: string }
  | { type: "blast"; note: string }
  | { type: "postimg"; caption?: string };

/** Commands whose reply-budget accounting draws from the AI ledger. */
export const AI_COMMANDS: ReadonlySet<ParsedCommand["type"]> = new Set([
  "post",
  "brief",
  "ai",
  "camp",
  "postimg",
]);

/**
 * Canonical Garmin IPC Outbound event (schema V2).
 * We tolerate extra fields from V3/V4 but only consume the V2 subset.
 * See materials/Garmin IPC Outbound.txt for the authoritative contract.
 */
export interface GarminEvent {
  imei: string;
  messageCode: number;
  freeText?: string;
  timeStamp: number;
  addresses?: Array<{ address: string }>;
  point?: {
    latitude: number;
    longitude: number;
    altitude?: number;
    gpsFix?: number;
    course?: number;
    speed?: number;
  };
  status?: {
    autonomous?: number;
    lowBattery?: number;
    intervalChange?: number;
    resetDetected?: number;
  };
  payload?: string;
}

export interface GarminEnvelope {
  Version: string;
  Events: GarminEvent[];
}

/**
 * The orchestrator's reply shape. `body` must be ≤320 chars total
 * (two SMS; paged into 160-char chunks at the IPC Inbound boundary). With
 * `journalUrl` or `links` set, the links take a page of their own and `body`
 * gets ≤155.
 */
export interface CommandResult {
  body: string;
  /** Journal post URL; `buildReply` keeps it whole and adds the live hint (#249). */
  journalUrl?: string;
  /** Other links, e.g. `!where` map links; `buildReply` keeps each whole (#261). */
  links?: string[];
}
