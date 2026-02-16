# Implementation Plan: Extended Configuration

**Branch**: `004-extended-config` | **Date**: 2026-02-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-extended-config/spec.md`

## Summary

Add granular configuration toggles for all core extension behaviors: aging (master toggle), tab sorting, tabgroup sorting, tabgroup coloring, individual transitions (green→yellow, yellow→red, red→gone), special group names, and auto-grouping. Restructure the options page into a two-section hierarchical layout (Aging, Auto-Tab-Groups) with collapsible detail sections and parent-child grey-out. The age clock runs independently of all toggles; re-enabling aging applies an age cap (redToGone + 1 min) to prevent mass tab closure. Disabling tab sorting dissolves special groups immediately. All changes covered by unit, integration, and E2E tests.

## Technical Context

**Language/Version**: JavaScript ES Modules (native, no transpilation)
**Primary Dependencies**: None (vanilla JS, Chrome Extension APIs)
**Storage**: `chrome.storage.local` (Manifest V3)
**Testing**: Jest 29.7 (unit/integration), Puppeteer 22 (E2E Chrome)
**Target Platform**: Chrome (Manifest V3 extension)
**Project Type**: Single project (Chrome extension)
**Performance Goals**: Settings page load < 500ms, grey-out response < 100ms, evaluation cycle unchanged (30s alarm)
**Constraints**: No new permissions, no external dependencies, service worker suspension resilient
**Scale/Scope**: ~15 new settings fields, 1 schema migration, 1 page restructure, ~10 new test files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Phase 0 Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Mandatory Multi-Layer Testing | PASS | Plan includes unit tests for each toggle, integration tests for combinations, E2E Chrome tests for lifecycle with various configs. E2E Puppeteer harness already exists. |
| I-a. E2E Testing with Puppeteer | PASS | New E2E test files planned: feature-toggles.test.js, extended settings-persistence. Core logic changes (sorting gates, status evaluator gates) require E2E verification. |
| II. Structured Logging | PASS | No new log fields needed. Existing logging covers evaluation cycles. Will add log lines when settings change triggers reactive behavior (dissolution, age cap). |
| III. Documentation as Release Artifact | PASS | Options page is self-documenting (hierarchical layout explains relationships). README/developer docs will be updated with new settings reference. |
| IV. Least-Privilege Manifest | PASS | No new permissions required. All new functionality uses existing `tabs`, `tabGroups`, `storage` permissions. No new host patterns. |
| V. Context Isolation & Contracts | PASS | Schema version bumps from 1 to 2 with defined migration. Storage contract documented in `contracts/storage-contract.md`. Settings validated via `schemas.js`. |

### Extension Impact Assessment

- **Contexts touched**: Background service worker, Options page
- **Manifest/permission deltas**: None
- **Logging changes**: Additional debug log lines for toggle-reactive behaviors
- **Documentation changes**: Options page restructure, developer docs updated
- **Contract migrations**: Settings schema v1 → v2 (additive, backward-compatible)

### Post-Phase 1 Re-check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Multi-Layer Testing | PASS | Confirmed: data-model.md defines testable state transitions for each toggle. Contracts define event behaviors for each settings change. |
| II. Structured Logging | PASS | Research R4/R5 confirm reactive behaviors will emit structured log entries with existing correlation ID pattern. |
| III. Documentation | PASS | quickstart.md documents all files to modify and key decisions. |
| IV. Least-Privilege | PASS | No new permissions in any design artifact. `chrome.tabGroups.onUpdated` listener uses existing `tabGroups` permission. |
| V. Context Isolation | PASS | Storage contract fully specified. Migration is additive-only. Validation rules extended in schemas.js. |

## Project Structure

### Documentation (this feature)

```text
specs/004-extended-config/
├── plan.md                          # This file
├── spec.md                          # Feature specification
├── research.md                      # Phase 0: research findings
├── data-model.md                    # Phase 1: data model
├── quickstart.md                    # Phase 1: implementation guide
├── contracts/
│   ├── storage-contract.md          # Settings v2 schema & migration
│   └── options-page-contract.md     # UI hierarchy & interaction rules
├── checklists/
│   └── requirements.md              # Spec quality checklist
└── tasks.md                         # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── background/
│   ├── bookmark-manager.js          # Unchanged
│   ├── group-manager.js             # MODIFY: sorting/coloring gates, dissolution, rename detection, group name from settings
│   ├── group-name-generator.js      # Unchanged
│   ├── service-worker.js            # MODIFY: migration, toggle gates, reactive behaviors, age cap
│   ├── state-persistence.js         # Unchanged
│   ├── status-evaluator.js          # MODIFY: transition gating
│   ├── tab-placer.js                # MODIFY: autogroup gating
│   ├── tab-tracker.js               # Unchanged
│   └── time-accumulator.js          # Unchanged (age clock is independent)
├── options/
│   ├── options.html                 # REWRITE: hierarchical two-section layout
│   ├── options.js                   # REWRITE: load/save new fields, grey-out tree, collapsible sections
│   └── options.css                  # REWRITE: hierarchy, grey-out, collapsible styles
├── shared/
│   ├── constants.js                 # MODIFY: add new default constants
│   ├── logger.js                    # Unchanged
│   └── schemas.js                   # MODIFY: validate new settings fields
└── manifest.json                    # Unchanged (no new permissions)

tests/
├── unit/
│   ├── schemas.test.js              # MODIFY: validate new fields
│   ├── status-evaluator.test.js     # MODIFY: transition gating tests
│   ├── group-manager.test.js        # MODIFY: sorting/coloring gate tests
│   ├── tab-placer.test.js           # MODIFY: autogroup gate test
│   └── group-sorting.test.js        # MODIFY: split sorting gate tests
├── integration/
│   ├── settings-migration.test.js   # NEW: v1→v2 migration
│   ├── toggle-combinations.test.js  # NEW: feature interaction tests
│   └── storage-persistence.test.js  # MODIFY: new fields persistence
├── e2e/
│   └── settings-change.test.js      # MODIFY: new options page UI tests
└── e2e-chrome/
    ├── feature-toggles.test.js      # NEW: toggle behaviors in real Chrome
    ├── settings-persistence.test.js  # MODIFY: new fields E2E
    └── age-cap-dissolution.test.js  # NEW: age cap + dissolution E2E
```

**Structure Decision**: Existing single-project Chrome extension structure preserved. No new directories needed. All changes are modifications to existing files or new test files within existing test directories.

## Complexity Tracking

No constitution violations. All changes stay within existing architecture patterns:
- Settings are a flat object in `chrome.storage.local` (no new storage keys)
- Toggle gates are simple boolean checks added to existing functions
- Options page is vanilla HTML/CSS/JS (no framework introduced)
- Tests follow existing Jest + Puppeteer patterns
