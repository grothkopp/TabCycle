# Tasks: Manage Tab Lifecycle

**Input**: Design documents from `/specs/001-manage-tab-lifecycle/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — constitution mandates multi-layer testing (unit, integration, E2E).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, manifest, shared utilities, and dev tooling

- [x] T001 Create project directory structure per plan.md: `src/background/`, `src/options/`, `src/shared/`, `tests/unit/`, `tests/integration/`, `tests/e2e/`
- [x] T002 Create `src/manifest.json` with Manifest V3 configuration: name "TabCycle", permissions `["tabs", "tabGroups", "storage", "alarms", "webNavigation"]`, background service worker entry point `background/service-worker.js`, options page `options/options.html`
- [x] T003 Create `package.json` at repository root with dev dependencies: Jest (unit tests), Puppeteer (E2E tests), jest-environment-jsdom; configure Jest for ES module support with `--experimental-vm-modules`
- [x] T004 [P] Create `src/shared/constants.js`: export `STATUS` enum (`GREEN`, `YELLOW`, `RED`, `GONE`), default thresholds (`GREEN_TO_YELLOW: 14400000`, `YELLOW_TO_RED: 28800000`, `RED_TO_GONE: 86400000`), storage keys (`V1_SCHEMA_VERSION`, `V1_SETTINGS`, `V1_ACTIVE_TIME`, `V1_TAB_META`, `V1_WINDOW_STATE`), alarm name `TABCYCLE_EVAL`, error codes (`ERR_STORAGE_WRITE`, `ERR_STORAGE_READ`, `ERR_GROUP_CREATE`, `ERR_TAB_MOVE`, `ERR_GROUP_MOVE`)
- [x] T005 [P] Create `src/shared/logger.js`: export structured logging utility with fields `timestamp`, `severity` (debug/info/warn/error), `context` (background/options), `correlationId`, `message`, `data`; never log full URLs or user content; log tab IDs, group IDs, status values, and error codes only
- [x] T006 [P] Create `src/shared/schemas.js`: export validation functions for each storage entity — `validateSettings(obj)`, `validateActiveTime(obj)`, `validateTabMeta(obj)`, `validateWindowState(obj)`; return `{ valid: boolean, errors: string[] }`; implement per constraints in data-model.md (e.g., thresholds must be positive, greenToYellow < yellowToRed < redToGone)

**Checkpoint**: Project skeleton ready — shared utilities available for all modules

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Create `src/background/state-persistence.js`: export `readState(keys)` and `writeState(data)` wrapping `chrome.storage.local.get/set` with structured error logging and error codes; export `batchWrite(changes)` that collects multiple key updates into a single `chrome.storage.local.set` call; include schema validation on read using `schemas.js` validators
- [x] T008 Create `src/background/time-accumulator.js`: export `initActiveTime()` (create default state), `recoverActiveTime()` (apply recovery protocol: if `focusStartTime !== null`, compute `delta = Date.now() - lastPersistedAt` and add to `accumulatedMs`), `handleFocusChange(windowId)` (start/stop accumulation based on `WINDOW_ID_NONE`), `getCurrentActiveTime()` (return current accumulated ms including in-progress focus session), `persistActiveTime()` (write to storage via state-persistence)
- [x] T009 Create `src/background/service-worker.js` skeleton: register all Chrome event listeners synchronously at top level (`chrome.runtime.onInstalled`, `chrome.runtime.onStartup`, `chrome.alarms.onAlarm`, `chrome.tabs.onCreated`, `chrome.tabs.onRemoved`, `chrome.tabs.onUpdated`, `chrome.webNavigation.onCommitted`, `chrome.windows.onFocusChanged`, `chrome.windows.onRemoved`, `chrome.tabGroups.onRemoved`, `chrome.tabGroups.onUpdated`, `chrome.storage.onChanged`); implement `onInstalled` handler (initialize all storage with defaults, create `tabcycle-eval` alarm at 0.5 min period, scan existing tabs); implement `onStartup` handler (recover active time, ensure alarm exists, reconcile tab/window state with Chrome); implement `onAlarm` handler skeleton (will be filled in US1)
- [x] T010 [P] Write unit test `tests/unit/time-accumulator.test.js`: test `initActiveTime` creates correct defaults; test `recoverActiveTime` adds delta when `focusStartTime` was set; test `handleFocusChange` starts/stops accumulation correctly; test `getCurrentActiveTime` returns accumulated + in-progress delta; mock `chrome.storage.local` and `Date.now()`
- [x] T011 [P] Write unit test `tests/unit/schemas.test.js`: test each validator in `schemas.js` with valid data, invalid data, missing fields, and edge cases (e.g., negative thresholds, wrong types, thresholds not in ascending order)

**Checkpoint**: Foundation ready — storage, time tracking, and service worker skeleton operational. User story implementation can now begin.

---

## Phase 3: User Story 1 — Tab Age Tracking and Status Display (Priority: P1) 🎯 MVP

**Goal**: Track tab age using global active time, assign status (Green → Yellow → Red → Gone), and transition tabs through statuses based on configurable thresholds. Pinned tabs excluded.

**Independent Test**: Open several tabs, let active time accumulate, verify tabs transition through Green → Yellow → Red → Gone. Change thresholds in settings and verify immediate re-evaluation. Verify pinned tabs are unaffected.

### Tests for User Story 1

- [x] T012 [P] [US1] Write unit test `tests/unit/status-evaluator.test.js`: test `computeStatus(tabRefreshActiveTime, currentActiveTime, thresholds)` returns correct status for each threshold boundary; test wall-clock mode computation; test pinned tabs return null (excluded); test edge case where tab age exactly equals threshold
- [x] T013 [P] [US1] Write unit test `tests/unit/tab-tracker.test.js`: test `createTabEntry(tab, currentActiveTime)` creates correct metadata; test `handleNavigation(tabId, currentActiveTime)` resets refresh times and sets status to green; test pinned tab filtering; mock `chrome.webNavigation.onCommitted`

### Implementation for User Story 1

- [x] T014 [P] [US1] Create `src/background/status-evaluator.js`: export `computeStatus(tabRefreshTime, currentTime, thresholds)` that returns `GREEN`/`YELLOW`/`RED`/`GONE` based on age vs thresholds; export `computeAge(tabMeta, activeTime, settings)` that computes age using either active-time mode (`activeTime.accumulatedMs - tabMeta.refreshActiveTime`) or wall-clock mode (`Date.now() - tabMeta.refreshWallTime`) based on `settings.timeMode`; export `evaluateAllTabs(tabMeta, activeTime, settings)` that returns a map of `{ tabId: { oldStatus, newStatus } }` for all tabs whose status changed
- [x] T015 [P] [US1] Create `src/background/tab-tracker.js`: export `createTabEntry(tab, activeTime)` that builds a `v1_tabMeta` entry with `refreshActiveTime = activeTime.accumulatedMs`, `refreshWallTime = Date.now()`, `status = "green"`; export `handleNavigation(tabId, tabMeta, activeTime)` that resets `refreshActiveTime` and `refreshWallTime` and sets `status = "green"`; export `reconcileTabs(storedMeta, chromeTabs, activeTime)` that performs 3-way reconciliation (retain existing, add missing as fresh green, remove stale)
- [x] T016 [US1] Wire `chrome.webNavigation.onCommitted` handler in `src/background/service-worker.js`: filter for `frameId === 0`; call `tab-tracker.handleNavigation()`; persist updated tab meta via `state-persistence.batchWrite()`; log navigation event with tab ID and correlation ID
- [x] T017 [US1] Wire `chrome.tabs.onCreated` handler in `src/background/service-worker.js`: skip pinned tabs; call `tab-tracker.createTabEntry()`; persist new entry via `state-persistence.batchWrite()`; log tab creation (tab placement logic deferred to US3)
- [x] T018 [US1] Wire `chrome.tabs.onRemoved` handler in `src/background/service-worker.js`: remove tab from `v1_tabMeta`; persist via `state-persistence.batchWrite()`; log tab removal
- [x] T019 [US1] Wire `chrome.tabs.onUpdated` handler in `src/background/service-worker.js`: handle `changeInfo.pinned` — if pinned, remove from tracking; if unpinned, create fresh green entry; persist changes
- [x] T020 [US1] Complete `chrome.alarms.onAlarm` handler in `src/background/service-worker.js`: update active time via `time-accumulator.persistActiveTime()`; read settings, tab meta; call `status-evaluator.evaluateAllTabs()`; for tabs transitioning to `GONE`, call `chrome.tabs.remove()`; update `v1_tabMeta` with new statuses; persist all changes in a single batch write; log evaluation cycle with count of transitions
- [x] T021 [US1] Create `src/options/options.html`: settings page with form fields for time mode (radio: active time / wall clock), three threshold inputs (Green→Yellow, Yellow→Red, Red→Gone) each with a numeric input and unit dropdown (minutes/hours/days); save button; styled with `options.css`
- [x] T022 [US1] Create `src/options/options.js`: on page load, read `v1_settings` from `chrome.storage.local` and populate form; on save, validate inputs (all positive, ascending order), convert to milliseconds, write to `chrome.storage.local`; show validation errors inline; import logger from shared
- [x] T023 [US1] Create `src/options/options.css`: clean, readable settings page styling; form layout with labels, inputs, and unit selectors; error state styling; save confirmation feedback
- [x] T024 [US1] Wire `chrome.storage.onChanged` handler in `src/background/service-worker.js`: when `v1_settings` changes, trigger immediate re-evaluation of all tabs (same logic as alarm handler); log settings change event
- [x] T025 [US1] Wire `chrome.windows.onFocusChanged` handler in `src/background/service-worker.js`: call `time-accumulator.handleFocusChange(windowId)`; persist active time state

**Checkpoint**: MVP complete — tabs track age, transition through statuses, get closed at Gone. Settings page functional. Pinned tabs excluded. Active time tracks globally.

---

## Phase 4: User Story 2 — Automatic Tab Sorting into Special Groups (Priority: P2)

**Goal**: Ungrouped tabs aging to Yellow are moved into a special "Yellow" group; tabs in "Yellow" aging to Red are moved to "Red" group; tabs in "Red" reaching Gone are closed. Special groups created/removed automatically.

**Independent Test**: Open ungrouped tabs, wait for Yellow threshold, verify they appear in the "Yellow" group. Wait for Red threshold, verify they move to "Red" group. Wait for Gone, verify they are closed. Verify special groups are removed when empty.

### Tests for User Story 2

- [x] T026 [P] [US2] Write unit test `tests/unit/group-manager.test.js`: test `ensureSpecialGroup(windowId, type, windowState)` creates group if missing and returns group ID; test `removeSpecialGroupIfEmpty(windowId, type, windowState)` removes group when empty; test `moveTabToSpecialGroup(tabId, groupType, windowState)` moves tab correctly; test `isSpecialGroup(groupId, windowState)` identifies special groups; mock `chrome.tabs.group`, `chrome.tabGroups.update`, `chrome.tabGroups.query`

### Implementation for User Story 2

- [x] T027 [US2] Create `src/background/group-manager.js`: export `ensureSpecialGroup(windowId, type, windowState)` — query existing groups, create if needed via `chrome.tabs.group()` + `chrome.tabGroups.update()` (set title "Yellow"/"Red", color yellow/red), store ID in `v1_windowState`, position per FR-013/FR-014; export `removeSpecialGroupIfEmpty(windowId, type, windowState)` — check if group has tabs, if empty ungroup and clear from state per FR-015; export `isSpecialGroup(groupId, windowState)` — check against stored IDs per FR-027; export `moveTabToSpecialGroup(tabId, groupType, windowId, windowState)` — ensure group exists then `chrome.tabs.group({ tabIds: [tabId], groupId })`
- [x] T028 [US2] Extend alarm handler in `src/background/service-worker.js`: after status evaluation, for each ungrouped tab transitioning GREEN→YELLOW, call `group-manager.moveTabToSpecialGroup(tabId, 'yellow', ...)`; for each tab in special "Yellow" group transitioning YELLOW→RED, call `group-manager.moveTabToSpecialGroup(tabId, 'red', ...)`; for each tab in special "Red" group transitioning RED→GONE, call `chrome.tabs.remove(tabId)`; after all moves, call `removeSpecialGroupIfEmpty` for both Yellow and Red groups in each window
- [x] T029 [US2] Handle `chrome.tabGroups.onRemoved` in `src/background/service-worker.js`: check if removed group was a special group via `group-manager.isSpecialGroup()`; if so, clear reference from `v1_windowState`; persist changes
- [x] T030 [US2] Extend `chrome.tabs.onRemoved` handler in `src/background/service-worker.js`: after removing tab meta, check if the tab was in a special group; if so, call `group-manager.removeSpecialGroupIfEmpty()` for that group; persist changes
- [x] T031 [US2] Extend `chrome.webNavigation.onCommitted` handler in `src/background/service-worker.js`: when a tab in a special "Yellow" or "Red" group is navigated (FR-024), reset its refresh time to green, remove it from the special group via `chrome.tabs.ungroup()`, then call `removeSpecialGroupIfEmpty()`; persist changes

**Checkpoint**: Ungrouped tabs automatically flow through Yellow → Red → Gone with special group lifecycle. Special groups created on demand, removed when empty.

---

## Phase 5: User Story 3 — New Tab Placement Based on Context (Priority: P2)

**Goal**: New tabs are placed intelligently: into the active tab's group if in a user group, to the far left if active tab is in a special group, or into a new unnamed group if active tab is ungrouped.

**Independent Test**: Activate a tab in a user group → open new tab → verify it joins the group to the right. Activate a tab in "Yellow"/"Red" → open new tab → verify it appears far left ungrouped. Activate an ungrouped tab → open new tab → verify both end up in a new unnamed group.

### Tests for User Story 3

- [x] T032 [P] [US3] Write unit test `tests/unit/tab-placer.test.js`: test `determineNewTabPlacement(activeTab, tabMeta, windowState)` returns correct placement for each scenario (user group, special group, ungrouped, pinned active tab); mock `chrome.tabs.get`, `chrome.tabs.query`

### Implementation for User Story 3

- [x] T033 [US3] Create `src/background/tab-placer.js`: export `placeNewTab(newTab, windowId, tabMeta, windowState)` — determine active tab in window via `chrome.tabs.query({ active: true, windowId })`; if active tab is in a user-created group (not special per `group-manager.isSpecialGroup()`): add new tab to that group via `chrome.tabs.group()` and move to right of active tab via `chrome.tabs.move()` (FR-008); if active tab is in a special "Yellow"/"Red" group: move new tab to index 0 (far left) and leave ungrouped (FR-009); if active tab is ungrouped and not pinned: create new group with empty name via `chrome.tabs.group({ tabIds: [activeTab.id, newTab.id] })` + `chrome.tabGroups.update({ title: '' })`, new tab to right of active (FR-033); if active tab is pinned: no intervention (default Chrome behavior)
- [x] T034 [US3] Update `chrome.tabs.onCreated` handler in `src/background/service-worker.js`: after creating tab meta entry (T017), call `tab-placer.placeNewTab()` to apply context-aware placement; persist updated tab meta and window state

**Checkpoint**: New tabs are placed contextually. Combined with US1 and US2, the core tab lifecycle is fully functional.

---

## Phase 6: User Story 4 — Tab Group Status Coloring and Sorting (Priority: P3)

**Goal**: User-created groups get color-coded by status (green/yellow/red) and are sorted into zones (Green left, Yellow middle, Red right). Groups moving between zones are repositioned. Gone groups are closed with all tabs.

**Independent Test**: Create several tab groups, let them age to different statuses, verify colors update and groups sort into correct zones. Verify Green groups retain user order. Verify a group turning Yellow moves to the Yellow zone.

### Tests for User Story 4

- [x] T035 [P] [US4] Write unit test `tests/unit/group-sorting.test.js`: test `computeGroupStatus(groupId, tabMeta)` returns status of freshest tab; test `computeTargetZonePositions(groups, windowState)` returns correct target indices respecting zone order and special group positions; test zone transition detection (only move groups whose zone changed); test special groups are excluded from sorting

### Implementation for User Story 4

- [x] T036 [US4] Extend `src/background/group-manager.js` with group status and sorting: export `computeGroupStatus(groupId, tabMeta)` — find freshest tab in group, return its status (FR-004); export `updateGroupColor(groupId, status)` — call `chrome.tabGroups.update(groupId, { color })` mapping GREEN→'green', YELLOW→'yellow', RED→'red' (FR-005); export `sortGroupsIntoZones(windowId, tabMeta, windowState)` — query all groups in window, compute each group's status, determine target zone positions (green left, yellow middle, red right per FR-016), move only groups whose zone changed since last evaluation (minimize moves per research.md decision #6), position newly-yellow groups to left of yellow zone (right of special "Yellow" if exists, FR-018), position newly-red groups to left of red zone (right of special "Red" if exists, FR-019), position refreshed-to-green groups to right of green zone (FR-020), preserve order within same zone (FR-017), update `groupZones` in `v1_windowState`
- [x] T037 [US4] Extend `src/background/group-manager.js` with Gone group handling: export `closeGoneGroups(windowId, tabMeta, windowState)` — for each user-created group (not special) that reaches GONE status (FR-022), close all tabs in group via `chrome.tabs.remove()`, which will automatically remove the empty group; special "Red" group is exempt
- [x] T038 [US4] Extend alarm handler in `src/background/service-worker.js`: after tab status transitions (T020) and special group moves (T028), call `group-manager.computeGroupStatus()` for each user-created group; call `group-manager.updateGroupColor()` for groups whose color changed; call `group-manager.closeGoneGroups()` for expired groups; call `group-manager.sortGroupsIntoZones()` for zone sorting; persist all changes

**Checkpoint**: Tab groups are color-coded and sorted into zones. Gone groups are closed. Combined with US1–US3, the full visual tab bar organization is functional.

---

## Phase 7: User Story 5 — User Retains Manual Control (Priority: P3)

**Goal**: Users can create, rename, and reorder groups freely. TabCycle only manages colors and zone-based positioning. User ordering within a status tier is preserved.

**Independent Test**: Manually create and rename a group → verify name persists after evaluation cycle. Manually reorder Green groups → verify order is preserved. Move a tab between groups manually → verify TabCycle doesn't undo it.

### Implementation for User Story 5

- [x] T039 [US5] Handle `chrome.tabGroups.onUpdated` in `src/background/service-worker.js`: when a non-special group's title is changed by the user, do not overwrite it (FR-023); when a group's color is changed by the user (conflicting with status color), schedule re-application of correct status color on next evaluation cycle; log the user action
- [x] T040 [US5] Review and validate zone sorting in `src/background/group-manager.js` `sortGroupsIntoZones()`: ensure groups within the same status tier preserve their relative order (FR-017); only move groups that are transitioning between zones; add explicit comments documenting the no-re-sort-within-tier guarantee
- [x] T041 [US5] Review `chrome.tabs.onUpdated` handler for `changeInfo.groupId` changes: when a user manually moves a tab to a different group, update `v1_tabMeta` entry with new `groupId` and `isSpecialGroup` flag; do not move the tab back; the tab retains its original refresh time (FR-023 acceptance scenario 3)

**Checkpoint**: User manual actions are respected. TabCycle only overrides colors and zone positions, never names or intra-tier order.

---

## Phase 8: User Story 6 — Per-Window Sorting with Global Time Tracking (Priority: P3)

**Goal**: Active time is global (any focused window counts). Sorting and group management are per-window. Tabs never move between windows due to status changes. Tab refresh times persist across window moves.

**Independent Test**: Open two windows, be active in Window A, verify tabs in Window B also age. Move a tab from Window A to Window B, verify it keeps its age. Verify each window's groups are sorted independently.

### Implementation for User Story 6

- [x] T042 [US6] Handle `chrome.windows.onRemoved` in `src/background/service-worker.js`: remove window entry from `v1_windowState`; remove all tab entries for that window from `v1_tabMeta`; persist changes; log window closure
- [x] T043 [US6] Handle tab detach/attach for cross-window moves: listen to `chrome.tabs.onDetached` and `chrome.tabs.onAttached` in `src/background/service-worker.js`; on attach, update `windowId` in `v1_tabMeta` for the moved tab (retain `refreshActiveTime` and `refreshWallTime` per FR-007); check if source window's special groups need cleanup; persist changes
- [x] T044 [US6] Review and validate all group-manager operations scope to a single window: ensure `sortGroupsIntoZones()`, `ensureSpecialGroup()`, `removeSpecialGroupIfEmpty()`, and `closeGoneGroups()` all filter by `windowId` and never move tabs or groups across windows; add explicit `windowId` parameter assertions

**Checkpoint**: Multi-window behavior correct. Global time, per-window sorting, cross-window tab moves all handled.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Integration testing, documentation, performance, and release readiness

- [x] T045 [P] Write integration test `tests/integration/storage-persistence.test.js`: test full read/write/recovery cycle; test schema validation rejects corrupt data; test batch write atomicity; use real `chrome.storage.local` mock
- [x] T046 [P] Write integration test `tests/integration/alarm-cycle.test.js`: test that alarm triggers full evaluation cycle; test that status transitions produce correct tab moves; test settings change triggers immediate re-evaluation
- [x] T047 [P] Write integration test `tests/integration/service-worker-restart.test.js`: test state recovery after simulated service worker shutdown; test that active time delta is correctly recovered; test that stale tab entries are cleaned up
- [x] T048 Write E2E test `tests/e2e/tab-lifecycle.test.js`: load extension in Chrome via Puppeteer; create tabs, simulate time passage, verify status transitions and group moves end-to-end; verify pinned tabs are unaffected; verify Gone tabs are closed
- [x] T049 Write E2E test `tests/e2e/settings-change.test.js`: load extension, change settings via options page, verify immediate re-evaluation of all tabs; verify threshold changes affect transition timing
- [x] T050 [P] Create `README.md` at repository root: project description, installation instructions (reference quickstart.md), feature overview, permissions explanation, development setup, testing commands, architecture overview referencing plan.md
- [x] T051 [P] Review `src/manifest.json` for least-privilege compliance: verify only `tabs`, `tabGroups`, `storage`, `alarms`, `webNavigation` are requested; verify no host permissions; verify no `content_scripts`; verify service worker entry point is correct
- [x] T052 Performance validation: manually test with 50+ tabs across 2+ windows; verify evaluation cycle completes in <100ms; verify no perceptible UI lag during group moves; profile and optimize if needed
- [x] T053 Run full test suite and fix any failures: `npm test`; ensure all unit, integration, and E2E tests pass; verify no console errors in service worker

**Checkpoint**: Extension is release-ready with full test coverage, documentation, and performance validation.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational (Phase 2)
- **US2 (Phase 4)**: Depends on US1 (needs status evaluation and tab tracking)
- **US3 (Phase 5)**: Depends on Foundational (Phase 2); can run in parallel with US2
- **US4 (Phase 6)**: Depends on US2 (needs group-manager.js with special group support)
- **US5 (Phase 7)**: Depends on US4 (needs zone sorting to validate preservation)
- **US6 (Phase 8)**: Depends on US2 (needs group management per window)
- **Polish (Phase 9)**: Depends on all user stories being complete

### User Story Dependencies

```
Phase 1: Setup
     │
Phase 2: Foundational
     │
     ├── Phase 3: US1 (Tab Age Tracking) 🎯 MVP
     │        │
     │        ├── Phase 4: US2 (Special Group Sorting)
     │        │        │
     │        │        ├── Phase 6: US4 (Group Coloring & Zone Sorting)
     │        │        │        │
     │        │        │        └── Phase 7: US5 (User Manual Control)
     │        │        │
     │        │        └── Phase 8: US6 (Per-Window + Global Time)
     │        │
     │        └── Phase 5: US3 (New Tab Placement) ← can start after Phase 2
     │
     └── Phase 9: Polish (after all stories)
```

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Core logic modules before service-worker wiring
- Service-worker wiring before UI (options page)
- Story complete before moving to next priority

### Parallel Opportunities

- **Phase 1**: T004, T005, T006 can run in parallel (different files)
- **Phase 2**: T010, T011 can run in parallel with each other (test files); T007, T008 can run in parallel (different modules)
- **Phase 3**: T012, T013 in parallel (test files); T014, T015 in parallel (different modules)
- **Phase 4 + Phase 5**: US2 and US3 can run in parallel after US1 (US3 only needs Foundational, but benefits from US1 for full testing)
- **Phase 9**: T045, T046, T047 in parallel; T050, T051 in parallel

---

## Parallel Example: User Story 1

```bash
# Launch tests first (parallel):
Task T012: "Write unit test for status-evaluator in tests/unit/status-evaluator.test.js"
Task T013: "Write unit test for tab-tracker in tests/unit/tab-tracker.test.js"

# Launch core modules (parallel, after tests written):
Task T014: "Create status-evaluator in src/background/status-evaluator.js"
Task T015: "Create tab-tracker in src/background/tab-tracker.js"

# Launch options page files (parallel, independent of above):
Task T021: "Create options.html in src/options/options.html"
Task T023: "Create options.css in src/options/options.css"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test US1 independently — tabs age, transition, get closed, settings work
5. Load unpacked extension and manually verify per quickstart.md

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Load & verify (MVP!)
3. Add User Story 2 → Ungrouped tabs auto-sort into special groups
4. Add User Story 3 → New tabs placed contextually
5. Add User Story 4 → Groups colored and zone-sorted
6. Add User Story 5 → User manual control preserved
7. Add User Story 6 → Multi-window support
8. Polish → Full test suite, docs, performance validation

### Key Risk: Service Worker Lifecycle

The biggest technical risk is service worker suspension losing in-flight state. Phase 2 (Foundational) addresses this by building state-persistence and time-accumulator first, with recovery protocols. Every subsequent phase builds on this resilient foundation.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Constitution requires tests, logging, documentation, and permission review for every change
- All storage keys use `v1_` prefix per versioning strategy in data-model.md
