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
- Todo: f75ad846
- In Progress: 47fc9ee4
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

The GitHub Projects v2 board at [trailscribe](https://github.com/users/brockamer/projects/3) is the **single source of
truth for what is being worked on and why**. No markdown tracking files, no separate
backlog lists, no TODO.md. If it isn't on the board, it isn't on the roadmap.

This document describes the conventions so anyone (human or Claude session) can triage,
prioritize, and move work consistently.

**Bootstrapped by Jared on 2026-04-23.** If you rename fields or add options,
re-run `scripts/bootstrap-project.py --url https://github.com/users/brockamer/projects/3 --repo brockamer/trailscribe` or edit this
file directly.

## Columns (Status field)

| Column | Meaning |
|---|---|
| **Todo** | (describe) |
| **In Progress** | Actively being worked on right now. |
| **Done** | Closed issues. Auto-populated when an issue closes. |

**Rules:**

- In Progress stays small. More than ~3 items means focus is scattered.
- Up Next is ordered — top item is what gets worked next. Priority field breaks ties.
- Nothing in In Progress without Priority and Work Stream set.
- When an issue closes, it moves to Done automatically.

## Priority field

| Value | Meaning |
|---|---|
| **High** | Directly advances the current strategic goal. Addressed before Medium. |
| **Medium** | Quality, efficiency, or reliability improvement. Important but not urgent. |
| **Low** | Nice-to-have, future-facing, or optional. Safe to defer indefinitely. |

**Rules:**

- Every open issue must have a Priority set.
- High is scarce by design — if everything is High, nothing is.
- Two High items in In Progress at once should be rare and deliberate.

## Work Stream field

_(Work Stream field has no options defined yet. Add options describing the kinds of work this project tracks — e.g., 'Backend', 'Frontend', 'Infrastructure'.)_

**Rules:**

- Work streams are project-specific and describe the kind of work, not its priority or status.
- Every open issue should belong to exactly one work stream.

## Labels

Labels describe **what kind of issue it is**, not where it lives on the board. Status
and priority come from board fields, not labels.

Suggested defaults (create via `gh label create` as needed):

| Label | Meaning |
|---|---|
| `bug` | Something isn't working |
| `enhancement` | New capability |
| `refactor` | Restructuring without behavior change |
| `documentation` | Docs-only change |
| `blocked` | Waiting on a dependency (must pair with `## Blocked by` in body) |

Project-specific scope labels (e.g., `infra`, `frontend`, `customer-facing`) belong here
too — add them as needed.

## Triage checklist — new issue

When a new issue is filed:

1. **Auto-add to board.** `gh issue create` does not auto-add; use
   `gh project item-add 3 --owner brockamer --url <issue-url>`.
2. **Set Priority** — High / Medium / Low.
3. **Set Work Stream** — per the fields above.
4. **Leave Status as Backlog** unless explicitly scheduling.
5. **Apply labels** for issue type and scope.

An issue without Priority and Work Stream sorts to the bottom and disappears.

## Fields quick reference (for gh project CLI)

```
Project ID:          PVT_kwHOAgGulc4BVfiA

Status field ID:     PVTSSF_lAHOAgGulc4BVfiAzhQ69-o
  Todo:                 f75ad846
  In Progress:          47fc9ee4
  Done:                 98236657

Priority field ID:   PVTSSF_lAHOAgGulc4BVfiAzhQ6-P0
  High:                 b555cc20
  Medium:               1cbee192
  Low:                  abd43cd0

Work Stream ID:      <unset>
  (field not present)
```

## Example — move an item to Up Next

```bash
gh project item-edit \
  --project-id PVT_kwHOAgGulc4BVfiA \
  --id <ITEM_ID> \
  --field-id PVTSSF_lAHOAgGulc4BVfiAzhQ69-o \
  --single-select-option-id <unset>
```

## Further conventions

This file is the minimum. See the skill's references for:

- `references/human-readable-board.md` — title/body templates
- `references/board-sweep.md` — grooming checklist
- `references/plan-spec-integration.md` — if this project uses plan/spec artifacts
- `references/session-continuity.md` — Session note format
