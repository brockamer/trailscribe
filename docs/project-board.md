# Project Board — How It Works

<!-- Machine-readable metadata — jared scripts parse this. Do not reorder or
     rename the fields below. The narrative docs after the field blocks are
     for humans; jared ignores them. Re-run bootstrap-project.py after any
     schema change to keep this file in sync. -->

- Project URL: https://github.com/users/brockamer/projects/3
- Project number: 3
- Project ID: PVT_kwHOAgGulc4BVfiA
- Owner: brockamer
- Repo: brockamer/trailscribe

### Status
- Field ID: PVTSSF_lAHOAgGulc4BVfiAzhQ69-o
- Backlog: f75ad846
- Up Next: 768cd670
- In Progress: 47fc9ee4
- Blocked: 162b7d54
- Done: 98236657

### Priority
- Field ID: PVTSSF_lAHOAgGulc4BVfiAzhQ6-P0
- High: b555cc20
- Medium: 1cbee192
- Low: abd43cd0

### Work Stream
- Field ID: <unset>
- (field not present)

<!-- End machine-readable block — narrative docs follow. -->

The GitHub Projects v2 board at [trailscribe](https://github.com/users/brockamer/projects/3) is the **single source of truth for execution state** — what is being worked on, by whom, in what state. Phase-level narrative and cross-issue decisions live in [`PRD.md`](PRD.md). If it isn't on the board or in the PRD, it isn't on the plan.

This document describes the conventions so anyone (human or Claude session) can triage, prioritize, and move work consistently.

**Bootstrapped by Jared on 2026-04-23. Restructured 2026-04-24** to mirror the findajob board's 5-column workflow.

## Division of labor — board vs. PRD vs. canonical docs

Drift is the main failure mode. Every fact has exactly one home. On conflict, the canonical home wins.

| Fact type | Lives in | Wins on conflict |
|---|---|---|
| Phase arc + scope rationale | [`PRD.md`](PRD.md) | PRD |
| Locked decisions (D1, D2, …) | [`PRD.md`](PRD.md) §8 + `CLAUDE.md` | PRD |
| Milestone-level deliverables | board (milestone description) | board |
| Issue Status, Priority, Milestone, labels | board | board |
| Issue body (summary, per-issue acceptance, prose depends-on) | issue | issue |
| Issue dependencies (`blockedBy` edges) | native GitHub dependency API | native edges |
| Architecture | [`architecture.md`](architecture.md) | canonical doc |
| Garmin tenant + IPC setup | [`garmin-setup.md`](garmin-setup.md) | canonical doc |
| Cloudflare provisioning | [`setup-cloudflare.md`](setup-cloudflare.md) | canonical doc |
| Active sprint plan | `plans/phase-N-*.md` | plan |

Issue bodies may *reference* the PRD ("see Phase 1 in PRD.md") but should not restate phase ordering or locked decisions. That's how drift starts.

## Columns (Status field)

Five columns, left to right. An issue moves rightward as it progresses.

| Column | Meaning | Expected count |
|---|---|---|
| **Backlog** | Captured but not yet scheduled. Triaged (has Priority) but not actively planned this cycle. | Unbounded |
| **Up Next** | Scheduled to be picked up next. The on-deck queue. When In Progress frees up, the top of Up Next moves over. | 1–3 items |
| **In Progress** | Actively being worked on right now. | 1–3 items |
| **Blocked** | Was pulled to In Progress and then hit an unanticipated stoppage. Has a `## Blocked by` body section naming the unblock owner and the specific event being waited on. Returns to In Progress when unblocked or to Backlog if punted. | 0–2 items |
| **Done** | Closed issues. Auto-populated when an issue closes. | Growing |

**Rules:**
- In Progress should stay small. More than ~3 items means focus is scattered.
- Up Next should be ordered — top item is what gets worked next. Priority field breaks ties within the column.
- Nothing in In Progress without Priority set.
- When an issue closes, it moves to Done automatically.
- An issue with unmet `blockedBy` dependencies is **not** "Blocked" — it's just queued. Items move to Blocked only after being pulled to In Progress and hitting a stoppage.

## Body sections — three independent dimensions

A given issue answers three independent questions, each with its own home:

| Question | Where it lives |
|---|---|
| Where is this work in the flow? | **Status column** (Backlog / Up Next / In Progress / Blocked / Done) |
| What does this issue depend on? | **Native `blockedBy`** — set via the GitHub dependencies API, visible in the "Linked issues" panel and Projects v2 dependency views |
| Who owns getting an actively-stuck item moving? | **`## Blocked by` body section** — present **only** on items currently in the Blocked Status column. Names the person, the specific event, and the expected-by date. |

The `## Depends on` body section, if present, is **prose context only**. The relationship data lives in native `blockedBy`.

## Priority field

Three values. This is the canonical priority signal — labels do not encode priority.

| Value | Meaning |
|---|---|
| **High** | Directly advances the current strategic goal (currently: shipping Phase 1 α-MVP end-to-end). Should be addressed before Medium work. |
| **Medium** | Quality, efficiency, or reliability improvement. Important but not blocking the strategic goal. |
| **Low** | Nice-to-have, future-facing, or optional. Safe to defer indefinitely. |

**Rules:**
- Every open issue on the board must have a Priority set.
- High is scarce by design — if everything is High, nothing is.
- Two High items in In Progress at once should be rare and deliberate.
- "Prioritize X" means *X is the top of the queue*, not *X is another High item among many*.

## Labels

Labels describe **what kind of issue it is**, not where it lives on the board. Status and priority come from board fields, not labels.

Active labels:

| Label | Meaning |
|---|---|
| `bug` | Something isn't working |
| `enhancement` | New capability |
| `refactor` | Restructuring without behavior change |
| `documentation` | Docs-only change |
| `chore` | Housekeeping / non-feature change |
| `epic` | Cross-issue work stream (parent/umbrella) |
| `ci` | CI/CD workflows |
| `infra` | Build/deploy/tooling infrastructure |
| `ai` | AI/LLM-related work (OpenRouter, prompts, narrative generation) |
| `reliability` | Idempotency, retry, error handling — Garmin-critical surface |
| `field-ops` | Garmin tenant, device, IMEI, account ownership |
| `cost` | Token budget, ledger, per-transaction cost tracking |

The legacy `blocked` label was retired on 2026-04-24 in favor of the Blocked Status column.

## Dependency relationships

Native GitHub `blockedBy` is the canonical store for "issue X depends on issue Y."

**Add an edge:**
```bash
ID_DEPENDENT=$(gh issue view <X> --repo brockamer/trailscribe --json id --jq '.id')
ID_BLOCKER=$(gh issue view <Y> --repo brockamer/trailscribe --json id --jq '.id')
gh api graphql -f query='
  mutation($i: ID!, $b: ID!) {
    addBlockedBy(input: {issueId: $i, blockingIssueId: $b}) {
      issue { number }
    }
  }' -F i="$ID_DEPENDENT" -F b="$ID_BLOCKER"
```

**Read edges:**
```bash
gh api graphql -f query='
  query($o: String!, $r: String!, $n: Int!) {
    repository(owner: $o, name: $r) {
      issue(number: $n) { blockedBy(first: 20) { nodes { number title state } } }
    }
  }' -F o=brockamer -F r=trailscribe -F n=<X>
```

A `## Depends on` body section, when present, is **human prose** explaining *why* the dependency matters. The authoritative edge is `blockedBy`.

A `blockedBy` edge does **not** automatically move an issue to the Blocked column. Items move to Blocked only when actively stuck during In Progress.

## Epics (umbrella issues)

For thematic groupings spanning multiple issues, use **native GitHub sub-issue relationships** and the `epic` label. The `Parent issue` / `Sub-issues progress` fields on the Projects board surface the hierarchy automatically.

Convention:

- Epic body has a **one-sentence deliverable** — the same discipline as a milestone. If you can't write it, the epic doesn't exist yet.
- Epic carries the `epic` label, Medium priority by default. Children carry their own priorities.
- Wire parent-child via `addSubIssue` mutation:
  ```bash
  PARENT=$(gh issue view <parent#> --repo brockamer/trailscribe --json id --jq '.id')
  CHILD=$(gh issue view <child#> --repo brockamer/trailscribe --json id --jq '.id')
  gh api graphql -f query='mutation($p: ID!, $c: ID!) { addSubIssue(input:{issueId:$p, subIssueId:$c}) { issue { number } } }' -F p="$PARENT" -F c="$CHILD"
  ```
- An epic may span milestones. A child may live in a different milestone than its parent (epics are thematic, milestones are temporal).
- Close the epic when every child is closed and the deliverable sentence is true.

## Triage checklist — new issue

When a new issue is filed:

1. **Auto-add to board.** `gh issue create` does not auto-add; use
   `gh project item-add 3 --owner brockamer --url <issue-url>`.
2. **Set Priority** — High / Medium / Low.
3. **Leave Status as Backlog** unless explicitly scheduling.
4. **Apply labels** for issue type and scope.
5. **Assign to a milestone** if the work is scoped to a phase or release.

An issue without Priority sorts to the bottom and disappears.

## Moving work — status transitions

- **Backlog → Up Next** — when scheduling the next item to work on.
- **Up Next → In Progress** — when starting work.
- **In Progress → Blocked** — when actively stuck. Add a `## Blocked by` section naming the unblocker and ETA.
- **Blocked → In Progress** — when unblocked.
- **Blocked → Backlog** — when punting indefinitely. Strip the `## Blocked by` section.
- **In Progress → Done** — happens automatically when the issue closes (via `gh issue close` or PR merge referencing the issue).

## Common inconsistencies to watch for

1. **Status is In Progress but no Priority** — actively-worked items must be fully triaged.
2. **Issue on board but closed** — should auto-move to Done; if not, set status manually.
3. **High-priority Backlog items older than two weeks** — either promote to Up Next, downgrade to Medium, or close if no longer relevant.
4. **More than 3 items in In Progress** — focus is scattered; pause and decide which to finish first.
5. **Item in Blocked column with no `## Blocked by` body section** — either unblock it back to In Progress or punt to Backlog.

## Fields quick reference (for gh project CLI)

```
Project ID:          PVT_kwHOAgGulc4BVfiA

Status field ID:     PVTSSF_lAHOAgGulc4BVfiAzhQ69-o
  Backlog:              f75ad846
  Up Next:              768cd670
  In Progress:          47fc9ee4
  Blocked:              162b7d54
  Done:                 98236657

Priority field ID:   PVTSSF_lAHOAgGulc4BVfiAzhQ6-P0
  High:                 b555cc20
  Medium:               1cbee192
  Low:                  abd43cd0
```

## Example — move an item to Up Next

```bash
gh project item-edit \
  --project-id PVT_kwHOAgGulc4BVfiA \
  --id <ITEM_ID> \
  --field-id PVTSSF_lAHOAgGulc4BVfiAzhQ69-o \
  --single-select-option-id 768cd670
```

## Further conventions

This file is the minimum. See the jared skill's references for:

- `references/human-readable-board.md` — title/body templates
- `references/board-sweep.md` — grooming checklist
- `references/plan-spec-integration.md` — plan/spec artifact integration
- `references/session-continuity.md` — Session note format
