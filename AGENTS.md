# Agent Rules — TabCycle

## Project Overview

TabCycle is a **Chrome Manifest V3 extension** that manages the lifecycle of open
tabs. Tabs age through colour-coded statuses (Green → Yellow → Red → Gone) based
on user-active time or wall-clock time. Aging tabs are sorted into status zones,
grouped into special "Yellow" / "Red" groups, and eventually bookmarked and closed.

### Key Concepts

- **Status lifecycle**: Green → Yellow → Red → Gone. Thresholds are
  user-configurable (defaults: 4 h / 8 h / 24 h).
- **Active-time tracking**: A single global counter incremented whenever any
  Chrome window has focus. This is the default age measure for all tabs.
- **Per-window sorting**: Tab groups are sorted into zones (green | yellow | red)
  independently per window. Tabs never move between windows.
- **Special groups**: Extension-created groups named "Yellow" and "Red" hold
  ungrouped tabs that have aged. They are exempt from group-level status, sorting,
  and gone-closing. Individual tabs inside them are processed independently.
- **User groups**: Tabs inside user-created groups stay in their group. The
  group's status is determined by its freshest tab (`computeGroupStatus`).
- **Bookmark on gone**: When enabled (default), gone tabs/groups are bookmarked
  into a configurable folder under "Other Bookmarks" before closing.
- **Evaluation cycle**: Runs every 30 s via `chrome.alarms`. Guard flags
  (`evaluationCycleRunning`, `tabPlacementRunning`) suppress reactive event
  handlers during the cycle to prevent stale-state races.

---

## Repository Layout

```
src/
  manifest.json              # MV3 manifest — canonical permission source
  background/
    service-worker.js        # Entry point, event handlers, evaluation cycle
    group-manager.js         # sortTabsAndGroups, computeGroupStatus, zone logic
    tab-placer.js            # onCreated placement (openerTabId-based)
    tab-tracker.js           # Navigation handlers, refresh-time resets
    status-evaluator.js      # Pure: compute tab status from age + thresholds
    time-accumulator.js      # Global active-time counter (focus tracking)
    state-persistence.js     # reconcileState, scanExistingTabs
    bookmark-manager.js      # Bookmark folder resolution, tab/group bookmarking
  shared/
    constants.js             # Storage keys (v1_*), defaults
    logger.js                # Structured logging
    schemas.js               # Storage schema validation
  options/                   # Settings page (HTML/CSS/JS)
tests/
  unit/                      # Jest, mocked Chrome APIs
  integration/               # Jest, multi-module interactions with mocks
  e2e/                       # Jest, lightweight end-to-end (mocked)
  e2e-chrome/                # Jest + Puppeteer, real Chrome instance (CDP)
    harness.js               # Shared harness: browser launch, CDP helpers
specs/
  001-manage-tab-lifecycle/  # Core lifecycle spec
  002-bookmark-closed-tabs/  # Bookmark-on-gone spec
```

---

## Testing Discipline

- **Failing test = evidence, not noise.** When a test fails, always investigate
  whether it has caught a real bug before assuming the test itself is wrong. Only
  modify the test after confirming the production code is correct.
- Prefer minimal upstream fixes over downstream workarounds.
- Bug fixes MUST include a failing regression test before the fix.
- Never delete or weaken a test without explicit direction from the user.

### Test Layers

| Layer | Command | What it covers |
|-------|---------|----------------|
| Unit | `npm run test:unit` | Pure logic (status-evaluator, group sorting, schemas) |
| Integration | `npm run test:integration` | Multi-module flows with mocked Chrome APIs |
| E2E (mocked) | `npm run test:e2e` | Lightweight end-to-end with mocked APIs |
| **E2E Chrome** | `npm run test:e2e-chrome` | Real Chrome + Puppeteer via CDP (47 tests, 9 suites) |

`npm test` runs unit + integration + e2e (mocked). E2E Chrome tests run
separately and require a display server.

### Progressive E2E Re-run Strategy

When an E2E Chrome test fails, re-run tests **progressively** to isolate the
problem and avoid wasting time on the full suite:

1. **Failing test in isolation first.** Run only the single failing test file:
   ```
   npm run test:e2e-chrome -- --testPathPattern='<test-file-name>'
   ```
   Debug and fix until this passes in isolation.

2. **Test set containing the test.** Once the isolated test passes, run the
   related test suite/file group to confirm no interactions:
   ```
   npm run test:e2e-chrome -- --testPathPattern='<test-file-name>|<related-file>'
   ```

3. **Full suite only after isolation passes.** Only when the above steps pass,
   run the complete E2E Chrome suite:
   ```
   npm run test:e2e-chrome
   ```

Never jump straight to the full suite when debugging a failure — it is slow
(~2 min) and masks interaction bugs.

### When E2E Chrome Tests MUST Run

- After changing core extension logic (service worker, group management, tab
  placement, status evaluation, sorting).
- After changing Chrome API usage patterns or adding new API calls.
- After modifying the evaluation cycle, event handlers, or guard flags.
- Before any release or version bump.
- When debugging a behaviour that unit tests cannot reproduce.

### When E2E Chrome Tests Need NOT Run

- After cosmetic changes (CSS, options page layout, icon updates).
- After documentation-only changes.
- After changes to unit test files themselves.
- After changes isolated to pure-logic modules with full unit test coverage.

---

## E2E Chrome Harness Architecture

The harness (`tests/e2e-chrome/harness.js`) launches Puppeteer's bundled
"Chrome for Testing" with the extension loaded via `--load-extension`.

### Critical Design Decisions

- **CDP, not page.evaluate**: The service worker is communicated with via
  `Runtime.evaluate` on a CDP session, not `page.evaluate` (which targets page
  context).
- **Deterministic evaluation**: The extension exposes
  `self.__runEvaluationCycle` and `self.__evaluationCycleRunning` (getter) on
  `globalThis` so the harness triggers cycles directly — no alarm timing or
  sleep-based guessing.
- **Pinned keeper tab**: `resetTabs()` creates a pinned `about:blank` tab that
  the extension ignores (pinned tabs are skipped in `onCreated`). This prevents
  Chrome from exiting when gone tests close all tracked tabs.
- **State cleanup**: `resetTabs()` clears `tabMeta` and `windowState` between
  tests to prevent leakage.
- **Settings dedup**: `setFastThresholds` skips the storage write when settings
  are already identical, avoiding unwanted `storage.onChanged` →
  `runEvaluationCycle` triggers.
- **Guard polling**: Both `setFastThresholds` and `triggerEvaluation` poll
  `self.__evaluationCycleRunning` to wait for in-flight cycles before
  proceeding.
- **CDP session recovery**: `ensureCdp()` detects a dead CDP session (service
  worker restart) and reconnects automatically.

### Timing Patterns

- `openTab` sleeps 1 s for the `onCreated` handler to finish writing `tabMeta`.
- Tabs age during sequential `openTabs` calls (~1 s per tab). Tests that need
  fresh tabs must explicitly call `backdateTab(id, 0)`.
- Tests with many tabs (e.g. zone-order) use wide thresholds (15 s / 30 s) to
  avoid aging artefacts.
- `window.open()` from page context is required for `openerTabId`-dependent
  tests — `chrome.tabs.create` from the service worker does NOT propagate
  `openerTabId`.

### Bugs Discovered Exclusively by E2E Tests

1. `chrome.tabGroups.query()` returns groups in **creation order**, not visual
   order — caused `sortTabsAndGroups` to skip necessary moves. Fixed by sorting
   `allOrdered` by minimum tab index.
2. `openerTabId` is not set when tabs are created via `chrome.tabs.create` from
   the service worker.
3. Chrome exits when the last tab is closed during gone-tab tests — fixed by
   the pinned keeper tab.
4. `storage.onChanged` fires even when writing identical settings values —
   causes unwanted evaluation cycles that race with test assertions.

---

## Extension Architecture Rules

- **Manifest V3 only.** The canonical source of permissions is
  `src/manifest.json`; code and docs must match.
- **Least privilege.** Every permission must have a written rationale. No remote
  code execution.
- **Service-worker resilience.** All background work must survive MV3
  suspension/restart. State is persisted to `chrome.storage.local` with `v1_`
  prefixed keys.
- **Guard flags.** `evaluationCycleRunning` and `tabPlacementRunning` suppress
  reactive event handlers during in-flight operations. The evaluation cycle has
  a 60 s re-entrancy timeout.
- **State reconciliation.** Each evaluation cycle reconciles `tabMeta.groupId`
  against live `chrome.tabs.query({})` results to fix stale entries.
- **Navigation handling.** Both `onCommitted` and `onHistoryStateUpdated` (SPA)
  reset tab age. A per-tab debounce prevents double-processing. Discarded/
  suspended tab restores are skipped.
- **Gone handling.** Performed inside `sortTabsAndGroups` as a "gone" zone
  after red. The function receives bookmark callbacks via `goneConfig` to avoid
  circular dependencies.

---

## Code Style & Change Guidelines

- **Minimal edits.** Prefer single-line fixes over refactors. Address root
  causes, not symptoms.
- **No comment churn.** Do not add, remove, or rewrite comments unless the
  change is explicitly requested.
- **Imports at top.** Never add imports in the middle of a file.
- **Structured logging.** Use the logger from `src/shared/logger.js` with
  stable fields: timestamp, severity, context, correlation ID. Never log
  secrets or full URLs with sensitive query parameters.
- **Storage contracts.** Keys and schemas are versioned (`v1_*`). Any breaking
  change requires a migration path defined before rollout.

---

## Documentation

- Any feature that changes behaviour MUST update docs in the same changeset.
- Architecture decisions that change context boundaries or data ownership MUST
  be recorded in project docs or specs.
- Documentation drift is treated as a defect.

---

## CI / Workflow

- **PR gate**: unit + integration tests must pass (`npm run test:unit`,
  `npm run test:integration`). See `.github/workflows/test.yml`.
- **E2E Chrome**: run separately via `npm run test:e2e-chrome` (requires
  display server). Not part of the default CI gate but mandatory before
  releases and after core logic changes.
- **Release checklist**: manual smoke test on a clean Chrome profile +
  policy/compliance review.
- **Spec numbering**: Before choosing a new feature/spec number, inspect
  existing `specs/[0-9]+-*` directories first and use the next available
  numeric prefix.
