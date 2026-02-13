# Tasks: Bookmark Closed Tabs

**Input**: Design documents from `/specs/002-bookmark-closed-tabs/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included — the constitution mandates multi-layer testing for every change.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the `bookmarks` permission, new constants, storage key, schema validation, and the bookmark-manager module skeleton that all user stories depend on.

- [x] T001 Add `"bookmarks"` permission to src/manifest.json
- [x] T002 Add `BOOKMARK_STATE` storage key, default bookmark settings, and new error codes (`ERR_BOOKMARK_CREATE`, `ERR_BOOKMARK_FOLDER`, `ERR_BOOKMARK_RENAME`) to src/shared/constants.js
- [x] T003 Add `validateBookmarkState` function and extend `validateSettings` to accept optional `bookmarkEnabled` (boolean) and `bookmarkFolderName` (non-empty string) fields with backward-compatible defaults in src/shared/schemas.js
- [x] T004 [P] Add `validateBookmarkState` and extended `validateSettings` unit tests in tests/unit/schemas.test.js

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the core bookmark-manager module with folder lookup/creation, URL filtering, and bookmark creation — the shared engine all user stories rely on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T005 Create src/background/bookmark-manager.js with the following exported functions: `getOtherBookmarksId()` (discovers "Other Bookmarks" node via `chrome.bookmarks.getTree()`, caches result), `resolveBookmarkFolder(settings)` (implements the folder lookup algorithm from data-model.md: ID lookup → name fallback → create new; persists folder ID to `v1_bookmarkState`; detects external renames per FR-018 and updates `bookmarkFolderName` in `v1_settings`), `isBookmarkableUrl(url)` (returns false for empty string, `chrome://newtab`, `chrome://newtab/`, `about:blank`), `bookmarkTab(tab, parentId)` (creates a bookmark with tab title/URL; falls back to URL as title if title is empty; wraps in try/catch and logs `ERR_BOOKMARK_CREATE` on failure), `bookmarkGroupTabs(groupTitle, tabs, parentId)` (creates a subfolder named after the group or "(unnamed)" if empty, then calls `bookmarkTab` for each tab inside it). All functions use the existing `createLogger('background')` for structured logging.
- [x] T006 [P] Create tests/unit/bookmark-manager.test.js with unit tests: `isBookmarkableUrl` returns false for blocklisted URLs and true for valid URLs; `bookmarkTab` calls `chrome.bookmarks.create` with correct params; `bookmarkTab` uses URL as title when tab title is empty; `bookmarkTab` catches errors and logs warning without throwing; `bookmarkGroupTabs` creates subfolder then bookmarks each tab; `bookmarkGroupTabs` uses "(unnamed)" for empty group title; `resolveBookmarkFolder` returns cached folder by ID; `resolveBookmarkFolder` falls back to name search when ID is invalid; `resolveBookmarkFolder` creates new folder when none found; `resolveBookmarkFolder` detects external rename and updates settings

**Checkpoint**: Bookmark manager module ready — user story integration can now begin.

---

## Phase 3: User Story 1 — Save Individual Tabs as Bookmarks on Close (Priority: P1) 🎯 MVP

**Goal**: When an individual tab reaches "Gone" status and is closed by TabCycle, a bookmark is created in the "Closed Tabs" folder with the tab's title and URL. Empty/blank tabs are skipped.

**Independent Test**: Let an ungrouped tab age through Green → Yellow → Red → Gone and verify a bookmark appears in the "Closed Tabs" folder under "Other Bookmarks".

### Tests for User Story 1

- [x] T007 [P] [US1] Create tests/integration/bookmark-lifecycle.test.js with integration tests: when a tab reaches Gone with bookmarkEnabled=true, `bookmarkTab` is called before `chrome.tabs.remove`; when a tab reaches Gone with bookmarkEnabled=false, no bookmark is created; when a tab with `chrome://newtab` URL reaches Gone, no bookmark is created; when bookmark creation fails, tab is still removed; when bookmark folder does not exist, it is created on first tab close; when bookmark folder already exists (by stored ID), it is reused

### Implementation for User Story 1

- [x] T008 [US1] Modify the `runEvaluationCycle` function in src/background/service-worker.js to: (1) read `bookmarkEnabled` from settings (with default `true`), (2) if enabled and any tab has gone status, call `resolveBookmarkFolder(settings)` once, (3) build a `goneConfig` object with `bookmarkEnabled`, `bookmarkFolderId`, `bookmarkTab`, `bookmarkGroupTabs`, and `isBookmarkableUrl` callbacks, (4) pass `goneConfig` to `sortTabsAndGroups(windowId, tabMeta, windowState, goneConfig)` which handles bookmarking and closing gone tabs/groups internally. Import `resolveBookmarkFolder`, `isBookmarkableUrl`, `bookmarkTab`, `bookmarkGroupTabs` from `./bookmark-manager.js`. **Architecture note**: Gone handling (both individual tabs and groups) is centralized inside `sortTabsAndGroups` in `group-manager.js` to avoid the bug where individual tabs in groups were prematurely closed. Bookmark functions are passed as callbacks via `goneConfig` to avoid circular dependencies.
- [x] T009 [US1] Add structured logging in src/background/service-worker.js for bookmark operations: log info when bookmarks are created for gone tabs (count), log warn on bookmark failures with `ERR_BOOKMARK_CREATE` error code, log debug when tabs are skipped due to blocklisted URL

**Checkpoint**: Individual tab bookmark saving is fully functional and testable.

---

## Phase 4: User Story 2 — Save Tab Groups as Bookmark Subfolders on Close (Priority: P1)

**Goal**: When a user-created tab group reaches "Gone" status, a subfolder is created inside "Closed Tabs" named after the group, containing bookmarks for each tab. Tabs from the special "Red" group are saved as individual bookmarks (not in a subfolder).

**Independent Test**: Let a user-created tab group age to Gone and verify a subfolder appears in "Closed Tabs" named after the group, containing bookmarks for each tab.

### Tests for User Story 2

- [x] T010 [P] [US2] Add integration tests to tests/integration/bookmark-lifecycle.test.js: when a user-created group reaches Gone, a subfolder is created with the group name and bookmarks for each tab; when an unnamed group reaches Gone, subfolder is named "(unnamed)"; when a tab in the special "Red" group reaches Gone individually, it is saved as an individual bookmark (not in a subfolder); when multiple groups with the same name are closed, separate subfolders are created; when a group contains tabs with blocklisted URLs, those tabs are skipped but other tabs in the group are bookmarked

### Implementation for User Story 2

- [x] T011 [US2] Gone group bookmarking is now handled inside `sortTabsAndGroups` in src/background/group-manager.js (not in service-worker.js). When `computeGroupStatus` returns `'gone'` for a user-created group, `sortTabsAndGroups` calls `goneConfig.bookmarkGroupTabs(groupTitle, tabs, folderId)` to create a subfolder with bookmarks for each tab, then closes all tabs in the group via `chrome.tabs.remove()`. The `closeGoneGroups` function is no longer called from the service worker. Individual tabs in special groups that reach gone are bookmarked individually via `goneConfig.bookmarkTab`. All bookmark operations are wrapped in try/catch — failures never block tab closure (FR-012).
- [x] T012 [US2] Add structured logging for group bookmark operations in src/background/service-worker.js: log info when a group is bookmarked (group name, tab count), log warn on subfolder creation failure with `ERR_BOOKMARK_FOLDER` error code

**Checkpoint**: Both individual tab and group bookmark saving are functional.

---

## Phase 5: User Story 3 — Toggle Bookmark Saving On/Off (Priority: P2)

**Goal**: Users can enable/disable bookmark saving via a toggle in the settings page. Default is enabled.

**Independent Test**: Toggle the setting off, let a tab reach Gone, verify no bookmark is created. Toggle on, let another tab reach Gone, verify a bookmark is created.

### Tests for User Story 3

- [x] T013 [P] [US3] Add E2E test in tests/e2e/bookmark-saving.test.js: load extension, verify bookmark toggle defaults to enabled, disable the toggle, save settings, verify `v1_settings.bookmarkEnabled` is false in storage, re-enable and save, verify `v1_settings.bookmarkEnabled` is true

### Implementation for User Story 3

- [x] T014 [P] [US3] Add bookmark toggle HTML section to src/options/options.html: new `<section class="setting-group">` with heading "Bookmark Closed Tabs", a checkbox input with id `bookmarkEnabled` and label "Save closed tabs as bookmarks", and a description hint explaining the feature
- [x] T015 [US3] Modify `loadSettings` function in src/options/options.js to read `bookmarkEnabled` from settings (default `true`) and set the checkbox state accordingly
- [x] T016 [US3] Modify `saveSettings` function in src/options/options.js to read the checkbox value and include `bookmarkEnabled` in the settings object written to storage
- [x] T017 [P] [US3] Add styling for the bookmark settings section in src/options/options.css (consistent with existing setting-group styles)

**Checkpoint**: Bookmark toggle is functional in the settings page.

---

## Phase 6: User Story 4 — Configure Bookmark Folder Name (Priority: P3)

**Goal**: Users can customize the bookmark folder name in settings. Changing the name renames the existing folder. External renames (in Chrome's bookmark manager) are detected and synced back to settings.

**Independent Test**: Change the folder name in settings, let a tab reach Gone, verify the bookmark appears in a folder with the custom name. Rename the folder in Chrome's bookmark manager, open settings, verify the new name is reflected.

### Tests for User Story 4

- [x] T018 [P] [US4] Add E2E tests to tests/e2e/bookmark-saving.test.js: verify folder name input defaults to "Closed Tabs", change folder name to "My Archive", save settings, verify `v1_settings.bookmarkFolderName` is "My Archive" in storage, verify empty folder name is rejected with validation error

### Implementation for User Story 4

- [x] T019 [US4] Add folder name input HTML to the bookmark settings section in src/options/options.html: a text input with id `bookmarkFolderName`, label "Bookmark folder name", and a validation error span with id `bookmarkFolderName-error`
- [x] T020 [US4] Modify `loadSettings` function in src/options/options.js to read `bookmarkFolderName` from settings (default `"Closed Tabs"`) and populate the text input. Also read `v1_bookmarkState.folderId` and store it for use during save.
- [x] T021 [US4] Modify `saveSettings` function in src/options/options.js to: (1) validate that `bookmarkFolderName` is not empty (show error if so, per FR-009), (2) if the folder name changed and a stored `folderId` exists, call `chrome.bookmarks.update(folderId, { title: newName })` to rename the folder (wrapped in try/catch; log `ERR_BOOKMARK_RENAME` on failure), (3) include `bookmarkFolderName` in the settings object written to storage
- [x] T022 [US4] Add `bookmarkFolderName` validation error styling in src/options/options.css (reuse existing `.error` pattern)

**Checkpoint**: All four user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, edge case hardening, and final validation.

- [x] T023 [P] Add default bookmark settings (`bookmarkEnabled: true`, `bookmarkFolderName: "Closed Tabs"`) to the `onInstalled` handler's `defaultSettings` object in src/background/service-worker.js so fresh installs include bookmark fields
- [x] T024 [P] Register `v1_bookmarkState` in the `VALIDATORS` map in src/background/state-persistence.js so bookmark state is validated on read/write (import `validateBookmarkState` from schemas.js)
- [x] T025 [P] Add complete E2E test in tests/e2e/bookmark-saving.test.js: full lifecycle — load extension, open a tab, wait for it to age to Gone, verify bookmark created in "Closed Tabs" folder under "Other Bookmarks" with correct title and URL
- [x] T026 Run quickstart.md validation: load the extension from src/ in a clean Chrome profile, verify all permissions are granted, verify bookmark settings appear in options page, verify a tab closed by TabCycle creates a bookmark

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 — core MVP
- **User Story 2 (Phase 4)**: Depends on Phase 2 (and benefits from Phase 3 being done since it extends the same code path)
- **User Story 3 (Phase 5)**: Depends on Phase 2 — can run in parallel with US1/US2 (different files: options page vs service worker)
- **User Story 4 (Phase 6)**: Depends on Phase 5 (extends the same options page section)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2 — no dependencies on other stories
- **US2 (P1)**: Can start after Phase 2 — extends the same service worker code path as US1; best done after US1 but independently testable
- **US3 (P2)**: Can start after Phase 2 — modifies options page only; independent of US1/US2
- **US4 (P3)**: Depends on US3 (extends the same options page section with folder name input)

### Within Each User Story

- Tests written first (fail before implementation)
- Core implementation before integration
- Logging added alongside implementation
- Story complete before moving to next priority

### Parallel Opportunities

- T003 and T004 can run in parallel (different files)
- T005 and T006 can run in parallel (src vs tests)
- T007 and T008 can run in parallel (tests vs implementation — TDD)
- US3 (Phase 5) can run in parallel with US1/US2 (different files: options page vs service worker)
- T014, T017 can run in parallel with other US3 tasks (HTML/CSS vs JS)
- T023, T024, T025 can all run in parallel (different files)

---

## Parallel Example: User Story 1

```bash
# Launch tests and implementation in parallel (TDD):
Task T007: "Integration tests for bookmark lifecycle in tests/integration/bookmark-lifecycle.test.js"
Task T008: "Modify runEvaluationCycle in src/background/service-worker.js"

# These touch different files and can proceed simultaneously
```

## Parallel Example: User Story 3

```bash
# Launch all US3 tasks that touch different files:
Task T014: "Add bookmark toggle HTML in src/options/options.html"
Task T017: "Add bookmark settings styling in src/options/options.css"
Task T013: "E2E test in tests/e2e/bookmark-saving.test.js"

# Then sequential: T015, T016 (both modify options.js, depend on T014)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T004)
2. Complete Phase 2: Foundational (T005–T006)
3. Complete Phase 3: User Story 1 (T007–T009)
4. **STOP and VALIDATE**: Test by letting a tab age to Gone → verify bookmark in "Closed Tabs"
5. This delivers the core value: tabs closed by TabCycle are preserved as bookmarks

### Incremental Delivery

1. Setup + Foundational → Bookmark engine ready
2. Add US1 → Individual tabs bookmarked → **MVP!**
3. Add US2 → Tab groups bookmarked as subfolders
4. Add US3 → Toggle on/off in settings
5. Add US4 → Configurable folder name + rename support
6. Polish → Documentation, edge cases, E2E validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Tab info (URL, title) must be read via `chrome.tabs.get()` before removal — tabMeta does not store URLs
- All bookmark operations are wrapped in try/catch — failures never block tab closure (FR-012)
- Backward compatibility: settings without bookmark fields use defaults (true, "Closed Tabs")
