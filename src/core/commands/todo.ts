import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { addTask, TodoistError } from "../../adapters/tasks/todoist.js";
import { recordTransaction } from "../ledger.js";
import { appendEvent } from "../context.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { log } from "../../adapters/logging/worker-logs.js";

type TodoCommand = Extract<ParsedCommand, { type: "todo" }>;

interface HandleTodoContext extends OrchestratorContext {
  idemKey: string;
}

/**
 * `!todo <task>` pipeline (plan P1-18). Composes Todoist create
 * (checkpointed) → ledger + context → reply with the public Todoist URL.
 */
export async function handleTodo(cmd: TodoCommand, ctx: HandleTodoContext): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  let url: string;
  try {
    const result = await withCheckpoint(env, idemKey, "todo", () =>
      addTask({
        task: cmd.task,
        lat,
        lon,
        timestamp: Date.now(),
        env,
      }),
    );
    url = result.url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "todo_create_failed", level: "error", imei, error: msg });
    await markFailed(env, idemKey, `todo: ${msg}`);
    if (err instanceof TodoistError) {
      return { body: `Todo failed: ${msg.slice(0, 80)}` };
    }
    return { body: `Error: ${msg.slice(0, 80)}` };
  }

  try {
    await recordTransaction({
      command: "todo",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
  } catch (err) {
    log({
      event: "todo_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await appendEvent(
      imei,
      {
        timestamp: Date.now(),
        lat,
        lon,
        command_type: "todo",
        free_text: cmd.task,
      },
      env,
    );
  } catch (err) {
    log({
      event: "todo_context_append_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { body: `Task added · ${url}`, lat, lon };
}
