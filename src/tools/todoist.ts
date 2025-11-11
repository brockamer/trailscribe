import { Config } from '../config/env';

/**
 * Add a new task to Todoist. Uses the provided API token from the
 * environment. This stub logs the task to the console. When
 * deployed on Pipedream or n8n you can use their built‑in Todoist
 * nodes to perform the real API call.
 */
export async function addTask(opts: {
  task: string;
  config: Config;
}): Promise<void> {
  const { task } = opts;
  console.log(`[Todoist] added task: ${task}`);
  // TODO: call Todoist API using TODOIST_API_TOKEN
}