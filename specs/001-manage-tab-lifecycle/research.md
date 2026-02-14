# Research: Manage Tab Lifecycle

**Branch**: `001-manage-tab-lifecycle` | **Date**: 2026-02-12

## 1. Manifest V3 Service Worker Lifecycle

**Decision**: Use `chrome.alarms` for the 30-second evaluation cycle; persist all state to `chrome.storage.local`; register all event listeners synchronously at the top level of the service worker.

**Rationale**: MV3 service workers are terminated after 30 seconds of inactivity. Global variables are lost on shutdown. `chrome.alarms` fires events that wake the service worker, ensuring the evaluation cycle runs even after suspension. All state (tab metadata, active-time accumulator, special group IDs) must be recoverable from storage on each wake.

**Alternatives considered**:
- `setInterval` in service worker — rejected: timer is lost when service worker suspends; unreliable for periodic work
- Keep-alive via persistent connections — rejected: wastes resources and violates MV3 design intent
- `chrome.idle` API — considered for active-time detection but insufficient alone; `chrome.windows.onFocusChanged` is more precise for tracking when the user is actively using the browser

## 2. Active-Time Tracking Approach

**Decision**: Track global active time by listening to `chrome.windows.onFocusChanged`. When any window gains focus, record the timestamp. When focus is lost (all windows unfocused, `WINDOW_ID_NONE`), compute the delta and add it to the accumulator. Persist the accumulator and last-focus-start timestamp to storage on every alarm tick and on focus change.

**Rationale**: `chrome.windows.onFocusChanged` fires reliably when any Chrome window gains or loses focus. Combined with the alarm tick, this provides accurate user-active-time measurement. The accumulator is a single global number (milliseconds), making age calculation a simple subtraction: `tabAge = globalActiveTime - tabRefreshActiveTime`.

**Alternatives considered**:
- Per-tab focus tracking via `chrome.tabs.onActivated` — rejected: spec requires global active time, not per-tab
- `chrome.idle.onStateChanged` — rejected: only distinguishes active/idle/locked at configurable threshold (minimum 15s); too coarse and doesn't track window focus precisely
- Wall-clock with idle subtraction — rejected: complex and error-prone; the chosen approach is simpler

## 3. Tab Navigation and Reload Detection

**Decision**: Use `chrome.webNavigation.onCommitted` to detect navigations (including reloads). Filter for `frameId === 0` (main frame only). On each committed navigation, reset the tab's refresh time to the current global active-time value.

**Rationale**: `chrome.webNavigation.onCommitted` fires for all navigation types including reloads, link clicks, form submissions, and address bar navigations. It provides a `transitionType` field but we don't need to filter by type since all navigations reset refresh time per the spec. This requires the `webNavigation` permission.

**Alternatives considered**:
- `chrome.tabs.onUpdated` with `changeInfo.status === 'loading'` — considered but fires multiple times per navigation and doesn't reliably distinguish reloads from other updates; also fires for favicon changes and title updates
- `chrome.tabs.onUpdated` with `changeInfo.url` — rejected: does not fire on same-URL reloads (the URL doesn't change)

**Permission impact**: Adds `webNavigation` permission. Rationale: required to detect same-URL reloads which `chrome.tabs.onUpdated` with `changeInfo.url` cannot detect. This is the minimum-privilege approach for full navigation detection.

## 4. Tab Group Management via chrome.tabGroups

**Decision**: Use `chrome.tabs.group()` to create groups and add tabs, `chrome.tabGroups.update()` to set color and title, `chrome.tabGroups.move()` to reposition groups, and `chrome.tabGroups.query()` to enumerate groups per window.

**Rationale**: The `chrome.tabGroups` API (available since Chrome 89) provides full programmatic control over tab groups. Group IDs are ephemeral (change across sessions), so the extension must identify special groups by a combination of stored group ID + title ("Yellow"/"Red") and re-discover them on service worker restart.

**Alternatives considered**:
- Storing group IDs in storage alone — rejected: group IDs are not stable across browser restarts; must re-query by title/color on startup
- Using session storage for group IDs — considered but `chrome.storage.session` is cleared on browser restart; local storage + re-query is more resilient

## 5. Special Group Identification

**Decision**: Track special group IDs per window in `chrome.storage.local` (keyed by window ID). On service worker restart or group query, validate stored IDs against actual groups. If a stored ID is stale (group no longer exists), clear it. When creating a special group, store its ID immediately. To distinguish from user-created groups with the same name, always verify against the stored ID — never identify a special group by name alone.

**Rationale**: Chrome tab group IDs are integers assigned by the browser and are not guaranteed stable. Storing and validating per-window provides the fastest lookup while remaining resilient to edge cases (user manually removes a group, browser restart changes IDs).

**Alternatives considered**:
- Tagging groups via a hidden property — rejected: `chrome.tabGroups` API doesn't support custom metadata on groups
- Using a unique prefix in group names (e.g., "⚙Yellow") — rejected: visually intrusive and fragile if user renames

## 6. Group Zone Sorting Algorithm

**Decision**: On each evaluation cycle, query all groups in a window. Compute each group's status. Determine target positions: Green groups leftmost (preserve relative order), Yellow groups middle (special "Yellow" leftmost within zone), Red groups rightmost (special "Red" leftmost within zone). Only move groups whose zone has changed since last evaluation to minimize API calls and visual churn.

**Rationale**: Minimizing moves prevents flickering and respects user ordering within tiers. By tracking previous zone assignments, the extension only issues `chrome.tabGroups.move()` calls when a group transitions between zones, not on every cycle.

**Alternatives considered**:
- Full re-sort every cycle — rejected: causes unnecessary visual churn and may override user ordering within tiers
- Event-driven sorting (only on status change) — considered but the alarm-based approach is simpler and naturally batches multiple changes

## 7. Testing Strategy

**Decision**: Jest for unit tests (mock Chrome APIs), Puppeteer with `--load-extension` flag for integration and E2E tests.

**Rationale**: Jest supports ES modules and can mock `chrome.*` APIs via a test helper. Puppeteer can launch Chrome with an unpacked extension loaded, enabling real browser testing. This covers all three test layers required by the constitution.

**Alternatives considered**:
- Playwright — supports Chrome extensions but Puppeteer has more mature extension testing documentation
- Chrome Extension Testing Library (web-ext) — primarily for Firefox; not suitable for Chrome-specific APIs like `tabGroups`
- Vitest — viable alternative to Jest; chose Jest for broader ecosystem familiarity

## 8. SPA Navigation Detection (History API)

**Decision**: Listen to `chrome.webNavigation.onHistoryStateUpdated` in addition to `chrome.webNavigation.onCommitted` to detect SPA navigations that use the History API (`pushState`/`replaceState`). Both listeners call a shared `_handleNavigationEvent` function with per-tab debounce (200ms) to prevent double-processing when both events fire for the same navigation.

**Rationale**: Many modern websites (e.g., Reddit, YouTube, GitHub) use the History API for client-side navigation instead of full page loads. `onCommitted` does not fire for these navigations because no new page is loaded — only the URL changes via `history.pushState()` or `history.replaceState()`. Without `onHistoryStateUpdated`, tabs on SPA sites would never have their refresh time reset, causing them to age and eventually be closed even though the user is actively browsing.

**Alternatives considered**:
- Content script injecting `popstate`/`pushState` monkey-patches — rejected: requires content script injection and host permissions, violating least-privilege
- `chrome.tabs.onUpdated` with `changeInfo.url` — rejected: fires for URL changes but not reliably for all SPA navigations; also fires for many non-navigation events (title changes, favicon updates)
- Single listener without debounce — rejected: both `onCommitted` and `onHistoryStateUpdated` can fire for the same navigation on some sites, causing double-processing

## 9. Intra-Zone Ordering for Group Transitions

**Decision**: When a group transitions between zones (e.g., green→yellow), place it at the left of the new zone but to the right of the special group for that zone (if it exists). When a group is refreshed back to green, place it at the absolute leftmost position (left of all other green groups). Groups that have not transitioned retain their relative order within their zone.

**Rationale**: Placing newly transitioned groups at the left of their new zone provides a visual signal that a group just moved. Placing refreshed green groups at the absolute left emphasizes that the user just interacted with that group. This ordering is intuitive: the most recently active content is leftmost, aging content drifts right.

**Implementation**: `sortTabsAndGroups` tracks previous zone assignments in `windowState.groupZones`. On each sort pass, it compares current zone to previous zone to detect transitions. Transition detection uses a `justArrived` set. The stable sort preserves relative order for non-transitioning groups, while `justArrived` groups are inserted at the zone boundary.

**Alternatives considered**:
- Timestamp-based ordering within zones — rejected: adds complexity and doesn't align with the zone-boundary insertion model
- Always re-sort all groups — rejected: violates FR-017 (preserve user order within same tier)

## 10. Gone Zone Architecture (Centralized in sortTabsAndGroups)

**Decision**: Handle gone tabs and groups inside `sortTabsAndGroups` as a "gone" zone after red, rather than in scattered code in the service worker. The function accepts an optional `goneConfig` parameter with bookmark callbacks (`bookmarkTab`, `bookmarkGroupTabs`, `isBookmarkableUrl`, `bookmarkEnabled`, `bookmarkFolderId`). Ungrouped/special-group gone tabs are bookmarked and closed individually. Gone user-created groups (where `computeGroupStatus` returns `'gone'`) are bookmarked as a group and all their tabs are closed.

**Rationale**: The previous architecture had gone handling scattered across the service worker's evaluation cycle — separate loops for identifying gone tabs, identifying gone groups, bookmarking groups, bookmarking individual tabs, removing tabs, and closing groups. This led to a critical bug: individual tabs inside a user-created group were closed when they individually reached gone status, even if the group's freshest tab was recently refreshed. By centralizing gone handling in `sortTabsAndGroups`, the function can use `computeGroupStatus` (which returns the freshest tab's status) to determine group-level gone status, ensuring tabs in groups are never prematurely closed.

**Bug fixed**: A tab in a red group was closed and saved even though another tab in the same group was recently refreshed (green). The root cause was that gone status was evaluated per-tab, not per-group. Now, `computeGroupStatus` determines the group's fate: if even one tab is green/yellow/red, the group status is that (freshest wins), and no tabs are closed.

**Circular dependency avoidance**: `bookmark-manager.js` imports `stripAgeSuffix` from `group-manager.js`. To avoid a circular import, bookmark functions are passed as callbacks via `goneConfig` rather than imported directly into `group-manager.js`.

**Alternatives considered**:
- Keep gone handling in service worker but fix the per-tab bug — rejected: still leaves scattered logic and doesn't align with the zone-based architecture
- Import bookmark functions directly into group-manager.js — rejected: creates circular dependency with bookmark-manager.js
- Create a separate gone-handler module — rejected: over-engineering; the logic naturally fits in `sortTabsAndGroups` since it's zone-based

## 11. Group Age Display in Tab Group Titles

**Decision**: Optionally display the age of a tab group's freshest tab in the group title, appended in parentheses — e.g., "News (23m)", "Research (3h)", "Old Stuff (3d)". Controlled by a `showGroupAge` setting (default: off). The age suffix is stripped when bookmarking groups. The age is computed using `computeGroupAge` which finds the freshest (youngest) non-pinned, non-special tab in the group.

**Rationale**: Displaying group age provides an at-a-glance indicator of how stale a group is, complementing the color-based status system. Using the freshest tab's age (minimum, not maximum) aligns with `computeGroupStatus` which also uses the freshest tab to determine group status. The age suffix uses a compact format: minutes (`m`) for <60min, hours (`h`) for <24h, days (`d`) otherwise. The regex `\s?(\d+[mhd])$` is used to strip the suffix, handling both `"Name (23m)"` and `"(23m)"` (unnamed groups).

**Alternatives considered**:
- Always show age (no toggle) — rejected: some users may find it noisy; opt-in is more respectful
- Use oldest tab's age (maximum) — rejected: doesn't align with group status determination which uses freshest tab
- Include age in group color tooltip instead of title — rejected: Chrome extension API doesn't support custom tooltips on tab groups

## 12. Guard Flags for Event Handler Race Conditions

**Decision**: Use module-level boolean flags (`evaluationCycleRunning`, `tabPlacementRunning`) to suppress reactive event handlers (`chrome.tabs.onUpdated` groupId, `chrome.tabs.onRemoved`, `chrome.tabs.onMoved`) during operations that own in-memory state. The evaluation cycle guard includes a 60-second timeout that auto-resets the flag to prevent permanent lockout from unhandled errors.

**Rationale**: The evaluation cycle reads state from storage, modifies it in memory, then writes it back at the end. During the cycle, Chrome API calls (e.g., `chrome.tabGroups.move()`, `chrome.tabGroups.update()`, `chrome.tabs.remove()`) fire reactive event handlers that read stale state from storage and write it back, overwriting the cycle's in-memory changes. This caused tabs to be reset to green and ages to be lost. Similarly, `placeNewTab` calls `chrome.tabs.group()` which fires `onUpdated` with `groupId`, racing with the `batchWrite` that follows.

**Alternatives considered**:
- Queue events during the cycle and replay after — rejected: complex and error-prone; suppression is simpler since the cycle already handles all state changes
- Use a lock/mutex pattern — rejected: JavaScript is single-threaded; simple boolean flags with `try/finally` are sufficient
- Move all Chrome API calls to after `batchWrite` — rejected: many operations (e.g., moving tabs to special groups) must happen during the cycle to update in-memory state correctly

## 13. Extension Update Handling (reconcileState vs scanExistingTabs)

**Decision**: On extension update (`onInstalled` with `reason: 'update'`), use `reconcileState` (which preserves existing tab metadata) instead of `scanExistingTabs` (which resets all tabs to green with current timestamps). `scanExistingTabs` is only used on fresh install. An immediate evaluation cycle is triggered after both install and startup.

**Rationale**: During development, the extension is frequently reloaded. `scanExistingTabs` was resetting all tab ages on every reload, making it impossible to test aging behavior. `reconcileState` performs a 3-way merge: tabs present in both Chrome and storage retain their persisted metadata, tabs in Chrome but not storage are added as fresh green, and stale entries are removed. This preserves accumulated ages across reloads.

**Alternatives considered**:
- Always use `scanExistingTabs` — rejected: destroys accumulated state on every reload; unacceptable for development and for users who update the extension
- Skip tab scanning on update entirely — rejected: new tabs opened while the service worker was suspended would be missed

## 14. Storage Schema Versioning

**Decision**: All storage keys prefixed with version (e.g., `v1_settings`, `v1_tabMeta`, `v1_activeTime`). A `v1_schemaVersion` key tracks the current version. On service worker startup, check schema version and run migrations if needed.

**Rationale**: Constitution requires versioned storage keys with migration behavior defined before rollout. Version prefix makes it easy to detect and migrate stale data. Greenfield project starts at v1.

**Alternatives considered**:
- Unversioned keys with a separate migration manifest — rejected: harder to reason about; version prefix is self-documenting
