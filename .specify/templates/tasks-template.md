---

description: "Task list template for feature implementation"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests are REQUIRED. Every user story MUST include unit, integration, and
end-to-end coverage for impacted behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single extension project**: `extension/src/`, `extension/manifest.json`, `tests/`
- **Monorepo extension**: `apps/extension/src/`, `apps/extension/manifest.json`,
  shared code in `packages/*`
- Paths shown below assume a single extension project - adjust based on plan.md
  structure

<!-- 
  ============================================================================
  IMPORTANT: The tasks below are SAMPLE TASKS for illustration purposes only.
  
  The /speckit.tasks command MUST replace these with actual tasks based on:
  - User stories from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements from plan.md
  - Entities from data-model.md
  - Endpoints from contracts/
  
  Tasks MUST be organized by user story so each story can be:
  - Implemented independently
  - Tested independently
  - Delivered as an MVP increment
  
  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and extension baseline

- [ ] T001 Create extension project structure per implementation plan
- [ ] T002 Initialize build pipeline and `manifest.json` validation
- [ ] T003 [P] Configure linting, formatting, and type checking

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

Examples of foundational tasks (adjust based on your project):

- [ ] T004 Define cross-context message contracts and schema validation
- [ ] T005 [P] Establish storage schema versioning and migration helpers
- [ ] T006 [P] Add permission/host-access review checks for `manifest.json`
- [ ] T007 Implement shared error-code catalog and structured logging module
- [ ] T008 Setup integration test harness for messaging and service-worker lifecycle
- [ ] T009 Setup end-to-end harness for loading/testing unpacked extension in Chromium

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 1 (REQUIRED) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US1] Unit tests for story logic in tests/unit/test_[name].ts
- [ ] T011 [P] [US1] Integration test for cross-context flow in tests/integration/test_[name].ts
- [ ] T012 [P] [US1] End-to-end test for user journey in tests/e2e/test_[name].spec.ts

### Implementation for User Story 1

- [ ] T013 [P] [US1] Implement feature module in extension/src/[context]/[feature].ts
- [ ] T014 [US1] Implement/extend message handlers in extension/src/background/[file].ts
- [ ] T015 [US1] Add validation, fallback behavior, and stable error codes
- [ ] T016 [US1] Add structured logging for story operations
- [ ] T017 [US1] Update story-specific documentation

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - [Title] (Priority: P2)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 2 (REQUIRED) ⚠️

- [ ] T018 [P] [US2] Unit tests for story logic in tests/unit/test_[name].ts
- [ ] T019 [P] [US2] Integration test for cross-context flow in tests/integration/test_[name].ts
- [ ] T020 [P] [US2] End-to-end test for user journey in tests/e2e/test_[name].spec.ts

### Implementation for User Story 2

- [ ] T021 [P] [US2] Implement feature module in extension/src/[context]/[feature].ts
- [ ] T022 [US2] Extend message/storage contracts as needed
- [ ] T023 [US2] Add structured logs and error handling for new paths
- [ ] T024 [US2] Update user/developer documentation for story changes

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - [Title] (Priority: P3)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 3 (REQUIRED) ⚠️

- [ ] T025 [P] [US3] Unit tests for story logic in tests/unit/test_[name].ts
- [ ] T026 [P] [US3] Integration test for cross-context flow in tests/integration/test_[name].ts
- [ ] T027 [P] [US3] End-to-end test for user journey in tests/e2e/test_[name].spec.ts

### Implementation for User Story 3

- [ ] T028 [P] [US3] Implement feature module in extension/src/[context]/[feature].ts
- [ ] T029 [US3] Extend permission handling and fallback behavior
- [ ] T030 [US3] Add logging/docs updates for story changes

**Checkpoint**: All user stories should now be independently functional

---

[Add more user story phases as needed, following the same pattern]

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] TXXX [P] Consolidate and finalize documentation updates in docs/
- [ ] TXXX Code cleanup and refactoring
- [ ] TXXX Performance optimization across all stories
- [ ] TXXX [P] Expand regression coverage in tests/unit/, tests/integration/, tests/e2e/
- [ ] TXXX Security hardening
- [ ] TXXX Run manual smoke test in clean Chrome profile
- [ ] TXXX Validate `manifest.json` permission and policy compliance checklist

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Message/storage contracts before cross-context handlers
- Cross-context handlers before UI wiring
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)
- All tests for a user story marked [P] can run in parallel
- Independent context modules within a story marked [P] can run in parallel
- Different user stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Unit tests for story logic in tests/unit/test_[name].ts"
Task: "Integration test for cross-context flow in tests/integration/test_[name].ts"
Task: "End-to-end test for user journey in tests/e2e/test_[name].spec.ts"

# Launch implementation tasks for different files together:
Task: "Implement feature module in extension/src/[context]/[feature].ts"
Task: "Implement/extend message handlers in extension/src/background/[file].ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1
   - Developer B: User Story 2
   - Developer C: User Story 3
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
