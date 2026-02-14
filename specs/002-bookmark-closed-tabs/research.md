# Research: Bookmark Closed Tabs

**Branch**: `002-bookmark-closed-tabs` | **Date**: 2026-02-13

## 1. chrome.bookmarks API for Folder and Bookmark Management

**Decision**: Use `chrome.bookmarks.create()` to create both folders (omit `url`) and bookmarks (include `url`). Use `chrome.bookmarks.getTree()` or `chrome.bookmarks.getChildren()` to find the "Other Bookmarks" node and locate existing folders. Use `chrome.bookmarks.update()` to rename folders. Use `chrome.bookmarks.get()` to verify a stored folder ID is still valid.

**Rationale**: The `chrome.bookmarks` API is the standard Chrome extension API for bookmark manipulation. It supports creating folders (a bookmark node without a URL), creating bookmarks within folders (by specifying `parentId`), and updating node titles. The API is fully async (Promise-based in MV3). The "Other Bookmarks" node has a stable ID (`"2"` on Chrome desktop) but this should be discovered dynamically via `chrome.bookmarks.getTree()` for robustness.

**Alternatives considered**:
- Hardcoding "Other Bookmarks" ID as `"2"` — rejected: while stable on Chrome desktop, discovering it via `getTree()` is safer and future-proof
- Using `chrome.bookmarks.search()` to find the folder by title — considered as a fallback but `search()` searches all bookmarks globally, not scoped to a parent; using `getChildren()` on the "Other Bookmarks" node and filtering by title is more precise

## 2. Bookmark Folder ID Tracking and Resilience

**Decision**: Store the bookmark folder's Chrome-internal ID in a new `v1_bookmarkState` storage key. On each bookmark operation, first attempt to look up the folder by stored ID via `chrome.bookmarks.get()`. If the ID is invalid (folder deleted), fall back to scanning "Other Bookmarks" children by name. If neither yields a result, create a new folder. After any folder creation or discovery, persist the ID to storage.

**Rationale**: Bookmark node IDs are strings (e.g., `"42"`) and are stable across browser restarts (unlike tab group IDs). However, the user can delete the folder at any time, so the extension must handle missing folders gracefully. The ID-first lookup is O(1) and avoids scanning. The name-based fallback handles the case where the user deletes and recreates a folder with the same name, or where the stored ID is lost.

**Alternatives considered**:
- Name-only lookup every time — rejected: slower (requires scanning children) and ambiguous if multiple folders share the name
- Caching folder ID in a module-level variable — rejected: lost on service worker suspension; must persist to storage

## 3. Bookmark Creation Timing Relative to Tab Closure

**Decision**: Create bookmarks *before* calling `chrome.tabs.remove()` or closing the group. The bookmark creation is awaited but wrapped in a try/catch so that failures do not prevent tab closure. This ensures the tab's URL and title are still available from the Chrome API at the time of bookmark creation.

**Rationale**: Once `chrome.tabs.remove()` is called, the tab object is no longer queryable. The bookmark needs the tab's `url` and `title`, which must be read before removal. By creating the bookmark first (or at least capturing the tab info first), we guarantee data availability. The try/catch ensures FR-012 compliance (closure proceeds regardless of bookmark failure).

**Alternatives considered**:
- Fire-and-forget bookmark creation after tab removal — rejected: tab URL/title may no longer be available after removal
- Capturing tab info into a queue and processing bookmarks asynchronously — considered but adds complexity; since `chrome.bookmarks.create()` is fast (<10ms typically), sequential await before removal is acceptable even for 50+ tabs
- Batch bookmark creation using a queue — rejected for initial implementation: sequential creation with independent error handling per FR-014 is simpler and sufficient for the expected scale

## 4. Empty/Blank Tab URL Filtering

**Decision**: Before creating a bookmark, check the tab's URL against a blocklist: empty string, `chrome://newtab`, `about:blank`. If the URL matches, skip bookmark creation and proceed directly to tab closure. The check is a simple string comparison in the bookmark manager module.

**Rationale**: These URLs represent empty or new-tab pages with no meaningful content to preserve. Bookmarking them would clutter the folder with useless entries. The blocklist is small and static, so a simple array check is sufficient.

**Alternatives considered**:
- Regex-based filtering for all `chrome://` URLs — rejected: the spec specifically lists only `chrome://newtab`, `about:blank`, and empty URL; other `chrome://` pages (e.g., `chrome://settings`) may have value to the user
- Making the blocklist configurable — rejected: over-engineering for the current scope; can be added later if needed

## 5. Settings Schema Extension Strategy

**Decision**: Extend the existing `v1_settings` object with two new optional fields: `bookmarkEnabled` (boolean, default `true`) and `bookmarkFolderName` (string, default `"Closed Tabs"`). The fields are optional for backward compatibility — if missing, defaults are used. No schema version bump needed since the extension is additive and non-breaking.

**Rationale**: Adding optional fields to an existing versioned key is a backward-compatible change. Existing installations that upgrade will have `v1_settings` without the bookmark fields; the code reads them with fallback defaults. This avoids a schema migration while keeping all user settings in one place.

**Alternatives considered**:
- Separate `v1_bookmarkSettings` key — rejected: fragments settings across multiple keys; the options page already reads/writes `v1_settings` as a unit
- Schema version bump to v2 — rejected: no breaking changes; additive fields with defaults don't require migration

## 6. Folder Rename on Settings Change (FR-010)

**Decision**: When the user changes the folder name in settings and saves, the options page reads the stored bookmark folder ID from `v1_bookmarkState`, calls `chrome.bookmarks.update(folderId, { title: newName })` to rename the folder, then saves the new settings. If the folder ID is invalid or the rename fails, the new name is saved to settings anyway (the service worker will create a new folder with the correct name on next use).

**Rationale**: Performing the rename in the options page context (rather than the service worker) provides immediate feedback to the user. The `chrome.bookmarks.update()` API atomically renames the folder while preserving all contents. If the folder doesn't exist, the rename is a no-op and the new name is simply stored for future use.

**Alternatives considered**:
- Renaming in the service worker via `chrome.storage.onChanged` — rejected: adds latency and complexity; the options page already has the bookmark folder ID and can perform the rename directly
- Deleting old folder and creating new one — rejected: would lose all existing bookmarks

## 7. External Folder Rename Detection (FR-018)

**Decision**: On each bookmark operation in the service worker, after looking up the folder by stored ID, compare the folder's current `title` with the stored `bookmarkFolderName` in settings. If they differ, update `bookmarkFolderName` in `v1_settings` to match the folder's actual name. This is a passive detection approach — no event listener needed.

**Rationale**: The `chrome.bookmarks.onChanged` event could detect renames in real-time, but it fires for *all* bookmark changes across the entire tree, requiring filtering logic. Since the service worker already accesses the folder on every bookmark operation (every 30s evaluation cycle at most), passive detection is simpler and sufficient. The settings update propagates to the options page via `chrome.storage.onChanged`.

**Alternatives considered**:
- `chrome.bookmarks.onChanged` listener — rejected: fires for all bookmark changes globally; filtering for our specific folder adds complexity with minimal benefit since passive detection on access is fast enough
- Periodic polling — rejected: unnecessary given the passive detection on each bookmark operation

## 8. Gone Zone Architecture — Bookmark Integration via Callbacks

**Decision**: Instead of performing bookmark creation in the service worker before calling `closeGoneGroups()`, bookmark functions are passed as callbacks via a `goneConfig` parameter to `sortTabsAndGroups` in `group-manager.js`. The service worker builds the `goneConfig` object with `bookmarkEnabled`, `bookmarkFolderId`, `bookmarkTab`, `bookmarkGroupTabs`, and `isBookmarkableUrl`, then passes it to `sortTabsAndGroups`. Inside `sortTabsAndGroups`, gone ungrouped/special-group tabs are bookmarked and closed individually, and gone user-created groups (where `computeGroupStatus` returns `'gone'`) are bookmarked as a group subfolder and all their tabs are closed.

**Rationale**: The previous architecture had gone handling scattered across the service worker — separate loops for identifying gone tabs, gone groups, bookmarking each, and closing each. This led to a critical bug where individual tabs inside a user-created group were closed when they individually reached gone status, even if the group's freshest tab was recently refreshed. By centralizing gone handling in `sortTabsAndGroups`, the function uses `computeGroupStatus` (which returns the freshest tab's status) to determine group-level gone status, ensuring tabs in groups are never prematurely closed. Bookmark functions are passed as callbacks rather than imported directly to avoid a circular dependency (`bookmark-manager.js` already imports `stripAgeSuffix` from `group-manager.js`).

**Alternatives considered**:
- Keep bookmark creation in service worker, fix the per-tab bug separately — rejected: still leaves scattered logic across multiple loops; the zone-based architecture in `sortTabsAndGroups` is a natural fit for gone handling
- Import bookmark functions directly into `group-manager.js` — rejected: creates circular dependency
- Create a mediator module that orchestrates both — rejected: over-engineering; the callback pattern is simple and sufficient

## 9. Group Bookmark Structure

**Decision**: When a user-created tab group reaches Gone and is closed, create a subfolder inside the bookmark folder named after the group (or "(unnamed)" if the group has no name). Then create a bookmark for each tab in the group inside that subfolder. Tabs individually closed from the special "Red" group are saved directly in the root bookmark folder (not in a subfolder).

**Rationale**: This mirrors the user's mental model — a group is a collection of related tabs, so it becomes a folder of related bookmarks. The "(unnamed)" fallback ensures every group gets a subfolder even without a name. Individual tabs from the special "Red" group were never part of a user-created group, so they belong at the root level.

**Alternatives considered**:
- Flat structure (all bookmarks at root, group name as prefix in title) — rejected: loses the hierarchical grouping context that makes groups valuable
- Timestamped subfolder names — rejected: the spec explicitly says to use the group name; timestamps could be added as a suffix if name collisions become a problem, but the spec allows duplicate subfolder names
