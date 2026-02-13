# Implementation Plan: Bookmark Closed Tabs

**Branch**: `002-bookmark-closed-tabs` | **Date**: 2026-02-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-bookmark-closed-tabs/spec.md`

## Summary

Add bookmark preservation for tabs and tab groups automatically closed by TabCycle when they reach the "Gone" state. When enabled (default: on), the extension creates bookmarks in a configurable folder ("Closed Tabs") under "Other Bookmarks". Tab groups are saved as subfolders. The bookmark folder is tracked by internal ID for resilience. Empty/blank tabs are skipped. Two new settings (toggle + folder name) are added to the options page. The feature requires the `bookmarks` permission added to the manifest.

## Technical Context

**Language/Version**: JavaScript (ES2022+), no transpiler (same as feature 001)
**Primary Dependencies**: Chrome Extension APIs — adds `chrome.bookmarks` to existing `chrome.tabs`, `chrome.tabGroups`, `chrome.storage`, `chrome.alarms`, `chrome.webNavigation`
**Storage**: `chrome.storage.local` — extends existing `v1_settings` with bookmark fields; adds new `v1_bookmarkState` key for folder ID tracking
**Testing**: Jest for unit tests, Puppeteer for integration/E2E (same as feature 001)
**Target Platform**: Google Chrome (Manifest V3), desktop only
**Project Type**: Single project (Chrome extension) — extends existing codebase
**Performance Goals**: Bookmark creation must not block or delay tab closure; batch 50+ bookmark operations without errors
**Constraints**: MV3 service worker suspension; `chrome.bookmarks` API is async; bookmark operations must be fire-and-forget relative to tab closure; folder ID must survive service worker restarts
**Scale/Scope**: 50+ tabs closed simultaneously, single bookmark folder with potentially hundreds of bookmarks over time

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Mandatory Multi-Layer Testing — ✅ PASS

- **Unit tests**: Bookmark manager module (URL filtering, folder name logic, group-to-subfolder mapping)
- **Integration tests**: Bookmark creation during evaluation cycle, settings persistence for bookmark toggle/folder name, folder rename on settings change
- **E2E tests**: Full flow — tab ages to Gone → bookmark appears in correct folder; group ages to Gone → subfolder with bookmarks created
- Bug fixes will require failing regression tests before the fix

### II. Structured Logging and Privacy-Safe Diagnostics — ✅ PASS

- Bookmark operations use the existing `logger.js` with `background` context
- Logs include tab IDs and bookmark folder IDs but never full URLs (only logged on error, and only the URL that failed — acceptable per constitution since it's the user's own local log)
- New error codes: `ERR_BOOKMARK_CREATE`, `ERR_BOOKMARK_FOLDER`, `ERR_BOOKMARK_RENAME`

### III. Documentation Is a Release Artifact — ✅ PASS

- `quickstart.md` updated with new bookmark settings and `bookmarks` permission
- `data-model.md` documents new `v1_bookmarkState` storage key and `v1_settings` extension
- Storage contract updated with new fields
- Chrome events contract updated with `chrome.bookmarks` usage

### IV. Least-Privilege Manifest and Permission Governance — ✅ PASS

- **New permission**: `bookmarks`
  - **Rationale**: Required to create bookmark folders and bookmarks when tabs are closed. This is the core functionality of the feature.
  - **Test coverage**: Unit tests verify bookmark creation calls; integration tests verify folder creation/reuse; E2E tests verify end-to-end flow
  - **No new host permissions** — bookmarks API doesn't require host access
- No remote code execution
- No content scripts

### V. Context Isolation and Contract-Driven Messaging — ✅ PASS

- Options page writes extended `v1_settings` (with `bookmarkEnabled`, `bookmarkFolderName`) → service worker reacts via `chrome.storage.onChanged`
- New `v1_bookmarkState` key stores folder ID; versioned and validated like all other storage keys
- Options page reads bookmark folder ID to perform rename operations via `chrome.bookmarks.update()`
- Service worker detects external folder renames by comparing stored folder name with actual folder name on access (FR-018)
- Graceful degradation: if bookmarks API fails, tab closure proceeds normally (FR-012)

### Extension Impact Assessment

- **Contexts touched**: Background service worker (bookmark creation on tab close), Options page (new settings UI)
- **Manifest/permission deltas**: `+bookmarks`
- **Logging changes**: New error codes for bookmark operations
- **Documentation changes**: Updated quickstart, data model, contracts
- **Contract migrations**: `v1_settings` extended with two new optional fields (backward-compatible); new `v1_bookmarkState` key added

## Project Structure

### Documentation (this feature)

```text
specs/002-bookmark-closed-tabs/
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
├── manifest.json                # +bookmarks permission
├── background/
│   ├── service-worker.js        # Modified: call bookmark-manager before tab/group close
│   ├── bookmark-manager.js      # NEW: bookmark creation, folder management, URL filtering
│   ├── tab-tracker.js           # Unchanged
│   ├── time-accumulator.js      # Unchanged
│   ├── status-evaluator.js      # Unchanged
│   ├── group-manager.js         # Unchanged
│   ├── tab-placer.js            # Unchanged
│   └── state-persistence.js     # Unchanged (reused for new storage keys)
├── options/
│   ├── options.html             # Modified: add bookmark settings section
│   ├── options.js               # Modified: load/save bookmark settings, folder rename logic
│   └── options.css              # Minor: styling for new section
└── shared/
    ├── constants.js             # Modified: new storage key, default values, error codes
    ├── logger.js                # Unchanged
    └── schemas.js               # Modified: validation for extended settings and new bookmarkState

tests/
├── unit/
│   ├── bookmark-manager.test.js # NEW: URL filtering, folder logic, bookmark creation
│   └── schemas.test.js          # Modified: new schema validation tests
├── integration/
│   ├── bookmark-lifecycle.test.js # NEW: bookmark creation during eval cycle
│   └── storage-persistence.test.js # Modified: new storage keys
└── e2e/
    └── bookmark-saving.test.js  # NEW: full bookmark saving flow
```

**Structure Decision**: Extends the existing single-project Chrome extension layout from feature 001. One new module (`bookmark-manager.js`) encapsulates all bookmark logic. Modifications to existing files are minimal — primarily the service worker (to call bookmark-manager before closing tabs/groups) and the options page (new settings section).

## Post-Phase 1 Constitution Re-check

All five gates **pass** after design phase. One permission change:
- **`bookmarks` added** (rationale: required to create bookmarks when tabs reach Gone status; documented in IV above).
- No other permission, contract, or architecture changes beyond what's documented.

## Complexity Tracking

> No constitution violations. No complexity justifications needed.
