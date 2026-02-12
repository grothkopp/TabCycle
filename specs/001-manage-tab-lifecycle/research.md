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

## 8. Storage Schema Versioning

**Decision**: All storage keys prefixed with version (e.g., `v1_settings`, `v1_tabMeta`, `v1_activeTime`). A `v1_schemaVersion` key tracks the current version. On service worker startup, check schema version and run migrations if needed.

**Rationale**: Constitution requires versioned storage keys with migration behavior defined before rollout. Version prefix makes it easy to detect and migrate stale data. Greenfield project starts at v1.

**Alternatives considered**:
- Unversioned keys with a separate migration manifest — rejected: harder to reason about; version prefix is self-documenting
