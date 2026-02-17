# Tasks: Extended Configuration

**Input**: Design documents from `/specs/004-extended-config/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included — US5 (P3) explicitly requires comprehensive unit, integration, and E2E test coverage. FR-022 mandates tests for all new config options.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Schema & Defaults)

**Purpose**: Extend the settings schema, defaults, and validation. All downstream work depends on these shared definitions being in place.

- [x] T001 [P] Add new default constants for all new toggle fields in `src/shared/constants.js` — add `DEFAULT_AGING_TOGGLES` (agingEnabled, tabSortingEnabled, tabgroupSortingEnabled, tabgroupColoringEnabled), `DEFAULT_TRANSITION_TOGGLES` (greenToYellowEnabled, yellowToRedEnabled, redToGoneEnabled), `DEFAULT_GROUP_NAMES` (yellowGroupName: '', redGroupName: ''), `DEFAULT_AUTO_GROUP` (autoGroupEnabled: true) per data-model.md field table
- [x] T002 [P] Extend `validateSettings()` in `src/shared/schemas.js` — add validation for all 10 new boolean fields (strict true/false), yellowGroupName/redGroupName (string, may be empty), and autoGroupEnabled (boolean) per data-model.md validation rules 1-5
- [x] T003 Add v2 default settings object in `src/background/service-worker.js` — update the `defaultSettings` construction (currently ~line 137) to include all new fields from the constants added in T001, ensuring fresh installs get schema v2 defaults
- [x] T004 Implement v1→v2 migration logic in `src/background/service-worker.js` — in the `onInstalled` handler, detect `v1_schemaVersion === 1` and merge new fields using nullish coalescing defaults per storage-contract.md migration steps, then set `v1_schemaVersion` to `2`

**Checkpoint**: Schema, defaults, validation, and migration are in place. All settings fields exist in storage for both fresh installs and upgrades.

---

## Phase 2: Foundational (Toggle Gates in Background Logic)

**Purpose**: Wire up all toggle gates in the evaluation pipeline so that each new boolean setting actually controls behavior. These gates are prerequisites for all user stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Gate `evaluateAllTabs()` on `agingEnabled` in `src/background/service-worker.js` — when `settings.agingEnabled` is false, skip the entire status evaluation loop (tabs freeze in current state). The alarm still fires but evaluation is skipped.
- [x] T006 [P] Gate each transition in `computeStatus()` in `src/background/status-evaluator.js` — when `greenToYellowEnabled` is false, cap status at green; when `yellowToRedEnabled` is false, cap at yellow; when `redToGoneEnabled` is false, cap at red. Accept settings object as parameter (or the three booleans).
- [x] T007 [P] Gate tab sorting on `tabSortingEnabled` in `src/background/group-manager.js` — when false, skip `moveTabToSpecialGroup()` / special group creation. Gate tabgroup zone-sorting on `tabgroupSortingEnabled`. Gate `updateGroupColor()` on `tabgroupColoringEnabled`. These are three independent boolean checks in existing functions.
- [x] T008 [P] Gate auto-grouping on `autoGroupEnabled` in `src/background/tab-placer.js` — when false, skip the entire `placeNewTab()` logic so new tabs open at Chrome's default position without grouping
- [x] T009 [P] Gate `showGroupAge` logic on `agingEnabled` in `src/background/service-worker.js` — when `agingEnabled` is false, skip the age-in-title suffix logic even if `showGroupAge` is true (there's no age to show)

**Checkpoint**: All toggle gates are wired. Disabling any boolean in storage changes runtime behavior on the next evaluation cycle.

---

## Phase 3: User Story 1 — Toggle Core Aging Features (Priority: P1) 🎯 MVP

**Goal**: Users can independently toggle aging (master), tab sorting, tabgroup sorting, tabgroup coloring, and age-in-title. Disabling tab sorting dissolves special groups immediately. Re-enabling aging applies the age cap. Age clock runs independently of all toggles.

**Independent Test**: Toggle each aging sub-feature off individually via `chrome.storage.local`, verify disabled behavior stops while others continue. Toggle back on, verify it resumes. Verify age clock continuity.

### Implementation for User Story 1

- [x] T010 [US1] Implement age cap logic in `src/background/service-worker.js` — in the `chrome.storage.onChanged` listener, detect `agingEnabled` changing from false→true and apply the age cap algorithm from storage-contract.md: compute `capTimestamp = now - (redToGone + 60000)`, then for each tab in tabMeta set `refreshActiveTime = max(refreshActiveTime, capTimestamp)` and `refreshWallTime = max(refreshWallTime, capTimestamp)`
- [x] T011 [US1] Implement special group dissolution in `src/background/group-manager.js` — add a `dissolveSpecialGroups(windowId)` function that calls `chrome.tabs.ungroup()` on all tabs in special groups for the given window and clears `windowState.specialGroups.yellow/red`. Export for use by service-worker.
- [x] T012 [US1] Wire dissolution reactive behavior in `src/background/service-worker.js` — in the `chrome.storage.onChanged` listener, detect `tabSortingEnabled` changing from true→false and call `dissolveSpecialGroups()` for all windows immediately (synchronous, not deferred to next cycle)
- [x] T013 [US1] Ensure age clock independence — verify in `src/background/time-accumulator.js` that `refreshActiveTime`/`refreshWallTime` timestamps continue accumulating regardless of any settings toggles. No code change expected (age clock is already independent per research.md R3), but confirm by inspection and add a code comment documenting the design decision.

**Checkpoint**: Core aging toggles work. Tab sorting dissolution/recreation works. Age cap prevents mass closure on re-enable. Age clock runs independently. This is the MVP.

---

## Phase 4: User Story 2 — Configure Individual Transitions (Priority: P1)

**Goal**: Users can disable any individual state transition (green→yellow, yellow→red, red→gone). Disabling an earlier transition greys out all downstream transitions. Bookmarking is nested under red→gone.

**Independent Test**: Disable each transition individually, verify tabs stop at the expected state. Verify cascading: disabling green→yellow prevents yellow→red and red→gone from ever firing.

### Implementation for User Story 2

- [x] T014 [US2] Verify transition gating in `src/background/status-evaluator.js` produces correct status caps — confirm that T006 implementation correctly returns capped status when transitions are disabled. E.g., if `greenToYellowEnabled` is false and a tab is 10 hours old, `computeStatus()` should return 'green' (not 'yellow'). This task verifies the logic end-to-end with the evaluation pipeline.
- [x] T015 [US2] Gate bookmarking on cascading transition state in `src/background/service-worker.js` — ensure that when `redToGoneEnabled` is false, the bookmark-and-close logic in the evaluation loop is never reached (tabs cap at red). Also verify that bookmarking respects `bookmarkEnabled` toggle (existing) nested under the red→gone transition.

**Checkpoint**: Individual transition toggles work correctly. Bookmarking is properly gated under red→gone.

---

## Phase 5: User Story 3 — Configure Special Group Names (Priority: P2)

**Goal**: Users can set custom names for the yellow and red special groups (default: empty). The extension picks up names the user manually assigns to special groups in Chrome.

**Independent Test**: Set custom group names in storage, verify special groups use those names. Rename a special group directly in Chrome, verify the name is persisted to settings.

### Implementation for User Story 3

- [x] T016 [US3] Modify `GROUP_CONFIG` usage in `src/background/group-manager.js` to read titles from settings — replace hardcoded `title: 'Yellow'` / `title: 'Red'` with `settings.yellowGroupName` / `settings.redGroupName` in `ensureSpecialGroup()` and any group creation/update paths. Color remains hardcoded per data-model.md.
- [x] T017 [US3] Add `chrome.tabGroups.onUpdated` rename detection listener in `src/background/group-manager.js` — when a special group's title changes and the change was NOT initiated by the extension (use a guard flag like the existing `markExtensionColorUpdate` pattern per research.md R1), persist the new name to settings via `chrome.storage.local.set()`.
- [x] T018 [US3] Wire reactive group name update in `src/background/service-worker.js` — in the `chrome.storage.onChanged` listener, detect `yellowGroupName` or `redGroupName` changes and immediately update existing special group titles via `chrome.tabGroups.update()` (per storage-contract.md reactive behaviors table).

**Checkpoint**: Special group names are configurable, default to empty, and sync bidirectionally (settings ↔ Chrome).

---

## Phase 6: User Story 4 — Hierarchical Settings Page with Collapsible Details (Priority: P2)

**Goal**: Restructure the options page into two sections (Aging, Auto-Tab-Groups) with hierarchical grey-out and collapsible detail sections. All new and existing settings are integrated.

**Independent Test**: Open settings page, verify two-section layout, toggle parent features off and confirm grey-out cascades, expand/collapse details, save and reload all settings.

### Implementation for User Story 4

- [x] T019 [US4] Rewrite `src/options/options.html` — restructure into two top-level sections per options-page-contract.md wireframe. Section 1 (Aging): master toggle, collapsible details (time mode, tab sorting, tabgroup sorting, tabgroup coloring, age in title), transitions (green→yellow, yellow→red, red→gone each with threshold, toggle, collapsible details for group name/bookmark). Section 2 (Auto-Tab-Groups): two independent toggles (create auto groups, auto-name groups with delay). Use `<details>/<summary>` elements for collapsible sections per research.md R2.
- [x] T020 [US4] Rewrite `src/options/options.js` — implement settings load (read `v1_settings`, populate all fields), settings save (collect all field values including disabled ones, validate thresholds, write to storage), grey-out dependency tree (define static hierarchy per data-model.md tree, recursive `effectiveEnabled()` per grey-out rule, apply `disabled` attribute + CSS class synchronously on toggle change per options-page-contract.md), and collapsible section initialization (all collapsed by default). Note: autoGroupEnabled and autoGroupNamingEnabled are independent siblings — no parent-child grey-out between them.
- [x] T021 [US4] Rewrite `src/options/options.css` — implement styles per options-page-contract.md CSS classes: `.section`, `.section-header`, `.hierarchy-child`, `.hierarchy-grandchild`, `.disabled-group` (opacity + pointer-events), `.detail-section` (details/summary styling), `.transition-block`. Ensure grey-out response < 100ms (per plan.md performance goals).

**Checkpoint**: Settings page is fully restructured, hierarchical grey-out works, collapsible details work, all settings save/load correctly.

---

## Phase 7: User Story 5 — Comprehensive Test Coverage (Priority: P3)

**Goal**: All new configuration options are covered by unit tests, integration tests, and E2E tests. Tests verify individual toggles, combinations, and edge cases.

**Independent Test**: `npm test` passes. All new and existing tests green. Coverage includes one test per toggle, one per transition, one per grey-out dependency, and three combination tests.

### Unit Tests

- [x] T022 [P] [US5] Extend `tests/unit/schemas.test.js` — add validation tests for all 10 new boolean fields (must be strict true/false), yellowGroupName/redGroupName (empty string valid, non-string invalid), autoGroupEnabled validation. Test that existing field validation is unchanged.
- [x] T023 [P] [US5] Extend `tests/unit/status-evaluator.test.js` — add transition gating tests: greenToYellowEnabled=false caps at green, yellowToRedEnabled=false caps at yellow, redToGoneEnabled=false caps at red. Test all combinations of disabled transitions. Test that enabling all transitions preserves current behavior.
- [x] T024 [P] [US5] Extend `tests/unit/group-manager.test.js` — add tests for: tabSortingEnabled=false skips special group creation, tabgroupSortingEnabled=false skips zone-sorting, tabgroupColoringEnabled=false skips color updates, dissolution function ungroups tabs and clears windowState, group titles read from settings (yellowGroupName/redGroupName), rename detection guard flag.
- [x] T025 [P] [US5] Extend `tests/unit/tab-placer.test.js` — add test for autoGroupEnabled=false skips placement logic, autoGroupEnabled=true preserves existing behavior.
- [x] T026 [P] [US5] Extend `tests/unit/group-sorting.test.js` — add split sorting gate tests: tab sorting off but tabgroup sorting on (groups still zone-sorted, no special groups), both off (no sorting at all), both on (existing behavior).

### Integration Tests

- [x] T027 [P] [US5] Create `tests/integration/settings-migration.test.js` — test v1→v2 migration: v1 settings gain all new fields with correct defaults, existing fields preserved, v1_schemaVersion updated to 2. Test fresh install gets v2 defaults. Test idempotency (running migration on v2 is a no-op).
- [x] T028 [P] [US5] Create `tests/integration/toggle-combinations.test.js` — test feature interactions: aging off with sorting configured (no evaluation), transitions partially disabled (correct status caps), tab sorting off but tabgroup sorting on (no special groups but zone-sorting works), age clock continuity when aging toggled off then on (timestamps unchanged), age cap applied correctly on re-enable (tabs capped at redToGone + 1 min), autoGroupEnabled off but autoGroupNamingEnabled on (naming still works independently).
- [x] T029 [P] [US5] Extend `tests/integration/storage-persistence.test.js` — add persistence tests for all new fields: save settings with various toggle combinations, reload, verify all values match. Test disabled fields are still persisted.

### E2E Tests

- [x] T030 [US5] Create `tests/e2e-chrome/feature-toggles.test.js` — E2E Puppeteer tests: load extension in Chrome, toggle aging off (verify no status transitions), toggle tab sorting off (verify special groups dissolved), toggle tabgroup coloring off (verify group colors unchanged), toggle autoGroupEnabled off (verify new tabs not grouped), toggle autoGroupNamingEnabled off separately (verify naming stops but grouping unaffected).
- [x] T031 [US5] Create `tests/e2e-chrome/age-cap-dissolution.test.js` — E2E Puppeteer tests: disable aging, wait, re-enable (verify age cap applied, no mass closure), disable tab sorting (verify dissolution happens immediately), re-enable tab sorting (verify tabs regrouped on next cycle).
- [x] T032 [US5] Extend `tests/e2e-chrome/settings-persistence.test.js` — add E2E tests for new fields: save all new settings via options page, restart extension, verify all values persisted. Test migration from v1 schema.
- [x] T033 [US5] Extend `tests/e2e/settings-change.test.js` — add options page UI tests: verify two-section layout, verify hierarchical grey-out (disable aging → all children greyed), verify collapsible details (collapsed by default, expand on click), verify independent auto-group/auto-naming toggles (disable one, other stays active), verify threshold validation on enabled transitions only.

**Checkpoint**: Full test coverage. `npm test` passes. All acceptance criteria from spec.md SC-001 through SC-011 are verified.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation, and cleanup across all user stories.

- [x] T034 [P] Verify no regressions — run `npm test && npm run lint` and confirm all existing tests still pass with zero failures
- [x] T035 [P] Add structured log lines for reactive behaviors in `src/background/service-worker.js` — log when age cap is applied (number of tabs capped), when special groups are dissolved (window IDs), when group names are updated reactively. Use existing logger.js patterns per plan.md constitution check.
- [x] T036 Run quickstart.md validation — walk through quickstart.md implementation order and verify all 18 listed files have been modified as specified. Confirm no files were missed.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion (constants, schemas, defaults, migration must exist)
- **User Story 1 (Phase 3)**: Depends on Phase 2 (toggle gates must be wired)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (transition gates from T006 must be wired). Can run in parallel with US1.
- **User Story 3 (Phase 5)**: Depends on Phase 2. Can run in parallel with US1/US2.
- **User Story 4 (Phase 6)**: Depends on Phase 1 (all settings fields must be defined). Can run in parallel with US1-US3 but benefits from them being complete (can test full behavior).
- **User Story 5 (Phase 7)**: Depends on all previous phases (tests exercise the implemented functionality)
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Depends on Phase 2. Core toggle and reactive behavior implementation.
- **US2 (P1)**: Depends on Phase 2 (specifically T006). Verifies transition gating. Can run in parallel with US1.
- **US3 (P2)**: Depends on Phase 2. Adds group name features. Can run in parallel with US1/US2.
- **US4 (P2)**: Depends on Phase 1. Options page rewrite. Can run in parallel with background work (US1-US3).
- **US5 (P3)**: Depends on US1-US4 completion. Test phase validates everything.

### Within Each User Story

- Background logic tasks before reactive behavior tasks
- Core implementation before integration with other systems
- UI restructure (US4) can proceed in parallel with background logic (US1-US3)

### Parallel Opportunities

- Phase 1: T001, T002 can run in parallel (different files)
- Phase 2: T006, T007, T008, T009 can run in parallel (different files)
- Phase 3-5: US1, US2, US3 can run in parallel after Phase 2 (different concerns)
- Phase 6: US4 (options page) can run in parallel with US1-US3 (different files entirely: options/ vs background/)
- Phase 7: All unit tests (T022-T026) can run in parallel (different test files). All integration tests (T027-T029) can run in parallel.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Launch all independent toggle gate tasks together:
Task T006: "Gate transitions in src/background/status-evaluator.js"
Task T007: "Gate sorting/coloring in src/background/group-manager.js"
Task T008: "Gate auto-grouping in src/background/tab-placer.js"
Task T009: "Gate showGroupAge on agingEnabled in src/background/service-worker.js"
```

## Parallel Example: US1 + US4 (Cross-Story)

```bash
# Background work and options page can proceed simultaneously:
# Developer A: US1 tasks (T010-T013) in src/background/
# Developer B: US4 tasks (T019-T021) in src/options/
```

## Parallel Example: Unit Tests (US5)

```bash
# Launch all unit test tasks together:
Task T022: "schemas.test.js"
Task T023: "status-evaluator.test.js"
Task T024: "group-manager.test.js"
Task T025: "tab-placer.test.js"
Task T026: "group-sorting.test.js"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup (T001-T004) — schema, defaults, validation, migration
2. Complete Phase 2: Foundational (T005-T009) — all toggle gates wired
3. Complete Phase 3: US1 (T010-T013) — core aging toggles, dissolution, age cap
4. Complete Phase 4: US2 (T014-T015) — transition gating verified end-to-end
5. **STOP and VALIDATE**: All P1 functionality works. Test via `chrome.storage.local` manipulation.

### Incremental Delivery

1. Phase 1+2 → Toggle gates wired, migration ready
2. Add US1+US2 → Core aging/transition toggles functional (MVP!)
3. Add US3 → Special group names configurable
4. Add US4 → Settings page restructured with hierarchy
5. Add US5 → Full test coverage validates everything
6. Phase 8 → Polish, logging, final validation

### Single-Developer Strategy

1. Complete Phases 1-2 sequentially (foundation)
2. Complete US1, then US2 (P1 stories, tightly related)
3. Complete US3 (group names, lightweight)
4. Complete US4 (options page rewrite, independent of background logic order)
5. Complete US5 (tests validate all previous work)
6. Phase 8 polish

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The age clock never stops — this is by design (research.md R3), not a bug
- autoGroupEnabled and autoGroupNamingEnabled are independent siblings — do NOT create parent-child relationship between them
- All reactive behaviors (dissolution, age cap, group name update) happen immediately on settings change, not on next evaluation cycle
