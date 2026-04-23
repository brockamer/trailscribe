# Contributing

Thanks for taking an interest in TrailScribe. Until α-MVP ships, external
contributions are low-priority — the maintainer is iterating fast and the
architecture is still moving. The guidance below applies once α-MVP is
public.

## Code of conduct

All participants are expected to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## How to contribute

1. **Open an issue first.** Describe the problem, reproduction steps, or
   feature proposal. For anything beyond a typo, wait for maintainer
   response before implementing — reduces wasted work on out-of-scope
   changes.
2. **Fork + branch.** Descriptive branch names: `fix-idempotency-edge-case`,
   `feat-weather-adapter`.
3. **Follow the conventions.** See [`docs/architecture.md`](docs/architecture.md)
   and [`CLAUDE.md`](CLAUDE.md) for module layout and style.
4. **Keep the reply budget sacred.** Any feature that touches the outbound
   path must respect the ≤320-char total reply cap.
5. **Tests alongside behavior.** Vitest unit tests for core logic; fixtures
   (`tests/fixtures/`) for any new Garmin schema variation.
6. **PR against `main`.** Include a summary of the change and reference the
   issue. CI must pass (typecheck + test).

## Development workflow

```bash
pnpm install
cp .dev.vars.example .dev.vars   # populate secrets locally
pnpm test                         # Vitest — all tests must pass
pnpm typecheck                    # tsc --noEmit — clean
pnpm dev                          # wrangler dev on local address
```

For first-time Cloudflare setup: [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md).
For Garmin IPC: [`docs/garmin-setup.md`](docs/garmin-setup.md) (requires Professional tier).

## Style

- **TypeScript strict mode**; tests use `.ts` as well.
- **No `any`** — prefer `unknown` and narrow.
- **Small exported functions**; JSDoc on every public export.
- **Prettier** (`pnpm format`) for formatting. Lint config is deferred
  post-Phase-0.
- **Structured logs** via `src/adapters/logging/worker-logs.ts`. No
  `console.log` scattered through the codebase.

## Issue tracking

Issues and PRs flow through a GitHub Project board managed by the maintainer's
[`jared`](https://github.com/brockamer/jared) plugin. The board is not yet
bootstrapped for this repo — planned post-Phase-0.

## Scope discipline

Do NOT:
- Add a new dependency without PRD justification.
- Add a new env var / secret without updating `src/env.ts` + `.dev.vars.example`
  + `wrangler.toml` atomically.
- Bring back Pipedream / n8n integrations (archived as historical paths).
- Add command verbs outside the α-MVP set (`!ping`, `!help`, `!cost`, `!post`,
  `!mail`, `!todo`) without updating the PRD. Phase 2+ commands are already
  planned; see [`docs/PRD.md`](docs/PRD.md) §2.
