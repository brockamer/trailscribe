import type { Env } from "../../env.js";

const TODOIST_URL = "https://api.todoist.com/rest/v2/tasks";
const TODOIST_TASK_URL = "https://todoist.com/showTask?id=";
const RETRY_DELAYS_MS = [1000, 4000, 16000] as const;

export interface AddTaskArgs {
  task: string;
  lat?: number;
  lon?: number;
  /** Wall-clock ms (Garmin event timeStamp). */
  timestamp: number;
  env: Env;
  /** Injectable sleep helper for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
}

export class TodoistError extends Error {
  public readonly status: number;
  public readonly body?: unknown;

  constructor(opts: { status: number; message: string; body?: unknown }) {
    super(opts.message);
    this.name = "TodoistError";
    this.status = opts.status;
    this.body = opts.body;
  }
}

/**
 * Create a Todoist task. With lat/lon present, the description carries the
 * coords + ISO timestamp ("From inReach: 37.1682,-118.5891 @ 2025-02-17T14:20:15.000Z");
 * without GPS, just the timestamp. No `due_string` for α — Phase 2+ may
 * parse `!todo <task> by:tomorrow`.
 *
 * Returns the task id and the public Todoist URL for inclusion in the reply.
 *
 * 4xx errors surface immediately; 5xx + network retry at 1s/4s/16s.
 */
export async function addTask(args: AddTaskArgs): Promise<{ id: string; url: string }> {
  const { task, lat, lon, timestamp, env } = args;
  const delay = args.delay ?? defaultDelay;
  const description = formatDescription(timestamp, lat, lon);
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: task, description }),
  };

  let lastErr: TodoistError | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }

    let res: Response;
    try {
      res = await fetch(TODOIST_URL, init);
    } catch (e) {
      lastErr = new TodoistError({
        status: 0,
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { id: string };
      return { id: data.id, url: `${TODOIST_TASK_URL}${data.id}` };
    }

    const body = await readErrorBody(res);
    const err = new TodoistError({
      status: res.status,
      message: `Todoist HTTP ${res.status}`,
      body,
    });

    if (res.status >= 400 && res.status < 500) {
      throw err;
    }
    lastErr = err;
  }

  throw (
    lastErr ?? new TodoistError({ status: 0, message: "addTask failed without a captured error" })
  );
}

function formatDescription(timestamp: number, lat?: number, lon?: number): string {
  const iso = new Date(timestamp).toISOString();
  if (lat !== undefined && lon !== undefined) {
    return `From inReach: ${lat},${lon} @ ${iso}`;
  }
  return `From inReach — sent ${iso}`;
}

async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
