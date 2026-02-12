# Implementation Plan: Manage Tab Lifecycle

**Branch**: `001-manage-tab-lifecycle` | **Date**: 2026-02-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-manage-tab-lifecycle/spec.md`

## Summary

Build a Google Chrome extension (Manifest V3) named **TabCycle** that tracks tab age using a global user-active-time accumulator, assigns status-based colors to tabs and groups (Green → Yellow → Red → Gone), automatically sorts groups into status zones, moves ungrouped aging tabs into special "Yellow"/"Red" groups, and closes expired tabs/groups. The extension uses a service worker for background logic, `chrome.storage.local` for persistence, and `chrome.alarms` for periodic 30-second evaluation cycles. An options page allows users to configure thresholds and choose between active-time and wall-clock modes.

## Technical Context

**Language/Version**: JavaScript (ES2022+), no transpiler needed (Chrome supports modern JS natively)
**Primary Dependencies**: Chrome Extension APIs (`chrome.tabs`, `chrome.tabGroups`, `chrome.storage`, `chrome.alarms`, `chrome.windows`, `chrome.webNavigation`). No third-party runtime dependencies.
**Storage**: `chrome.storage.local` for tab metadata, active-time accumulator, settings, and special group IDs
**Testing**: Jest for unit tests (pure logic modules), Puppeteer with chrome-extension support for integration/E2E tests
**Target Platform**: Google Chrome (Manifest V3), desktop only
**Project Type**: Single project (Chrome extension)
**Performance Goals**: Tab evaluation cycle completes in <100ms for 50+ tabs; no perceptible UI lag during group moves
**Constraints**: MV3 service worker can be suspended/restarted at any time; all state must be recoverable from `chrome.storage.local`; no remote code execution; minimum permissions
**Scale/Scope**: 50+ tabs per window, multiple windows, single user

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Mandatory Multi-Layer Testing — ✅ PASS

- **Unit tests**: Pure logic modules (status evaluation, time accumulation, group sorting algorithms) tested with Jest
- **Integration tests**: Storage read/write cycles, alarm-triggered evaluation, service worker restart recovery
- **E2E tests**: Full lifecycle flows (tab creation → aging → group move → closure) via Puppeteer with extension loaded
- Bug fixes will require failing regression tests before the fix

### II. Structured Logging and Privacy-Safe Diagnostics — ✅ PASS

- All modules use a shared `logger.js` with structured fields: `timestamp`, `severity`, `context` (background/options), `correlationId`
- Logs never include full URLs or user content; only tab IDs, group IDs, and status values
- Error codes defined for each failure path (e.g., `ERR_STORAGE_WRITE`, `ERR_GROUP_CREATE`, `ERR_TAB_MOVE`)

### III. Documentation Is a Release Artifact — ✅ PASS

- `quickstart.md` covers setup, loading the unpacked extension, and configuration
- Permission rationale documented in plan and manifest
- Storage schema and message contracts versioned and documented in `data-model.md` and `contracts/`

### IV. Least-Privilege Manifest and Permission Governance — ✅ PASS

- **Permissions requested** (all with rationale):
  - `tabs`: Required to read tab URLs (for navigation detection), move tabs, and query tab state
  - `tabGroups`: Required to create, update, move, and query tab groups
  - `storage`: Required to persist tab metadata, settings, and active-time state across service worker restarts and browser sessions
  - `alarms`: Required for the 30-second periodic evaluation cycle that survives service worker suspension
  - `webNavigation`: Required to detect all navigation types including same-URL reloads (which `chrome.tabs.onUpdated` cannot detect)
- **No host permissions** needed (extension only uses Chrome APIs, no content injection)
- **No remote code execution** — all logic is bundled
- **No content scripts** — no page injection needed

### V. Context Isolation and Contract-Driven Messaging — ✅ PASS

- Only two contexts: background service worker and options page
- Communication via `chrome.storage.onChanged` events (options page writes settings → service worker reacts)
- Storage keys versioned (e.g., `v1_tabMeta`, `v1_settings`, `v1_activeTime`)
- Schema validation on storage read/write via shared schema definitions
- Service worker resilient to restart: all state recovered from `chrome.storage.local` on activation

### Extension Impact Assessment

- **Contexts touched**: Background service worker, Options page
- **Manifest/permission deltas**: New extension — `tabs`, `tabGroups`, `storage`, `alarms`
- **Logging changes**: New structured logger with background/options contexts
- **Documentation changes**: Full new docs (quickstart, data model, contracts)
- **Contract migrations**: N/A (greenfield)

## Project Structure

### Documentation (this feature)

```text
specs/001-manage-tab-lifecycle/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── manifest.json                # Manifest V3 configuration
├── background/
│   ├── service-worker.js        # Entry point: alarm setup, event listeners, orchestration
│   ├── tab-tracker.js           # Tab refresh-time tracking (creation, navigation, reload detection)
│   ├── time-accumulator.js      # Global active-time counter (window focus tracking)
│   ├── status-evaluator.js      # Status calculation: age → Green/Yellow/Red/Gone
│   ├── group-manager.js         # Group creation, color updates, zone sorting, special group lifecycle
│   ├── tab-placer.js            # New tab placement logic (context-aware grouping)
│   └── state-persistence.js     # chrome.storage.local read/write, schema migration, recovery
├── options/
│   ├── options.html             # Settings page markup
│   ├── options.js               # Settings page logic (threshold config, mode toggle)
│   └── options.css              # Settings page styling
└── shared/
    ├── constants.js             # Status enums, default thresholds, storage keys, error codes
    ├── logger.js                # Structured logging utility
    └── schemas.js               # Storage/message schema definitions and validation

tests/
├── unit/
│   ├── status-evaluator.test.js
│   ├── time-accumulator.test.js
│   ├── group-manager.test.js
│   ├── tab-placer.test.js
│   └── tab-tracker.test.js
├── integration/
│   ├── storage-persistence.test.js
│   ├── alarm-cycle.test.js
│   └── service-worker-restart.test.js
└── e2e/
    ├── tab-lifecycle.test.js
    └── settings-change.test.js
```

**Structure Decision**: Single-project Chrome extension layout. `src/background/` contains all service worker modules split by responsibility. `src/options/` is the settings UI. `src/shared/` holds cross-context utilities. Tests mirror the source structure at three layers. No build step needed — Chrome natively supports ES modules in MV3 service workers.

## Post-Phase 1 Constitution Re-check

All five gates **pass** after design phase. One permission change from research:
- **`webNavigation` added** (rationale: required for same-URL reload detection; `chrome.tabs.onUpdated` cannot detect reloads). Written rationale documented in IV above.
- No other permission, contract, or architecture changes.

## Complexity Tracking

> No constitution violations. No complexity justifications needed.
