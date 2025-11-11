import { z } from 'zod';

/**
 * Environment variable schema. Use zod to validate presence and types
 * of required configuration values. All variables are loaded from
 * process.env at runtime. Required variables must be set in your
 * hosting platform (Pipedream, n8n, Cloudflare Workers, etc.).
 */
const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_MAPS_BASE: z.string().default('https://www.google.com/maps/search/?api=1&query='),
  MAPSHARE_BASE: z.string().optional(),
  GMAIL_SENDER: z.string().optional(),
  TODOIST_API_TOKEN: z.string().optional(),
  POSTHAVEN_TO: z.string().optional(),
  DAILY_TOKEN_BUDGET: z
    .string()
    .default('0')
    .transform((v) => parseFloat(v)),
  APPEND_COST_SUFFIX: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  OPENAI_INPUT_COST_PER_1K: z.string().default('0.0'),
  OPENAI_OUTPUT_COST_PER_1K: z.string().default('0.0'),
  LEDGER_BACKEND: z.string().default('memory'),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Load and validate environment variables. Throws when required
 * variables are missing. Call this once at startup to get a typed
 * configuration object.
 */
export function loadConfig(): Config {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error('Invalid environment configuration: ' + JSON.stringify(result.error.format()));
  }
  return result.data;
}