# Chrome Events Contract: Manage Tab Lifecycle

**Branch**: `001-manage-tab-lifecycle` | **Version**: v1

## Overview

This document defines which Chrome extension events the service worker listens to, what each handler does, and the expected inputs/outputs.

---

## Event: `chrome.runtime.onInstalled`

**Trigger**: Extension installed, updated, or Chrome updated.

**Handler responsibilities**:
1. Initialize `v1_schemaVersion` to `1` (if fresh install)
2. Initialize `v1_settings` with defaults (if not present)
3. Initialize `v1_activeTime` with `{ accumulatedMs: 0, focusStartTime: null, lastPersistedAt: Date.now() }`
4. Create alarm `tabcycle-eval` with period 0.5 minutes (30 seconds)
5. Scan all existing tabs and populate `v1_tabMeta` for any not yet tracked
6. Run schema migration if updating from older version

---

## Event: `chrome.runtime.onStartup`

**Trigger**: Chrome browser starts up (new profile session).

**Handler responsibilities**:
1. Recover `v1_activeTime` (apply recovery protocol from storage contract)
2. Ensure alarm `tabcycle-eval` exists (recreate if missing)
3. Reconcile `v1_tabMeta` with actual tabs (`chrome.tabs.query({})`):
   - Tabs in both storage and Chrome: retain persisted metadata (restored tabs keep their previous active time and status)
   - Tabs in Chrome but not in storage: add as fresh Green (created while service worker was down)
   - Tabs in storage but not in Chrome: remove stale entries
4. Reconcile `v1_windowState` with actual windows (`chrome.windows.getAll()`)
5. Validate special group IDs still reference existing groups

---

## Event: `chrome.alarms.onAlarm`

**Trigger**: Every 30 seconds (alarm name: `tabcycle-eval`).

**Handler responsibilities**:
1. Update active-time accumulator (if window focused, add delta since last persist)
2. Read current settings
3. For each non-pinned tab in `v1_tabMeta`:
   - Compute age based on time mode (active time or wall clock)
   - Determine new status based on thresholds
   - Apply ALL status transitions to `tabMeta.status` (including gone)
4. Build `goneConfig` with bookmark callbacks (`bookmarkTab`, `bookmarkGroupTabs`, `isBookmarkableUrl`, `bookmarkEnabled`, `bookmarkFolderId`). Resolve bookmark folder once if bookmarking is enabled and any tab has gone status.
5. For each window:
   - Dissolve unnamed single-tab groups
   - Call `sortTabsAndGroups(windowId, tabMeta, windowState, goneConfig)` which:
     - Moves ungrouped tabs to special groups (yellow/red) as needed
     - Bookmarks and closes ungrouped/special-group gone tabs individually
     - Computes group statuses via `computeGroupStatus` (freshest tab wins)
     - Bookmarks and closes gone groups as a unit (all tabs gone → group gone)
     - Sorts remaining groups into zone order with intra-zone ordering
     - Updates group colors
   - Update group titles with age (if enabled)
6. Persist all state changes to storage in a single batch write

---

## Event: `chrome.tabs.onCreated`

**Trigger**: A new tab is created in any window.

**Input**: `tab` object with `id`, `windowId`, `pinned`, `openerTabId`, `index`.

**Handler responsibilities**:
1. If `tab.pinned === true`: ignore (do not track)
2. Determine the active tab in the same window
3. Apply placement rules:
   - **Active tab in user-created group** (FR-008): Add new tab to that group, right of active tab
   - **Active tab in special "Yellow"/"Red" group** (FR-009): Move new tab to index 0 (left of all tabs/groups)
   - **Active tab ungrouped and not pinned** (FR-033): Create new group with empty name containing active tab + new tab
   - **Active tab pinned**: Default Chrome placement (no intervention)
4. Create `v1_tabMeta` entry with `refreshActiveTime = current accumulatedMs`, `status = "green"`
5. Persist to storage

---

## Event: `chrome.tabs.onRemoved`

**Trigger**: A tab is closed.

**Input**: `tabId`, `removeInfo` with `windowId`, `isWindowClosing`.

**Handler responsibilities**:
1. Remove tab entry from `v1_tabMeta`
2. If not `isWindowClosing`:
   - Check if the tab was the last tab in a special "Yellow" or "Red" group
   - If special group is now empty: remove the group, clear from `v1_windowState`
3. Persist to storage

---

## Event: `chrome.tabs.onUpdated`

**Trigger**: Tab properties change (pinned state, group assignment, etc.).

**Input**: `tabId`, `changeInfo`, `tab`.

**Handler responsibilities**:
1. If `changeInfo.pinned !== undefined`:
   - If newly pinned: remove from `v1_tabMeta` (exclude from tracking)
   - If newly unpinned: create entry in `v1_tabMeta` as fresh green tab
2. If `changeInfo.groupId !== undefined`:
   - Update `groupId` and `isSpecialGroup` in `v1_tabMeta`
3. If `changeInfo.discarded === false`:
   - Mark the tab as recently restored from discard so the immediate restore-triggered navigation event can be ignored
4. Persist to storage

---

## Event: `chrome.webNavigation.onCommitted`

**Trigger**: A navigation is committed (page starts loading).

**Input**: `details` with `tabId`, `frameId`, `transitionType`, `url`.

**Handler responsibilities**:
1. If `frameId !== 0`: ignore (only process main frame navigations)
2. Call shared `_handleNavigationEvent(tabId, 'onCommitted')` with per-tab debounce (200ms) to avoid double-processing with `onHistoryStateUpdated`
3. The shared handler:
   - Skips tabs marked as recently restored from discard (from `tabs.onUpdated` with `changeInfo.discarded === false`)
   - Skips discarded/unloaded tabs via live tab state checks (`tab.discarded`, `tab.status === 'unloaded'`)
   - Updates tab's `refreshActiveTime` to current `accumulatedMs`
   - Updates tab's `refreshWallTime` to `Date.now()`
   - Sets tab's `status` to `"green"`
   - If tab is in a special "Yellow" or "Red" group:
     - Removes tab from special group via `chrome.tabs.ungroup()`
     - Checks if special group is now empty → remove if so
   - Updates group color if tab is in a user group
   - Calls `sortTabsAndGroups()` to re-sort
4. Persist to storage

---

## Event: `chrome.webNavigation.onHistoryStateUpdated`

**Trigger**: A tab's URL changes via the History API (`pushState`/`replaceState`) — SPA navigations.

**Input**: `details` with `tabId`, `frameId`, `url`, `transitionType`.

**Handler responsibilities**:
1. If `frameId !== 0`: ignore (only process main frame navigations)
2. Call shared `_handleNavigationEvent(tabId, 'onHistoryStateUpdated')` with per-tab debounce (200ms)
3. Same shared handler logic as `onCommitted` (see above)
4. Persist to storage

**Note**: Both `onCommitted` and `onHistoryStateUpdated` may fire for the same navigation on some sites. The per-tab debounce (keyed by `tabId`, 200ms window) ensures only the first event is processed.

---

## Event: `chrome.windows.onFocusChanged`

**Trigger**: Any Chrome window gains or loses focus.

**Input**: `windowId` (integer, or `chrome.windows.WINDOW_ID_NONE`).

**Handler responsibilities**:
1. Read `v1_activeTime`
2. If `windowId === WINDOW_ID_NONE` (all windows lost focus):
   - If `focusStartTime !== null`: compute delta, add to `accumulatedMs`
   - Set `focusStartTime = null`
3. If `windowId > 0` (a window gained focus):
   - If `focusStartTime === null`: set `focusStartTime = Date.now()`
   - (If already set, focus just moved between windows — no action needed, time continues)
4. Update `lastPersistedAt = Date.now()`
5. Persist `v1_activeTime` to storage

---

## Event: `chrome.windows.onRemoved`

**Trigger**: A Chrome window is closed.

**Input**: `windowId`.

**Handler responsibilities**:
1. Remove window entry from `v1_windowState`
2. Remove all tab entries for that window from `v1_tabMeta`
3. Persist to storage

---

## Event: `chrome.tabGroups.onRemoved`

**Trigger**: A tab group is removed (last tab removed or user collapses/deletes).

**Input**: `group` object with `id`, `windowId`.

**Handler responsibilities**:
1. Check if the removed group was a special group in `v1_windowState`
2. If so: clear the special group reference (`yellow: null` or `red: null`)
3. Remove group from `groupZones`
4. Persist to storage

---

## Event: `chrome.tabGroups.onUpdated`

**Trigger**: A tab group's properties change (title, color, collapsed state).

**Input**: `group` object with `id`, `title`, `color`, `windowId`.

**Handler responsibilities**:
1. If this is a user-initiated title change on a non-special group: no action (preserve user names)
2. If this is a color change on a managed group that conflicts with status color:
   - Re-apply the correct status color on next evaluation cycle
3. Track changes for reconciliation

---

## Event: `chrome.storage.onChanged`

**Trigger**: Any storage key changes (used by service worker to detect settings updates from options page).

**Input**: `changes` object, `areaName`.

**Handler responsibilities**:
1. If `areaName !== "local"`: ignore
2. If `changes.v1_settings`:
   - Read new settings
   - Trigger immediate re-evaluation of all tabs (don't wait for next alarm)
   - Apply any status transitions that result from new thresholds

---

## Alarm Configuration

| Alarm Name | Period | Purpose |
|------------|--------|---------|
| `tabcycle-eval` | 0.5 minutes (30s) | Periodic tab status evaluation and state persistence |

**Note**: Alarm is created on install and verified on startup. Chrome's minimum alarm period is 0.5 minutes for unpacked extensions in development, 1 minute for published extensions. The 30-second spec requirement is met in development; published version will use 1-minute intervals as the Chrome minimum.
