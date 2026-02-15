# Tasks: Auto-Name Unnamed Groups

**Input**: Design documents from `/specs/003-auto-group-names/`  
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The spec and constitution require multi-layer verification, including real Chrome E2E coverage for timing/title-collision behavior.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable task (different files, no blocking dependency on incomplete task)
- **[Story]**: User story label (`[US1]`, `[US2]`, `[US3]`) for story-phase tasks only
- Every task includes explicit file path(s)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add feature-wide defaults and validation scaffolding shared by all user stories.

- [X] T001 Add `DEFAULT_AUTO_GROUP_NAMING` constants (`enabled=true`, `delayMinutes=5`) in `/Users/sg/dev/TabCycle/src/shared/constants.js`
- [X] T002 Extend `validateSettings` and `validateWindowState` for `autoGroupNamingEnabled`, `autoGroupNamingDelayMinutes`, and `groupNaming` metadata shape in `/Users/sg/dev/TabCycle/src/shared/schemas.js`
- [X] T003 [P] Add schema regression tests for new settings and `groupNaming` validation in `/Users/sg/dev/TabCycle/tests/unit/schemas.test.js`
- [X] T004 Wire default install-time values for new settings fields in `/Users/sg/dev/TabCycle/src/background/service-worker.js`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement reusable naming and title-composition primitives required before user-story behavior is added.

**⚠️ CRITICAL**: Complete this phase before any user story tasks.

- [X] T005 Create deterministic keyword extraction utilities (token normalization, stopwords, bigram candidates, hostname token extraction) in `/Users/sg/dev/TabCycle/src/background/group-name-generator.js`
- [X] T006 Implement candidate scoring and deterministic fallback (`Tabs`) with 1-2 word output guarantee in `/Users/sg/dev/TabCycle/src/background/group-name-generator.js`
- [X] T007 [P] Add unit tests for extraction, scoring, 1-2 word constraints, and fallback determinism in `/Users/sg/dev/TabCycle/tests/unit/group-name-generator.test.js`
- [X] T008 Implement base-title/suffix composition helpers and age-only-title detection for eligibility in `/Users/sg/dev/TabCycle/src/background/group-manager.js`
- [X] T009 [P] Add unit tests for parse/compose idempotence and age-only eligibility semantics in `/Users/sg/dev/TabCycle/tests/unit/group-manager.test.js`
- [X] T010 Add `groupNaming` metadata lifecycle setup/cleanup during reconciliation in `/Users/sg/dev/TabCycle/src/background/service-worker.js`
- [X] T011 [P] Add integration coverage for `groupNaming` persistence and stale-group cleanup in `/Users/sg/dev/TabCycle/tests/integration/storage-persistence.test.js`

**Checkpoint**: Shared naming primitives and runtime-state scaffolding are ready.

---

## Phase 3: User Story 1 - Auto-Name Unnamed Groups (Priority: P1) 🎯 MVP

**Goal**: Automatically assign a concise 1-2 word base name to eligible unnamed groups after configured delay.

**Independent Test**: Create unnamed group, cross threshold, verify a descriptive 1-2 word base name is applied; verify age-only display titles are still considered unnamed.

### Tests for User Story 1

- [X] T012 [P] [US1] Add integration tests for threshold-gated auto-naming and 1-2 word output in `/Users/sg/dev/TabCycle/tests/integration/alarm-cycle.test.js`
- [X] T013 [P] [US1] Add real Chrome E2E tests for delayed auto-naming and age-only-title eligibility in `/Users/sg/dev/TabCycle/tests/e2e-chrome/auto-group-naming.test.js`

### Implementation for User Story 1

- [X] T014 [US1] Read `autoGroupNamingEnabled` and `autoGroupNamingDelayMinutes` with default fallback in evaluation flow in `/Users/sg/dev/TabCycle/src/background/service-worker.js`
- [X] T015 [US1] Track unnamed duration (`firstUnnamedSeenAt`) and threshold eligibility gates in `/Users/sg/dev/TabCycle/src/background/group-manager.js`
- [X] T016 [US1] Integrate generator scoring pipeline and apply generated base name updates in `/Users/sg/dev/TabCycle/src/background/group-manager.js`
- [X] T017 [US1] Add structured naming decision logs (named/skipped/fallback reason) in `/Users/sg/dev/TabCycle/src/background/group-manager.js`

**Checkpoint**: US1 delivers core automatic naming behavior and is independently testable.

---

## Phase 4: User Story 2 - Respect User Control Over Names (Priority: P1)

**Goal**: Ensure user naming/editing always wins, and extension title updates never collide or overwrite each other.

**Independent Test**: Start naming near threshold and verify auto-naming skip/abort; verify non-empty base names are never overwritten and age suffix still updates safely.

### Tests for User Story 2

- [X] T018 [P] [US2] Add unit tests for user-edit lock, pre-write revalidation, and abort behavior in `/Users/sg/dev/TabCycle/tests/unit/group-manager.test.js`
- [X] T019 [P] [US2] Add integration tests for skip/abort when user edits near threshold in `/Users/sg/dev/TabCycle/tests/integration/alarm-cycle.test.js`
- [X] T020 [P] [US2] Extend E2E Chrome tests for threshold-during-edit and no-collision title composition in `/Users/sg/dev/TabCycle/tests/e2e-chrome/auto-group-naming.test.js`

### Implementation for User Story 2

- [X] T021 [US2] Track group title user edits and set `userEditLockUntil` metadata in `chrome.tabGroups.onUpdated` handler in `/Users/sg/dev/TabCycle/src/background/service-worker.js`
- [X] T022 [US2] Implement pre-write revalidation and abort path when active user edit is detected mid-attempt in `/Users/sg/dev/TabCycle/src/background/group-manager.js`
- [X] T023 [US2] Refactor to deterministic single compose/write pass to merge auto-name base title and age suffix safely in `/Users/sg/dev/TabCycle/src/background/group-manager.js` and `/Users/sg/dev/TabCycle/src/background/service-worker.js`
- [X] T024 [US2] Enforce immutable non-empty base-name rule while preserving age-suffix updates in `/Users/sg/dev/TabCycle/src/background/group-manager.js`

**Checkpoint**: US2 guarantees user-first behavior and non-colliding extension updates.

---

## Phase 5: User Story 3 - Configure Auto-Naming Behavior (Priority: P2)

**Goal**: Add options-page controls and persistence for enable/disable and delay minutes.

**Independent Test**: Verify defaults on first load, save new values, and confirm runtime behavior follows updated settings.

### Tests for User Story 3

- [X] T025 [P] [US3] Add integration tests for settings persistence/validation of toggle and delay fields in `/Users/sg/dev/TabCycle/tests/integration/storage-persistence.test.js`
- [X] T026 [P] [US3] Extend real Chrome settings tests for new controls and persisted values in `/Users/sg/dev/TabCycle/tests/e2e-chrome/settings-persistence.test.js`

### Implementation for User Story 3

- [X] T027 [P] [US3] Add auto-naming toggle and delay input controls in `/Users/sg/dev/TabCycle/src/options/options.html`
- [X] T028 [US3] Add styles for auto-naming settings controls and validation errors in `/Users/sg/dev/TabCycle/src/options/options.css`
- [X] T029 [US3] Implement load/save/validation logic for new controls in `/Users/sg/dev/TabCycle/src/options/options.js`
- [X] T030 [US3] Harden runtime fallback behavior for invalid/partial settings reads in `/Users/sg/dev/TabCycle/src/background/service-worker.js`

**Checkpoint**: US3 provides complete user-facing configuration for auto-naming.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finalize docs/contracts, broaden regression safety, and lock in validation flow.

- [X] T031 [P] Update storage and title-update contracts to match final implementation details in `/Users/sg/dev/TabCycle/specs/003-auto-group-names/contracts/storage-contracts.md` and `/Users/sg/dev/TabCycle/specs/003-auto-group-names/contracts/group-title-update-contract.md`
- [X] T032 [P] Add final quality-oriented generator edge-case tests (mixed-topic groups, sparse signals, tie-breaking) in `/Users/sg/dev/TabCycle/tests/unit/group-name-generator.test.js`
- [X] T033 [P] Update operator validation guidance and executed test matrix in `/Users/sg/dev/TabCycle/specs/003-auto-group-names/quickstart.md` and `/Users/sg/dev/TabCycle/README.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: starts immediately.
- **Phase 2 (Foundational)**: depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: depends on Phase 2; MVP delivery.
- **Phase 4 (US2)**: depends on Phase 2 and is safest after US1 because both modify title-update paths.
- **Phase 5 (US3)**: depends on Phase 2; can run alongside US1/US2 where files do not overlap.
- **Phase 6 (Polish)**: depends on completion of selected user stories.

### User Story Dependencies

- **US1 (P1)**: independent after foundational.
- **US2 (P1)**: independent in outcome, but implementation touches same modules as US1; execute after US1 to reduce merge risk.
- **US3 (P2)**: independent after foundational; runtime behavior validation benefits from US1 completion.

### Within Each User Story

- Write tests first and confirm they fail before implementation.
- Implement core behavior before cross-file integration refinements.
- Complete story-level validation before moving to lower priority work.

### Parallel Opportunities

- Setup: `T003` parallel with `T001`/`T002`.
- Foundational: `T007`, `T009`, `T011` can run in parallel with code tasks after corresponding interfaces exist.
- US1: `T012` and `T013` can run in parallel; implementation tasks `T014`-`T017` are mostly sequential.
- US2: `T018`, `T019`, `T020` can run in parallel while implementation is staged.
- US3: `T025`, `T026`, `T027` can run in parallel initially (different files).
- Polish: `T031`, `T032`, `T033` can run in parallel.

---

## Parallel Example: User Story 1

```bash
# Parallel test authoring for US1:
Task T012 in /Users/sg/dev/TabCycle/tests/integration/alarm-cycle.test.js
Task T013 in /Users/sg/dev/TabCycle/tests/e2e-chrome/auto-group-naming.test.js
```

## Parallel Example: User Story 2

```bash
# Parallel validation coverage for US2:
Task T018 in /Users/sg/dev/TabCycle/tests/unit/group-manager.test.js
Task T019 in /Users/sg/dev/TabCycle/tests/integration/alarm-cycle.test.js
Task T020 in /Users/sg/dev/TabCycle/tests/e2e-chrome/auto-group-naming.test.js
```

## Parallel Example: User Story 3

```bash
# Parallel settings work for US3:
Task T027 in /Users/sg/dev/TabCycle/src/options/options.html
Task T025 in /Users/sg/dev/TabCycle/tests/integration/storage-persistence.test.js
Task T026 in /Users/sg/dev/TabCycle/tests/e2e-chrome/settings-persistence.test.js
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Finish Phase 1 and Phase 2.
2. Deliver Phase 3 (US1).
3. Validate US1 independently via integration + E2E tests.
4. Demo/deploy MVP behavior.

### Incremental Delivery

1. **US1**: core auto-naming value.
2. **US2**: user-edit protection and collision safety.
3. **US3**: user configuration and persistence.
4. **Polish**: documentation and broader regression protection.

### Parallel Team Strategy

1. Team aligns on Phases 1-2 together.
2. Then split by story:
   - Engineer A: US1 core naming.
   - Engineer B: US2 race/collision safety.
   - Engineer C: US3 options/settings.
3. Rejoin for Phase 6 polish and full-suite validation.

---

## Notes

- `[P]` tasks must avoid same-file collisions with other in-progress `[P]` tasks.
- User story labels are included only in user-story phases for traceability.
- Real Chrome E2E coverage is mandatory for this feature because it changes title/timing behavior in live browser APIs.
