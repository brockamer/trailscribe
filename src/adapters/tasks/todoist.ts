import type { Env } from "../../env.js";

export interface AddTaskArgs {
  task: string;
  note?: string;
  env: Env;
}

/**
 * Create a task in Todoist via REST API.
 * Stub in Phase 0 — real implementation in Phase 1.
 */
export async function addTask(_args: AddTaskArgs): Promise<void> {
  throw new Error("addTask: not implemented in Phase 0 — Phase 1 target");
}
