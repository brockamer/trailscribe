import { makeApp } from "./app.js";
import type { Env } from "./env.js";

/**
 * Worker entry point. Cloudflare invokes `fetch(req, env, ctx)` per request;
 * we delegate to a shared Hono instance created once per isolate.
 */
const app = makeApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};

export { makeApp };
