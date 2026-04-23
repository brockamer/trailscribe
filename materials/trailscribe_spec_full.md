## Trailscribe Unified Specification

This document combines both **Product** and **Engineering** specifications into a single, cohesive reference. It follows current software product management and software engineering best practices, providing clear alignment between user value and technical implementation.

---

# 1. Product Specification

### 1.1 Overview
**Trailscribe** is an intelligent companion for satellite-connected adventurers, researchers, and travelers operating off-grid. It extends the limited messaging capabilities of Garmin InReach and similar devices by enabling asynchronous AI-assisted communication, journaling, and automation.

Trailscribe transforms simple text commands into rich interactions with AI and connected services (email, Todoist, blog platforms) — all while maintaining ultra-low bandwidth efficiency suitable for satellite networks.

---

### 1.2 Problem Statement
Satellite messengers like Garmin InReach provide reliable text-based communication in remote environments but lack integration with modern productivity tools, data logging systems, or AI assistance. Users can share coordinates or send short messages — but not automate workflows, log their journeys narratively, or interact with services like OpenAI, Gmail, or Todoist.

**Trailscribe** fills that gap by acting as a lightweight bridge between satellite communication and the modern internet.

---

### 1.3 Value Proposition
Trailscribe allows users to:
- Send AI-assisted commands via satellite text messages.
- Automatically log positions, generate narrative updates, and share them via email or blog.
- Enrich GPS data with weather, maps, and contextual information.
- Manage personal productivity tasks (e.g., Todoist integration).
- Track API usage and costs in real-time.

This transforms an ordinary GPS tracker into a digital field companion.

---

### 1.4 Core Features
- **Command-based AI Interaction** — Compact text commands trigger actions such as posting, journaling, or messaging.
- **Narrative Generation Engine** — Converts GPS and environmental data into creative summaries (`title`, `haiku`, `body`).
- **Context Persistence** — Maintains recent positions and messages for continuity and richer storytelling.
- **Integrations** — Gmail (email/blog posts), Todoist (task logging), OpenAI (narratives), and geolocation/weather APIs.
- **Usage Tracking** — Transparent ledger showing API token usage and cost per user.
- **Low Bandwidth Protocol** — Designed for ~160-character satellite messages with concise replies.

---

### 1.5 Target Users
- Outdoor adventurers, overlanders, and long-distance hikers.
- Field researchers, conservationists, and environmental scientists.
- Search-and-rescue teams or expedition leaders.
- Solo travelers who want reliable journaling or task tracking.

---

### 1.6 User Experience Goals
- **Simple** — One-line text commands; zero configuration during expeditions.
- **Reliable** — Works offline; queues actions and confirms receipt.
- **Transparent** — Replies indicate cost and success/failure.
- **Secure** — No sensitive data stored beyond operational context.
- **Delightful** — Feels like talking to a capable assistant, not a machine.

---

### 1.7 Success Metrics
- Number of active users with successful AI-assisted interactions.
- Frequency of `!post`, `!todo`, or `!mail` command usage.
- Uptime and message delivery success rate.
- Cost per transaction under $0.05.
- Engagement measured by number of generated posts or logs per week.

---

### 1.8 Constraints
- Max 160-character inbound message length.
- Satellite latency (10–60 seconds typical).
- Limited storage and compute per Cloudflare Worker.
- Data retention: recent messages and positions only (rolling window).

---

### 1.9 Competitive Landscape
| System | Capabilities | Limitation |
|---------|--------------|-------------|
| Garmin Explore / MapShare | Native GPS tracking | No automation or AI |
| Pipedream + Custom Workflows | Full automation | Requires technical setup |
| Zapier / IFTTT | Low-code integrations | Poor fit for satellite use |
| Trailscribe | Edge-based AI + contextual automation | Built for low bandwidth |

---

# 2. Engineering Specification

### 2.1 Technical Summary
**Language:** TypeScript  
**Primary Runtime:** Cloudflare Workers  
**Storage:** Cloudflare KV (Context + Ledger)

Design principles:
- Event-driven architecture (HTTP inbound).
- Stateless functions; persistent data in KV.
- Modular adapters for APIs.
- Fully managed GitHub → Cloudflare deployment pipeline.

---

### 2.2 Repository Structure
```
trailscribe/
├─ README.md
├─ LICENSE (MIT)
├─ package.json
├─ tsconfig.json
├─ wrangler.toml
├─ src/
│  ├─ core/
│  │  ├─ types.ts
│  │  ├─ commands.ts
│  │  ├─ orchestrator.ts
│  │  ├─ narrative.ts
│  │  ├─ context.ts
│  │  ├─ ledger.ts
│  │  └─ config.ts
│  ├─ adapters/
│  │  ├─ inbound/cloudflare-worker.ts
│  │  ├─ storage/cf-kv.ts
│  │  ├─ mail/gmail.ts
│  │  ├─ tasks/todoist.ts
│  │  ├─ publish/posthaven-email.ts
│  │  ├─ location/georesolve.ts
│  │  └─ logging/console.ts
│  ├─ env.ts
│  └─ handler.ts
├─ docs/
│  ├─ product-spec.md
│  ├─ architecture.md
│  ├─ setup-cloudflare.md
│  ├─ commands.md
│  └─ CHANGELOG.md
├─ .github/workflows/
│  ├─ ci.yml
│  └─ deploy-cloudflare.yml
└─ tests/
   ├─ commands.test.ts
   ├─ orchestrator.test.ts
   └─ cf-kv.test.ts
```

---

### 2.3 Core Components

**1. Cloudflare Worker (Inbound Gateway)**  
Handles all inbound HTTP requests from Garmin or other sources.
- Normalizes messages into `TrailEvent` objects.
- Routes commands via `orchestrator`.

**2. Command Processor**  
- Parses `!` commands.
- Dispatches to handlers:
  - `!ping`, `!where`, `!todo`, `!mail`, `!post`, `!cost`, `!help`.

**3. Trip Context Manager (KV)**  
- Maintains short rolling history (positions + messages).
- Uses user/device ID as key.

**4. Narrative Engine (OpenAI)**  
- Uses GPT model to create structured `{ title, haiku, body }` outputs.
- Sanitizes JSON, applies formatting rules.

**5. Integrations Layer**  
- Gmail: Outbound mail + Posthaven publishing.
- Todoist: Task creation.
- Weather/Geocoding APIs: Enrichment.

**6. Ledger (KV)**  
- Records token usage and cost per call.
- Summarized monthly.

**7. Output Formatting**  
- Returns both JSON (for API users) and compact plain text (for satellite reply).
- Optional suffix for cost display.

---

### 2.4 Environment Variables
```
TRAILSCRIBE_ENV=production|staging|dev
OPENAI_API_KEY=
MAPSHARE_BASE_URL=https://share.garmin.com/your_mapshare_id
GOOGLE_MAPS_LINK_BASE=https://www.google.com/maps/search/?api=1&query=
GEOCODE_API_KEY=
WEATHER_API_KEY=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
EMAIL_FROM=you@example.com
TODOIST_API_TOKEN=
POSTHAVEN_TO=your_blog@posthaven.com
OPENAI_INPUT_COST_PER_1K=0.00xx
OPENAI_OUTPUT_COST_PER_1K=0.00yy
APPEND_COST_SUFFIX=true
```

---

### 2.5 Cloudflare Configuration (wrangler.toml)
```toml
name = "trailscribe"
main = "src/adapters/inbound/cloudflare-worker.ts"
compatibility_date = "2025-01-01"

[vars]
TRAILSCRIBE_ENV = "production"

[kv_namespaces]
bindings = [
  { binding = "TRAILSCRIBE_CONTEXT_KV", id = "xxxx" },
  { binding = "TRAILSCRIBE_LEDGER_KV", id = "yyyy" }
]
```

---

### 2.6 Testing & CI/CD
- **Testing:** Jest or Vitest for unit/integration tests.
- **CI/CD:** GitHub Actions to run tests and deploy via `wrangler publish`.
- **Linting:** ESLint + Prettier.
- **Versioning:** Semantic Versioning (SemVer).

---

### 2.7 Security & Compliance
- No persistent PII beyond what’s needed for trip context.
- API keys encrypted in Cloudflare dashboard.
- Logs redact all sensitive information.
- Audit cost ledger monthly.

---

### 2.8 Future Engineering Roadmap
- **v1.1**: Add Cloudflare D1 backend for multi-user analytics.
- **v1.2**: Add basic dashboard for viewing routes, logs, and posts.
- **v1.3**: Introduce custom GPT personalities per user.

---

# 3. Governance

**License:** MIT  
**Repo Ownership:** Brock Amer (maintainer)  
**Contribution Model:** Pull requests reviewed via GitHub Flow  
**Release Cadence:** Monthly minor releases, quarterly feature releases  
**Documentation:** Stored in `/docs`, generated to GitHub Pages via Actions

---

**End of Trailscribe Unified Specification**

