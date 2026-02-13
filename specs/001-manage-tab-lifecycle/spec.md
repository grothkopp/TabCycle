# Feature Specification: Manage Tab Lifecycle

**Feature Branch**: `001-manage-tab-lifecycle`  
**Created**: 2026-02-12  
**Status**: Clarified  
**Input**: User description: "Create a new Google Chrome extension named TabCycle that manages the lifecycle of opened tabs in a Chrome window, including refresh-time tracking, status-based coloring, intelligent tab sorting, and automatic tab/group cleanup."

## Clarifications

### Session 2026-02-12

- Q: Is user-active time tracked per-window or globally? → A: Globally across all windows. Any focused tab in any window increments the single global counter.
- Q: Are tab refresh times window-dependent? → A: No. Tab refresh times are independent of windows. A tab moved across windows keeps its original refresh time.
- Q: What exactly is per-window? → A: Only tab sorting and group management are per-window. A tab's status change never causes it to move between windows.
- Q: What are the default active-time thresholds for status transitions? → A: Moderate defaults: Green→Yellow at 4h, Yellow→Red at 8h, Red→Gone at 24h. All thresholds are user-configurable in extension settings. User can also choose between active time and wall-clock time, and specify durations in minutes, hours, or days.
- Q: Should a page reload (same URL) reset the refresh time? → A: Yes. Any navigation or reload resets refresh time.
- Q: When a tab inside a user-created group changes status, should it be extracted to a special group? → A: No. Tabs stay in their user-created group. Only the group itself moves between zones based on its status (determined by its newest tab).
- Q: How frequently should the extension evaluate tab statuses? → A: Every 30 seconds.
- Q: Are special "Yellow" and "Red" groups exempt from sorting, status changes, and group-level closing? → A: Yes. Special groups are never sorted, never change status, and are never closed as a group. Individual tabs inside them are processed independently (Yellow→Red move, Red→Gone close). If a special group becomes empty it is removed; it is recreated when needed again.
- Q: What happens when a new tab is opened while an ungrouped green tab is active? → A: Both the active tab and the new tab are placed into a newly created group with an empty name, with the new tab to the right of the active tab.
- Q: What happens when Chrome restores tabs from a previous session? → A: Restored tabs continue with the active time they had before closing. Tab metadata (including refresh times) persists across browser restarts and session restores.

### Session 2026-02-13

- Q: Should SPA navigations (e.g., History API pushState/replaceState on sites like Reddit) be treated as refresh events? → A: Yes. SPA navigations via the History API should reset the tab's refresh time, just like traditional navigations. The extension listens to `chrome.webNavigation.onHistoryStateUpdated` in addition to `onCommitted` to catch these.
- Q: When a group transitions between zones (e.g., green→yellow), where exactly should it be placed within the new zone? → A: A newly transitioned group is placed at the left of its new zone, but to the right of the special group for that zone (if it exists). A group refreshed back to green is placed at the absolute leftmost position (left of all other green groups).
- Q: Should individual tabs inside a user-created group be closed when they individually reach "gone" status, even if the group itself is not gone? → A: No. This was a bug. Only the group's overall status (determined by `computeGroupStatus` — the freshest tab) determines whether the group is gone. If even one tab in the group is green/yellow/red, the entire group stays open. Individual tabs in user groups are never closed independently for gone status.
- Q: Where should gone handling (bookmarking and closing) be performed? → A: Inside `sortTabsAndGroups` as a "gone" zone after red. This centralizes all zone-based logic in one function. The function accepts a `goneConfig` parameter with bookmark callbacks to avoid circular dependencies.
- Q: Should the age of a tab group be displayed in its title? → A: Yes, optionally. When the `showGroupAge` setting is enabled (default: off), the extension appends the group's age in parentheses after the group name — e.g., "News (23m)", "Research (3h)", "Old Stuff (3d)". The age is computed from the freshest (youngest) tab in the group. When bookmarking groups, the age suffix is stripped from the folder name. The age is displayed in minutes (`m`) for <60min, hours (`h`) for <24h, days (`d`) otherwise.
- Q: What happens when Chrome fires tab/group events (onUpdated, onMoved, onRemoved) as a side effect of the evaluation cycle's own Chrome API calls? → A: These reactive event handlers must be suppressed during the evaluation cycle to prevent stale-state writes that race with the cycle's in-memory state. An `evaluationCycleRunning` guard flag is set before the cycle runs and cleared in a `finally` block. Similarly, a `tabPlacementRunning` guard suppresses `onUpdated` groupId handling during `placeNewTab`. The evaluation cycle also has a re-entrancy guard with a 60-second timeout to prevent concurrent cycles.
- Q: What happens when the extension is reloaded (updated) during development? → A: On extension update (`onInstalled` with `reason: 'update'`), the extension uses `reconcileState` (which preserves existing tab metadata and ages) instead of `scanExistingTabs` (which resets everything to green). `scanExistingTabs` is only used on fresh install. An immediate evaluation cycle is triggered after both install and startup.
- Q: Should Chrome restore a suspended/discarded tab trigger a navigation event? → A: No. When Chrome restores a suspended or discarded tab, the resulting navigation should NOT reset the tab's age. The navigation handler checks `tab.discarded` and `tab.status === 'unloaded'` and skips these events.
- Q: Can tabMeta.groupId become stale between evaluation cycles? → A: Yes. Chrome API calls from event handlers or user actions can change a tab's group without the evaluation cycle knowing. At the start of each evaluation cycle, the extension reconciles `tabMeta.groupId` values by querying `chrome.tabs.query({})` and comparing actual group IDs with stored ones.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tab Age Tracking and Status Display (Priority: P1)

As a user with many open tabs, I want each tab to be tracked by how long it has been since it was created or last navigated, and I want tabs and tab groups to visually reflect their age through color-coded statuses (Green → Yellow → Red → Gone), so I can see at a glance which tabs are fresh and which are stale.

**Why this priority**: This is the core mechanic of TabCycle. Without age tracking and status transitions, no other feature (sorting, grouping, cleanup) can function. It delivers immediate value by making tab staleness visible.

**Independent Test**: Can be tested by opening several tabs, waiting for time to pass (or simulating elapsed active time), and verifying that tab/group colors transition through Green → Yellow → Red → Gone.

**Acceptance Scenarios**:

1. **Given** a newly opened or navigated tab, **When** the extension evaluates its status, **Then** the tab is assigned status Green.
2. **Given** a tab with status Green whose tracked age exceeds the Green threshold, **When** the extension evaluates its status, **Then** the tab transitions to Yellow.
3. **Given** a tab with status Yellow whose tracked age exceeds the Yellow threshold, **When** the extension evaluates its status, **Then** the tab transitions to Red.
4. **Given** a tab with status Red whose tracked age exceeds the Red threshold, **When** the extension evaluates its status, **Then** the tab transitions to Gone and is closed.
5. **Given** a tab group containing multiple tabs, **When** the extension evaluates the group's status, **Then** the group's status is determined by the newest (freshest) tab inside it.
6. **Given** the `showGroupAge` setting is enabled, **When** the extension evaluates a tab group, **Then** the group's title is updated to include the age of its freshest tab in parentheses (e.g., "News (23m)").
7. **Given** the `showGroupAge` setting is disabled (default), **When** the extension evaluates a tab group, **Then** any existing age suffix is removed from the group's title.
8. **Given** the user has been away from the browser for an extended period (e.g., a weekend), **When** the user returns, **Then** tabs have NOT all uniformly aged to Red/Gone because age tracking is based on user-active time rather than wall-clock time.
9. **Given** a pinned tab, **When** the extension evaluates tabs, **Then** the pinned tab is completely excluded from tracking, status changes, sorting, and closing.

---

### User Story 2 - Automatic Tab Sorting into Special Groups (Priority: P2)

As a user, I want tabs that age out of Green status to be automatically moved into special "Yellow" and "Red" groups, so that stale tabs are consolidated and separated from my actively-used tabs without manual effort.

**Why this priority**: Automatic grouping of aging tabs is the primary organizational benefit of TabCycle. It keeps the tab bar tidy by moving stale tabs out of the user's working area.

**Independent Test**: Can be tested by opening ungrouped tabs, waiting for them to age past the Green threshold, and verifying they are moved into the special "Yellow" group. Then waiting further and verifying they move to the special "Red" group.

**Acceptance Scenarios**:

1. **Given** an ungrouped tab with status Green, **When** its status transitions to Yellow, **Then** it is moved into the special group named "Yellow".
2. **Given** the special group "Yellow" does not yet exist, **When** a tab first needs to be moved into it, **Then** the group is created and positioned to the left of any groups with Yellow status.
3. **Given** a tab in the special group "Yellow", **When** its status transitions to Red, **Then** it is moved into the special group named "Red".
4. **Given** the special group "Red" does not yet exist, **When** a tab first needs to be moved into it, **Then** the group is created and positioned to the left of any groups with Red status.
5. **Given** a tab in the special group "Red", **When** its status transitions to Gone, **Then** the tab is closed.
6. **Given** the special group "Yellow" or "Red" becomes empty (last tab closed or refreshed out), **When** this is detected, **Then** the empty special group is removed.

---

### User Story 3 - New Tab Placement Based on Context (Priority: P2)

As a user, I want new tabs to be intelligently placed based on what I am currently viewing, so that related tabs stay together and stale-context tabs do not pollute my working groups.

**Why this priority**: Smart tab placement directly supports the user's workflow by keeping related content grouped, which is essential for the extension's value proposition alongside age tracking.

**Independent Test**: Can be tested by activating a tab inside a user-created group, opening a new tab, and verifying the new tab appears inside the same group to the right of the active tab. Then activating a tab in the "Yellow" or "Red" special group, opening a new tab, and verifying it appears as a fresh ungrouped tab to the left of all tabs and groups.

**Acceptance Scenarios**:

1. **Given** the active tab is in a user-created tab group (not "Yellow" or "Red"), **When** a new tab is opened in that window by any means, **Then** the new tab is placed inside the same group, immediately to the right of the active tab.
2. **Given** the active tab is in the special group "Yellow" or "Red", **When** a new tab is opened, **Then** the new tab is created as a fresh ungrouped tab positioned to the left of all existing tabs and groups.
3. **Given** the active tab is ungrouped and not pinned, **When** a new tab is opened, **Then** a new group with an empty name is created containing the active tab and the new tab (new tab to the right of the active tab).

---

### User Story 4 - Tab Group Status Coloring and Sorting (Priority: P3)

As a user, I want my tab groups to automatically change color based on their age status and be sorted into status zones (green left, yellow middle, red right), so the tab bar has a clear visual layout reflecting content freshness.

**Why this priority**: Group-level visual feedback and positional sorting enhance usability but depend on the core tracking (P1) and individual tab sorting (P2) being in place first.

**Independent Test**: Can be tested by creating several tab groups, allowing them to age differently, and verifying that group colors update and groups reorder into status zones.

**Acceptance Scenarios**:

1. **Given** a tab group whose status is Green, **When** the extension sets its color, **Then** the group color is set to green.
2. **Given** a tab group whose status is Yellow, **When** the extension sets its color, **Then** the group color is set to yellow.
3. **Given** a tab group whose status is Red, **When** the extension sets its color, **Then** the group color is set to red.
4. **Given** multiple tab groups, **When** they are sorted, **Then** Green groups are positioned leftmost, Yellow groups in the middle, and Red groups rightmost.
5. **Given** multiple Green groups, **When** a new group is created, **Then** it is placed to the left of all existing groups; existing Green groups are not re-sorted relative to each other.
6. **Given** a Green group that transitions to Yellow, **When** it is repositioned, **Then** it moves to the left of the Yellow zone (but to the right of the special "Yellow" group if that exists and is the leftmost group of the yellow zone).
7. **Given** a Yellow group that transitions to Red, **When** it is repositioned, **Then** it moves to the left of the Red zone (but to the right of the special "Red" group if that exists and is the leftmost group of the red zone).
8. **Given** a Yellow or Red group that is refreshed back to Green, **When** it is repositioned, **Then** it moves to the absolute leftmost position (left of all other green groups).
9. **Given** a tab group whose overall status (determined by its freshest tab) reaches Gone, **When** this is detected, **Then** the group and all its tabs are bookmarked (if bookmarking is enabled) and closed. The special "Yellow" and "Red" groups are exempt from closing and sorting by Gone status.
10. **Given** a tab group where some tabs have individually reached Gone status but the group's freshest tab is still green, yellow, or red, **When** the extension evaluates the group, **Then** the group is NOT closed and no individual tabs within the group are closed for gone status. The group's status is determined by its freshest (newest) tab.

---

### User Story 5 - User Retains Manual Control (Priority: P3)

As a user, I want to retain full manual control over creating, renaming, and reordering my tab groups, so that TabCycle enhances my workflow without overriding my preferences.

**Why this priority**: Respecting user autonomy is important for adoption and usability, but it is a constraint on the system rather than a standalone deliverable.

**Independent Test**: Can be tested by manually creating, renaming, and reordering groups, then verifying TabCycle does not undo those changes (only colors and status-based positioning are managed by the extension).

**Acceptance Scenarios**:

1. **Given** the user creates a new tab group and names it, **When** TabCycle evaluates groups, **Then** the user's group name is preserved (TabCycle only changes the group color, and optionally appends an age suffix if `showGroupAge` is enabled).
2. **Given** the user manually reorders Green groups, **When** TabCycle evaluates groups, **Then** the user's ordering among Green groups is preserved (no re-sorting within the same status tier).
3. **Given** the user manually moves a tab between groups, **When** TabCycle evaluates, **Then** TabCycle does not move the tab back (it respects the user's explicit action and tracks the tab's age from its original creation/navigation time).

---

### User Story 6 - Per-Window Sorting with Global Time Tracking (Priority: P3)

As a user with multiple Chrome windows, I want user-active time to be tracked globally across all windows, while tab sorting and group management are handled independently per window, so that a tab aging from Green to Yellow does not cause it to move to a different window.

**Why this priority**: Multi-window support is essential for correctness but is an architectural concern rather than a user-facing feature on its own.

**Independent Test**: Can be tested by opening two windows, being active in Window A, and verifying that tabs in Window B also age (because active time is global). Then verifying that each window's groups are sorted independently and tabs do not move between windows as a side effect of status changes.

**Acceptance Scenarios**:

1. **Given** two open Chrome windows, **When** the user is active in Window A, **Then** tabs in both Window A and Window B accumulate active time and age equally (active time is global).
2. **Given** two open Chrome windows with different tab group layouts, **When** TabCycle manages groups, **Then** each window's groups are sorted independently.
3. **Given** a tab that transitions from Green to Yellow in Window B, **When** the extension moves it into a special group, **Then** the tab remains in Window B (it is sorted into the "Yellow" group within that window).
4. **Given** a tab is moved from Window A to Window B by the user, **When** the extension evaluates the tab, **Then** the tab retains its original refresh time and accumulated age.

---

### Edge Cases

- What happens when a tab is navigated (URL changes) while it is in the special "Yellow" or "Red" group? The tab's refresh time resets; it should be treated as refreshed and moved out of the special group back to the Green zone.
- What happens when the user drags a tab from one window to another? The tab retains its tracked age and is evaluated in the context of the new window.
- What happens when Chrome restores tabs from a previous session? Restored tabs continue with the active time they had before closing. Their refresh times and statuses are recovered from persisted state, so a tab that was Yellow before closing remains Yellow after restore.
- What happens when many tabs change status simultaneously (e.g., after returning from being away)? The extension must handle batch transitions gracefully without creating excessive visual churn or performance degradation.
- What happens if the user creates a group manually named "Yellow" or "Red"? The extension should treat only its own specially-created groups as special. User-created groups with those names should be treated as regular groups.
- What happens when the browser is closed and reopened? Active-time tracking state should be persisted so that tabs do not all reset to Green on restart.
- What happens when the extension is reloaded during development? On extension update, `reconcileState` is used instead of `scanExistingTabs`, preserving existing tab ages. Only fresh installs use `scanExistingTabs`.
- What happens when Chrome fires tab events (onUpdated, onMoved, onRemoved) as a side effect of the evaluation cycle moving groups or updating titles? These events are suppressed via guard flags (`evaluationCycleRunning`, `tabPlacementRunning`) to prevent stale-state writes that race with the cycle's in-memory state.
- What happens when Chrome restores a suspended or discarded tab? The navigation handler detects `tab.discarded` or `tab.status === 'unloaded'` and skips the event, preserving the tab's existing age.
- What happens if a tab in a user-created group is refreshed? The group's status is recalculated based on its newest tab; the group may change status accordingly.
- What happens when the user changes the time-tracking mode or thresholds in settings? All existing tabs are re-evaluated against the new settings immediately. Tabs may change status (including being closed if they now exceed the Gone threshold).
- What happens when a site uses SPA navigation (pushState/replaceState) instead of full page loads? The extension detects these via `chrome.webNavigation.onHistoryStateUpdated` and treats them as refresh events, resetting the tab's age. A per-tab debounce prevents double-processing when both `onCommitted` and `onHistoryStateUpdated` fire for the same navigation.
- What happens when a tab inside a user-created group individually reaches "gone" status but other tabs in the group are still fresh? The tab is NOT individually closed. Only the group's overall status (determined by `computeGroupStatus` — the freshest tab) determines whether the group is closed. This prevents premature closing of tabs in recently-refreshed groups.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The extension MUST track a "refresh time" for each non-pinned tab, defined as the time since the tab was created or last navigated (including reloads of the same URL).
- **FR-002**: The extension MUST calculate tab age using either "user-active time" (tracked globally across all Chrome windows) or wall-clock time, as selected by the user in the extension settings. The default MUST be user-active time.
- **FR-003**: The extension MUST assign each tab a status based on its age: Green (fresh), Yellow (aging), Red (stale), Gone (expired). Default thresholds: Green→Yellow at 4 hours, Yellow→Red at 8 hours, Red→Gone at 24 hours.
- **FR-004**: The extension MUST assign each tab group a status based on the newest tab inside the group.
- **FR-005**: The extension MUST change tab group colors to match their current status (green, yellow, red).
- **FR-006**: The extension MUST exclude pinned tabs from all tracking, status assignment, sorting, and closing.
- **FR-007**: The extension MUST handle tab sorting and group management independently per Chrome window. Tab age tracking and the active-time accumulator are global across all windows. A tab's status change MUST NOT cause it to move between windows.
- **FR-008**: When a new tab is opened while a tab in a user-created group (not "Yellow" or "Red") is active, the extension MUST place the new tab inside that group, immediately to the right of the active tab.
- **FR-009**: When a new tab is opened while either (a) a tab in the special "Yellow" or "Red" group is active, (b) a pinned tab is active, or (c) no active tab exists, the extension MUST place the new tab as an ungrouped tab at the leftmost position in the current window.
- **FR-010**: When an ungrouped tab transitions from Green to Yellow, the extension MUST move it into the special "Yellow" group.
- **FR-011**: When a tab in the special "Yellow" group transitions to Red, the extension MUST move it into the special "Red" group.
- **FR-012**: When a tab in the special "Red" group transitions to Gone, the extension MUST close the tab.
- **FR-013**: The extension MUST create the special "Yellow" group if it does not exist when a tab first needs to be placed in it, positioning it to the left of groups with Yellow status.
- **FR-014**: The extension MUST create the special "Red" group if it does not exist when a tab first needs to be placed in it, positioning it to the left of groups with Red status.
- **FR-015**: The extension MUST remove the special "Yellow" or "Red" group when it becomes empty.
- **FR-016**: The extension MUST sort tab groups into status zones: Green groups leftmost, Yellow groups in the middle, Red groups rightmost. Groups that reach Gone status are handled (bookmarked and closed) within the same sorting pass.
- **FR-017**: The extension MUST NOT re-sort groups within the same status tier (e.g., Green groups retain their user-defined or creation order relative to each other).
- **FR-018**: When a Green group transitions to Yellow, the extension MUST move it to the left of the Yellow zone (to the right of the special "Yellow" group if it exists).
- **FR-019**: When a Yellow group transitions to Red, the extension MUST move it to the left of the Red zone (to the right of the special "Red" group if it exists). The special "Yellow" group is exempt from this sorting.
- **FR-020**: When a Yellow or Red group is refreshed back to Green, the extension MUST move it to the absolute leftmost position (left of all other Green groups).
- **FR-021**: The special "Red" and "Yellow" groups MUST NOT have a group-level status, MUST NOT be sorted between zones, and MUST NOT be closed as a group. They are exempt from all group-level status evaluation, color-based sorting, and Gone-triggered closing. They are only removed when they become empty (FR-015).
- **FR-022**: When a user-created tab group reaches status Gone (determined by `computeGroupStatus` — the freshest tab in the group), the extension MUST bookmark the group (if bookmarking is enabled) and close the group and all tabs inside it. The special "Yellow" and "Red" groups are both exempt from this behavior. Individual tabs within a user-created group MUST NOT be closed for gone status independently; only the group-level status determines closure.
- **FR-023**: The extension MUST allow users to retain full manual control over creating, renaming, and reordering their own tab groups. Only group colors, status-based positioning, and optional age suffix display are managed by TabCycle.
- **FR-024**: When a tab in the special "Yellow" or "Red" group is navigated (URL changes), its refresh time MUST reset and it MUST be moved back to the appropriate position as a Green tab.
- **FR-025**: The extension MUST persist all tab metadata (refresh times, statuses) and the active-time accumulator across browser restarts and session restores. Restored tabs MUST continue with their previous active time and status, not reset to Green.
- **FR-026**: New tab groups created by the user MUST be placed to the left of all existing groups (in the Green zone).
- **FR-027**: The extension MUST distinguish between its own specially-created "Yellow" and "Red" groups and any user-created groups that happen to share those names.
- **FR-028**: The extension MUST provide a settings page where users can configure: (a) the time-tracking mode (user-active time or wall-clock time), (b) the threshold duration for each status transition (Green→Yellow, Yellow→Red, Red→Gone), with input supporting minutes, hours, and days as units.
- **FR-029**: The extension MUST apply sensible defaults (active time mode; 4h, 8h, 24h thresholds) when no user configuration is present.
- **FR-030**: Tabs inside user-created groups MUST remain in their group regardless of individual tab status changes. Only the group as a whole changes status and moves between zones. Individual tabs are only moved to the special "Yellow" or "Red" groups if they are ungrouped.
- **FR-031**: The extension MUST evaluate all tab and group statuses at least every 30 seconds and apply any necessary transitions (status changes, group moves, tab closures).
- **FR-032**: Tabs inside the special "Yellow" and "Red" groups MUST be processed individually: tabs in "Yellow" that transition to Red are moved to "Red" (FR-011), tabs in "Red" that transition to Gone are closed (FR-012). The special groups themselves are never the unit of action for status transitions.
- **FR-033**: When a new tab is opened while an ungrouped, non-pinned tab is active, the extension MUST create a new tab group with an empty name containing the active tab and the new tab, with the new tab positioned to the right of the active tab. The new group MUST immediately receive the Green color.
- **FR-034**: The extension MUST handle new tab placement in the `chrome.tabs.onCreated` handler by using the new tab's `openerTabId` to identify the context tab (the tab that was active before creation). Chrome reserves Ctrl+T/Cmd+T and switches focus to the new tab before `onCreated` fires, so the context tab MUST NOT be determined by querying the currently active tab. If no `openerTabId` is available, the new tab MUST be placed at the leftmost position. If the context tab's group is stale or invalid, the extension MUST gracefully fall back to leftmost placement.
- **FR-035**: When a new tab group is created (either by the extension or as a result of tab placement), the extension MUST immediately set its color to match its computed status (typically Green for new groups).
- **FR-036**: The extension MUST detect SPA navigations (History API `pushState`/`replaceState`) via `chrome.webNavigation.onHistoryStateUpdated` and treat them as refresh events that reset the tab's age, in addition to traditional navigations detected via `chrome.webNavigation.onCommitted`.
- **FR-037**: The extension MUST implement per-tab debounce for navigation events to prevent double-processing when both `onCommitted` and `onHistoryStateUpdated` fire for the same navigation within a short time window.
- **FR-038**: When a group transitions from one zone to another (e.g., green→yellow), the extension MUST place it at the left of the new zone, but to the right of the special group for that zone (if it exists). Groups within the same zone that have not transitioned MUST retain their relative order.
- **FR-039**: Gone handling (bookmarking and closing of gone tabs and groups) MUST be performed within the `sortTabsAndGroups` function as a "gone" zone after red. The function accepts a `goneConfig` parameter with bookmark callbacks. Ungrouped gone tabs (or gone tabs in special groups) are bookmarked and closed individually. Gone user-created groups are bookmarked as a group and all their tabs are closed.
- **FR-040**: The extension MUST provide a settings toggle (`showGroupAge`, default: off) to display the age of each tab group in its title. When enabled, the age of the freshest tab in the group is appended in parentheses — e.g., "News (23m)", "Research (3h)", "Old Stuff (3d)". The age format uses minutes (`m`) for <60min, hours (`h`) for <24h, days (`d`) otherwise. When disabled, any existing age suffix MUST be removed from group titles.
- **FR-041**: When bookmarking a tab group, the extension MUST strip the age suffix from the group title before using it as the bookmark subfolder name.
- **FR-042**: The extension MUST suppress reactive event handlers (`chrome.tabs.onUpdated` groupId, `chrome.tabs.onRemoved`, `chrome.tabs.onMoved`) during the evaluation cycle using an `evaluationCycleRunning` guard flag. Similarly, a `tabPlacementRunning` guard MUST suppress `onUpdated` groupId handling during `placeNewTab`. This prevents stale-state writes that race with in-flight operations.
- **FR-043**: The evaluation cycle MUST include a re-entrancy guard that skips concurrent invocations. A 60-second timeout auto-resets the guard to prevent permanent lockout.
- **FR-044**: On extension update (`onInstalled` with `reason: 'update'`), the extension MUST use `reconcileState` (which preserves existing tab metadata) instead of `scanExistingTabs` (which resets all tabs to green). `scanExistingTabs` is only used on fresh install.
- **FR-045**: At the start of each evaluation cycle, the extension MUST reconcile `tabMeta.groupId` values by querying `chrome.tabs.query({})` and comparing actual Chrome group IDs with stored values, fixing any stale entries.
- **FR-046**: The navigation handler MUST skip events for suspended or discarded tabs (`tab.discarded` or `tab.status === 'unloaded'`) to avoid resetting their age.
- **FR-047**: The `reconcileState` function MUST create default window state entries (with empty `specialGroups` and `groupZones`) for windows that have tabs but no stored state.

### Key Entities

- **Tab**: A single browser tab within a Chrome window. Key attributes: refresh time (creation or last navigation timestamp), accumulated active time, current status (Green/Yellow/Red/Gone), pinned state, group membership.
- **Tab Group**: A Chrome tab group containing one or more tabs. Key attributes: name, color, status (derived from newest tab), whether it is a special group ("Yellow" or "Red") or user-created.
- **Window**: A Chrome browser window. Key attributes: own set of tabs and groups, focus state. Sorting and group management are scoped to the window; time tracking is global.
- **Active Time Accumulator**: A single global counter that tracks how much time the user has been actively using any Chrome window (any tab in any window has focus). This value is used as the age measure for all tabs across all windows.
- **Group Age Display**: An optional feature that appends the age of a tab group's freshest tab to the group's title in parentheses (e.g., "News (23m)"). Controlled by the `showGroupAge` setting (default: off). The age suffix is stripped when bookmarking groups.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Tabs visually transition through the Green → Yellow → Red → Gone lifecycle without user intervention, reflecting actual user-active time rather than wall-clock time.
- **SC-002**: After a period of browser inactivity (e.g., overnight), tabs do not mass-transition to Red or Gone upon the user's return.
- **SC-003**: New tabs opened from within a user-created group are placed inside that group to the right of the active tab 100% of the time.
- **SC-004**: Ungrouped tabs transitioning to Yellow are moved into the special "Yellow" group within one evaluation cycle.
- **SC-005**: Tab groups are correctly sorted into status zones (Green | Yellow | Red) at all times, with no violations of zone ordering.
- **SC-006**: User-defined group names, manual reordering within the same status tier, and custom groups are never overridden by the extension.
- **SC-007**: Pinned tabs are never affected by any TabCycle behavior.
- **SC-008**: Each Chrome window's tab sorting and group management operates independently; tabs never move between windows as a side effect of status changes. Active time is tracked globally across all windows.
- **SC-009**: The extension handles 50+ open tabs per window without perceptible performance degradation or UI lag.
- **SC-010**: Extension state (active-time counters, tab metadata) survives browser restarts without data loss.
