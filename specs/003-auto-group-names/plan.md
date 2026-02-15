# Implementation Plan: Auto-Name Unnamed Groups

**Branch**: `003-auto-group-names` | **Date**: 2026-02-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-auto-group-names/spec.md`

## Summary

Add automatic naming for unnamed tab groups with user-configurable enable/disable and age threshold (default on, 5 minutes). Implement a deterministic, local keyword-extraction pipeline that generates a 1-2 word base group name from tab titles and URLs, then composes the visible title with the existing age suffix feature without collisions. User edits always win: if the user is actively naming/editing, auto-naming is skipped or aborted.

## Technical Context

**Language/Version**: JavaScript (ES2022+), Manifest V3 service worker, no transpiler  
**Primary Dependencies**: Chrome Extension APIs (`chrome.tabs`, `chrome.tabGroups`, `chrome.storage`, `chrome.alarms`, `chrome.webNavigation`) and existing internal modules (`group-manager.js`, `service-worker.js`, `schemas.js`, options UI)  
**Storage**: `chrome.storage.local` — extend `v1_settings` with auto-naming fields; extend per-window runtime state with group naming metadata (session-scoped group IDs)  
**Testing**: Jest (`tests/unit`, `tests/integration`, `tests/e2e`) + Puppeteer/CDP real-browser suite (`tests/e2e-chrome`)  
**Target Platform**: Google Chrome desktop (Manifest V3 extension)  
**Project Type**: Single project (Chrome extension)  
**Performance Goals**: Auto-name candidate generation p95 <= 50 ms per group; evaluation-cycle overhead increase <= 250 ms for 20 groups/100 tabs  
**Constraints**: No network/remote NLP; deterministic offline behavior; generated labels max 2 words; preserve age suffix feature semantics; skip/abort on active user title edits  
**Scale/Scope**: Up to 50 groups per window and 500 tracked tabs across windows in a single profile session

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Mandatory Multi-Layer Testing — ✅ PASS

- Unit: naming extraction/scoring utilities, title parsing/composition, schema validation.
- Integration: service-worker evaluation behavior, storage updates, collision handling with age labels.
- E2E Chrome: real tab-group title updates, user-edit race handling, settings persistence and live behavior changes.
- Bug fixes will include failing regression tests before code fix.

### II. Structured Logging and Privacy-Safe Diagnostics — ✅ PASS

- Reuse `src/shared/logger.js` with stable structured fields.
- Log IDs, status flags, and decision reasons, but never log full tab URLs or sensitive query parameters.
- Add stable error/decision codes for naming skip/abort paths.

### III. Documentation Is a Release Artifact — ✅ PASS

- This plan adds `research.md`, `data-model.md`, `contracts/*`, and `quickstart.md`.
- Feature docs will cover new settings and title-composition semantics.

### IV. Least-Privilege Manifest and Permission Governance — ✅ PASS

- No new permissions required.
- Existing MV3 permissions remain sufficient; no host-permission changes.
- No remote code or dynamic runtime code loading.

### V. Context Isolation and Contract-Driven Messaging — ✅ PASS

- Settings remain in `v1_settings`, validated through `schemas.js`.
- Runtime behavior coordinated via storage and existing event handlers (`onUpdated`, alarm cycle).
- Feature degrades safely when input signal is weak (fallback name) or when user editing is active (skip/abort).

### Extension Impact Assessment

- **Contexts touched**: background service worker/group manager and options page.
- **Manifest/permission deltas**: none.
- **Logging changes**: add deterministic naming decision logs and skip/abort logs.
- **Documentation changes**: quickstart, data model, storage/title contracts.
- **Contract migrations**: additive settings fields + additive window-state metadata.

## Project Structure

### Documentation (this feature)

```text
specs/003-auto-group-names/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── storage-contracts.md
│   └── group-title-update-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── background/
│   ├── service-worker.js        # Modified: settings defaults/read, eval-cycle auto-naming orchestration
│   ├── group-manager.js         # Modified: base-title parsing/composition, auto-name apply, collision-safe updates
│   ├── tab-placer.js            # Existing source of extension-created unnamed groups (unchanged or minor hook)
│   └── state-persistence.js     # May extend reconcile logic for group naming runtime metadata
├── options/
│   ├── options.html             # Modified: auto-naming toggle + threshold controls
│   ├── options.js               # Modified: load/save/validate new settings
│   └── options.css              # Minor style additions for new controls
└── shared/
    ├── constants.js             # Modified: defaults and settings keys/constants
    └── schemas.js               # Modified: validation rules for new settings and runtime state shape

tests/
├── unit/
│   ├── group-manager.test.js    # Extended: parsing/composition, auto-name eligibility, collision safeguards
│   └── schemas.test.js          # Extended: new settings validation
├── integration/
│   ├── alarm-cycle.test.js      # Extended: naming flow in evaluation cycle
│   └── storage-persistence.test.js # Extended: new settings/runtime state persistence
└── e2e-chrome/
    ├── settings-persistence.test.js # Extended: options toggle/threshold behavior
    └── auto-group-naming.test.js    # NEW: real Chrome group naming + race/collision scenarios
```

**Structure Decision**: Extend the current single-project extension architecture. Keep naming logic near existing title/age handling in `group-manager.js` and orchestrate from `service-worker.js` during existing evaluation/sort/update flow to avoid duplicate title writes and race-prone parallel paths.

## Testing Strategy

### Unit Tests

- Auto-name candidate extraction from tab titles + URL hostname tokens.
- Ranking/selection behavior (prefer 2-word phrase when signal is stronger, fallback to 1-word).
- Base-title vs age-suffix parsing and recomposition idempotence.
- Eligibility checks: disabled feature, named groups, active user-edit lock, age-only titles.
- Schema validation for new settings fields.

### Integration Tests

- Settings load/save defaults and validation errors for invalid threshold values.
- Evaluation cycle applies naming only after delay and only when base name is empty.
- No overwrite when user edits group title during/around threshold crossing.
- Auto-name and age-suffix updates produce stable merged display titles.
- Runtime metadata cleanup when groups are removed.

### E2E Tests (Puppeteer + CDP)

**E2E test suites**:
- `tests/e2e-chrome/auto-group-naming.test.js`: delayed naming, 1-2 word output constraint, user-edit skip/abort, age-suffix coexistence.
- `tests/e2e-chrome/settings-persistence.test.js`: new options controls persist and affect runtime behavior.

**Harness requirements**:
- Use existing deterministic evaluation triggers (`self.__runEvaluationCycle`, guard polling).
- Preserve keeper-tab/state-cleanup patterns.
- Add helper actions for group title edits from page context to simulate active user editing timing.

**Run command**: `npm run test:e2e-chrome`  
**When to run**: Mandatory for this feature because it changes core group-title logic and event/evaluation timing behavior.

## Post-Phase 1 Constitution Re-check

All five constitution gates remain **PASS** after design.

- No permission expansion.
- Multi-layer testing coverage is planned (unit, integration, E2E Chrome).
- Contracts and docs are explicitly updated for storage and title update behavior.
- Logging remains structured and privacy-safe.

## Complexity Tracking

No constitution violations. No complexity waiver required.
