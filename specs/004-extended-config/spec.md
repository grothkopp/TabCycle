# Feature Specification: Extended Configuration

**Feature Branch**: `004-extended-config`
**Created**: 2026-02-16
**Status**: Draft
**Input**: User description: "Extend the config page and functionality of the extension: Make the main functionality configurable as well: tab & tabgroup aging on/off, tabgroup coloring on/off, tab & tabgroup sorting on/off, new tab autogroup on/off. Make all transitions configurable individually. Make special Yellow and Red folder names configurable. Rework config page sections. Grey out irrelevant options. Extend tests and e2e tests."

## Clarifications

### Session 2026-02-16

- Q: Should sorting be a single toggle or split into separate controls for tabs and tabgroups? → A: Split. Sorting can be disabled completely or separately for tabs and tabgroups. When tab sorting is disabled (or sorting disabled completely), special groups are not created.
- Q: Should re-enabling aging reset all tab age clocks to now? → A: No. The age clock runs independently of extension config at all times. Re-enabling aging picks up wherever the clocks are, so the user has existing state to work with and accidental config changes don't destroy state.
- Q: How should the settings page be organized? → A: Two top-level sections: (1) Aging and (2) Auto-Tab-Groups. Each uses a hierarchical tree where disabling a parent disables all children below it. Existing options (group age display, auto-naming) are integrated into this hierarchy.
- Q: How should the many detail options be presented? → A: "Details" settings should be collapsible or presented in a smaller/secondary form, hidden by default so the user is not overwhelmed.
- Q: What happens to existing special groups when tab sorting is disabled? → A: Dissolve immediately (ungroup tabs, tabs stay in place). When tab sorting is re-enabled, tabs are regrouped based on their current age status (since age tracking runs continuously).
- Q: Should tab age be capped when aging resumes after being disabled? → A: Yes. When aging resumes, each tab's effective age is capped at the red-zone threshold + 1 minute. This prevents all tabs from being immediately closed and bookmarked after a long suspension period.
- Q: Are auto-grouping and auto-naming independent or parent-child? → A: Independent. Auto-naming can be enabled while auto-grouping is disabled (auto-naming applies to any group, not just auto-created ones). They are sibling settings, not parent-child.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Toggle Core Aging Features (Priority: P1)

A user wants to selectively control the aging system and its sub-behaviors. The aging section is the primary section of the settings page and contains all age-related behaviors as a hierarchy:

**Aging (on/off)** — master toggle for the entire aging system. When off, tabs are not evaluated for status transitions. The age clock continues to run in the background regardless.
- **Sorting** — controls automatic reordering of tabs and groups by age zone. Can be configured at two levels:
  - **Tab sorting** (on/off): Whether individual ungrouped tabs are sorted into special groups (yellow/red). When off, special groups are not created.
  - **Tabgroup sorting** (on/off): Whether user-created tab groups are reordered by zone (green zone < yellow zone < red zone).
- **Tabgroup coloring** (on/off): Whether user-created tab groups have their Chrome color updated to reflect the freshest tab's age status.
- **Age in group title** (on/off): Whether the group's age is appended to its title as a suffix (e.g., "News (23m)"). This is the existing "Show group age" option relocated here.

All toggles default to **on** (current behavior preserved).

**Why this priority**: These toggles are the foundation of the entire feature. Without them, the extension is all-or-nothing. Users who find any single behavior annoying must disable the entire extension.

**Independent Test**: Toggle each feature off individually, verify the disabled behavior stops while all other behaviors continue. Toggle back on, verify it resumes.

**Acceptance Scenarios**:

1. **Given** the settings page is open with all defaults, **When** the user disables "Aging", **Then** tabs stop transitioning between states, no special groups are created, and all child settings (sorting, coloring, age in title, transitions) are greyed out.
2. **Given** aging is enabled but "Tabgroup coloring" is disabled, **When** a user group's tabs age past the green threshold, **Then** the tabs still transition status internally but the group's Chrome color is not changed by the extension.
3. **Given** "Tab sorting" is disabled but "Tabgroup sorting" is enabled, **When** tabs age, **Then** ungrouped tabs remain in place and special groups (yellow/red) are NOT created. However, user-created tab groups are still reordered by zone.
4. **Given** both "Tab sorting" and "Tabgroup sorting" are disabled, **When** tabs age, **Then** no automatic reordering occurs at all and no special groups are created.
5a. **Given** "Tab sorting" is enabled and special groups contain yellow/red tabs, **When** the user disables "Tab sorting", **Then** existing special groups are dissolved immediately: their tabs are ungrouped and remain in their current position.
5b. **Given** "Tab sorting" was disabled (special groups were dissolved) and tabs have been accumulating age, **When** the user re-enables "Tab sorting", **Then** tabs are regrouped into special groups based on their current age status on the next evaluation cycle.
6. **Given** "New tab autogroup" is disabled (in Auto-Tab-Groups section), **When** the user opens a new tab, **Then** the tab opens in Chrome's default position without being grouped or moved.
7. **Given** all aging sub-features are off (but aging master toggle is on), **When** tabs age, **Then** tabs still transition between states internally but no visible changes occur (no sorting, no coloring, no title updates).
8. **Given** the user disables aging, **When** they re-enable it, **Then** tabs resume aging from their existing age clocks (age is NOT reset), but each tab's effective age is capped at the red-zone threshold + 1 minute. Tabs transition on the next evaluation cycle based on their capped age.
9. **Given** aging has been disabled for 2 hours, a tab was already 3 hours old, and the red-zone threshold is 24 hours, **When** the user re-enables aging, **Then** the tab's age is 5 hours (uncapped, since 5h < 24h+1m) and it transitions accordingly.
10. **Given** aging has been disabled for 48 hours, a tab was already 1 hour old, and the red-zone threshold is 24 hours, **When** the user re-enables aging, **Then** the tab's effective age is capped at 24h+1m (not the raw 49 hours). The tab transitions to red but is not immediately closed, giving the user time to interact.

---

### User Story 2 - Configure Individual Transitions (Priority: P1)

A user wants fine-grained control over which state transitions occur. Each transition is a node in the settings hierarchy under the Aging section, with its own threshold time and nested detail options.

The transitions section of the settings page is structured as:
- **Green -> Yellow** (on/off, default: on)
  - Transition time (threshold value + unit)
  - Details (collapsible): yellow group name
- **Yellow -> Red** (on/off, default: on)
  - Transition time (threshold value + unit)
  - Details (collapsible): red group name
- **Red -> Gone** (on/off, default: on)
  - Transition time (threshold value + unit)
  - Bookmarking (on/off, default: on)
    - Details (collapsible): bookmark folder name

Disabling a transition means tabs stop progressing at the source state. Disabling an earlier transition implicitly prevents all later transitions (a tab that never becomes yellow can never become red), so downstream transitions and their children are greyed out.

**Why this priority**: Equal to P1 because the transition toggles are tightly coupled with the aging system and directly determine what happens to tabs. Users who fear tab closure will not trust the extension without this control.

**Independent Test**: Disable each transition individually and verify tabs stop at the expected state. Verify cascading disable behavior and that child options grey out.

**Acceptance Scenarios**:

1. **Given** "Red -> Gone" transition is disabled, **When** a tab ages past the red-to-gone threshold, **Then** the tab remains in the red state indefinitely and is never closed or bookmarked.
2. **Given** "Yellow -> Red" transition is disabled, **When** a tab ages past the yellow-to-red threshold, **Then** the tab remains yellow. The "Red -> Gone" transition and all its children (threshold, bookmarking) are greyed out.
3. **Given** "Green -> Yellow" transition is disabled, **When** a tab ages, **Then** it remains green forever. "Yellow -> Red", "Red -> Gone", and all their children are greyed out.
4. **Given** all three transitions are disabled but aging is on, **When** the extension evaluates tabs, **Then** age is tracked internally but no status change occurs (all tabs stay green).
5. **Given** "Red -> Gone" is disabled, **When** the user views the settings page, **Then** the bookmarking toggle and bookmark folder name are greyed out.
6. **Given** "Green -> Yellow" is disabled, **When** the user views the settings page, **Then** the yellow group name, yellow-to-red threshold, red-to-gone threshold, red group name, bookmarking toggle, and bookmark folder name are all greyed out.

---

### User Story 3 - Configure Special Group Names (Priority: P2)

A user wants to customize the names of the system-managed "Yellow" and "Red" tab groups, or leave them unnamed. By default, the special groups have **no name** (empty title). The user can set custom names in settings (located as "details" under each transition), or the extension picks up names the user manually assigns to the special groups directly in Chrome.

The yellow group name field is nested under the green->yellow transition. The red group name field is nested under the yellow->red transition. This means each name field is only editable when its parent transition is enabled.

**Why this priority**: This is a quality-of-life improvement. The core functionality works without it, but users who want a cleaner tab bar or prefer descriptive names (e.g., "Aging", "Old") benefit from this.

**Independent Test**: Verify default empty names, set custom names in settings, rename a special group directly in Chrome, confirm names persist and sync.

**Acceptance Scenarios**:

1. **Given** a fresh install with defaults, **When** the extension creates a yellow special group, **Then** the group title is empty (no visible name in Chrome's tab bar).
2. **Given** the user sets the yellow group name to "Aging" in settings, **When** the extension creates or updates a yellow special group, **Then** the group is titled "Aging".
3. **Given** the yellow special group exists with default empty name, **When** the user manually renames the group in Chrome to "Stale", **Then** the extension detects the rename and stores "Stale" as the configured yellow group name in settings.
4. **Given** the user has set a custom name "Old" for the red group in settings, **When** the user clears the name field back to empty and saves, **Then** the red group title reverts to empty.
5. **Given** the green->yellow transition is disabled, **When** the user views the settings page, **Then** the yellow group name field is greyed out (nested under the disabled transition).

---

### User Story 4 - Hierarchical Settings Page with Collapsible Details (Priority: P2)

The settings page is restructured into two top-level sections with a hierarchical tree layout. Disabling any toggle disables all children below it in the tree. Detail/secondary options are presented in a smaller or collapsible form, hidden by default to keep the page clean.

**Settings page structure:**

```
1) Aging
   * Aging: on/off (master toggle)
   * Details (collapsible):
     * Time mode: active time / wall clock
     * Sorting:
       * Tab sorting: on/off
       * Tabgroup sorting: on/off
     * Tabgroup coloring: on/off
     * Age in group title: on/off
   * Transitions:
     * Green -> Yellow: on/off
       * Transition time: value + unit
       * Details (collapsible): yellow group name
     * Yellow -> Red: on/off
       * Transition time: value + unit
       * Details (collapsible): red group name
     * Red -> Gone: on/off
       * Transition time: value + unit
       * Bookmarking: on/off
         * Details (collapsible): bookmark folder name

2) Auto-Tab-Groups
   * Create auto groups: on/off
   * Auto-name groups: on/off
     * Delay: value in minutes
   (Note: these two toggles are independent siblings, not parent-child.
    Disabling one does NOT grey out the other.)
```

**Why this priority**: A well-organized settings page is important for usability, especially with the increased number of options. However, the functionality works regardless of page layout.

**Independent Test**: Open settings, verify section hierarchy, toggle parent features off and confirm all children grey out, expand/collapse details sections, verify all settings save and load correctly.

**Acceptance Scenarios**:

1. **Given** the settings page is open, **When** the user views the page, **Then** two top-level sections are visible: "Aging" and "Auto-Tab-Groups". Detail sections are collapsed by default.
2. **Given** the user disables "Aging" master toggle, **When** they view the settings page, **Then** ALL options nested below it (time mode, sorting, coloring, age in title, all transitions, all group names, bookmarking) are greyed out.
3. **Given** the user disables "Green -> Yellow" transition, **When** they view the settings page, **Then** the yellow group name, "Yellow -> Red" transition and everything below it (red group name, "Red -> Gone", bookmarking, bookmark folder) are greyed out.
4. **Given** the user disables "Red -> Gone" transition, **When** they view the settings page, **Then** only the red-to-gone threshold, bookmarking toggle, and bookmark folder name are greyed out.
5. **Given** the user disables "Create auto groups", **When** they view the settings page, **Then** "Auto-name groups" and the delay field remain fully enabled and interactive (they are independent features).
6. **Given** detail sections are collapsed by default, **When** the user clicks to expand a detail section, **Then** the detail options are revealed with appropriate styling to indicate they are secondary/advanced options.
7. **Given** a greyed-out section, **When** the user tries to interact with any control in it, **Then** the controls do not respond (inputs are disabled, checkboxes cannot be toggled).
8. **Given** the user re-enables a previously disabled parent feature, **When** the greyed-out children become active again, **Then** they show the last saved values (not defaults).

---

### User Story 5 - Comprehensive Test Coverage (Priority: P3)

All new configuration options are covered by unit tests, integration tests, and end-to-end tests. Tests verify that each toggle works in isolation and in combination with others, including edge cases where multiple features interact. Existing options (group age display, auto-naming) that have been relocated into the new hierarchy are tested in their new context.

**Why this priority**: Tests are critical for quality but don't deliver user-facing value directly. They ensure the feature works correctly and doesn't regress.

**Independent Test**: Run the test suite; all new and existing tests pass. Coverage includes individual toggle tests, combination tests, and UI interaction tests.

**Acceptance Scenarios**:

1. **Given** the test suite, **When** unit tests run, **Then** each new setting toggle is tested: default value, toggle on, toggle off, persistence across saves. Includes tab sorting and tabgroup sorting as separate toggles.
2. **Given** the test suite, **When** integration tests run, **Then** feature interactions are tested: aging off with sorting still configured, transitions partially disabled, tab sorting off but tabgroup sorting on, age clock continuity when aging is toggled off and on.
3. **Given** the test suite, **When** E2E Chrome tests run, **Then** the full lifecycle is tested with various config combinations: tabs age correctly, sorting respects its split toggles, autogroup and auto-naming respect their toggles, special groups are not created when tab sorting is off.
4. **Given** the test suite, **When** E2E tests for the settings page run, **Then** hierarchical grey-out behavior is verified: disabling a parent greys out all children, collapsible detail sections work, re-enabling restores values.
5. **Given** the test suite, **When** all tests run, **Then** existing tests still pass (no regressions from relocating existing options into the new hierarchy).

---

### Edge Cases

- What happens when the user disables aging while tabs are already in yellow/red/special groups? Tabs remain in their current state and groups but no further transitions occur. The age clock continues to run in the background.
- What happens when the user re-enables aging after it was off for a long period? Tabs resume from their accumulated age (not reset), but each tab's effective age is capped at the red-zone threshold + 1 minute. This prevents mass closure: tabs will transition to at most the red state, giving the user a full red-to-gone threshold window before any closures occur.
- What happens when tab sorting is off but tabgroup sorting is on? Ungrouped tabs stay in place (no special groups created), existing special groups are dissolved, but user-created groups are still zone-sorted based on their freshest tab's status.
- What happens when tab sorting is re-enabled? Tabs are immediately regrouped into special groups based on their current age status (the age clock has been running continuously), so the state is reconstructed on the next evaluation cycle.
- What happens when the user disables sorting while groups are in mid-sort? The current sort completes (it's an atomic operation) but no further sorts are triggered.
- What happens when transitions are disabled mid-evaluation cycle? The current cycle respects the new settings immediately; any tab that hasn't yet transitioned in this cycle will be evaluated under the new rules.
- What happens when the user renames a special group in Chrome and the extension hasn't created that group yet (group was dissolved)? The rename is a no-op since the group no longer exists. The name setting persists for when the group is next created.
- What happens when the user sets a special group name in settings, but also renames it in Chrome? The Chrome rename takes precedence (it's the most recent user action) and updates the stored setting.
- What happens to threshold inputs when their parent transition is disabled? The threshold input is greyed out since the transition won't fire, but the value is preserved for when the user re-enables it.
- What happens when "Create auto groups" is off but "Auto-name groups" is on? Auto-naming continues to work independently — it names any unnamed group (not just auto-created ones). Both toggles are independent siblings, so disabling one has no effect on the other.
- What happens to the "Age in group title" option when aging is off? It is greyed out because there's no age to display. Its saved value is preserved.

## Requirements *(mandatory)*

### Functional Requirements

**Core Aging Toggles:**
- **FR-001**: System MUST provide a master "Aging" toggle (default: on). When off, no tab status transitions occur. The age clock continues to accumulate independently.
- **FR-002**: System MUST provide separate toggles for "Tab sorting" (default: on) and "Tabgroup sorting" (default: on) under the aging section.
- **FR-003**: When tab sorting is disabled, the system MUST NOT create or populate special groups (yellow/red). Ungrouped tabs remain in their current position.
- **FR-003a**: When tab sorting is disabled and special groups already exist, the system MUST dissolve them immediately: ungroup their tabs, leaving tabs in their current position.
- **FR-003b**: When tab sorting is re-enabled, the system MUST regroup tabs into special groups based on their current accumulated age status on the next evaluation cycle.
- **FR-004**: When tabgroup sorting is disabled, the system MUST NOT reorder user-created tab groups by zone.
- **FR-005**: System MUST provide a toggle for "Tabgroup coloring" (default: on). When off, user-created tab group colors are not modified by the extension.
- **FR-006**: System MUST provide a toggle for "Age in group title" (default: off, matching current default). When off, no age suffix is appended to group titles.

**Transition Toggles:**
- **FR-007**: System MUST provide individual toggles for each state transition: green->yellow (default: on), yellow->red (default: on), red->gone (default: on).
- **FR-008**: When a transition is disabled, tabs MUST NOT progress past the source state of that transition.
- **FR-009**: Disabling an earlier transition MUST cause all downstream transitions and their children to be greyed out in the UI (since they become unreachable).

**Special Group Names:**
- **FR-010**: System MUST provide text fields for configuring the yellow and red special group names (default: empty string), nested under their respective transitions.
- **FR-011**: When the user manually renames a special group in Chrome, the extension MUST detect the rename and persist the new name to settings.

**Bookmarking:**
- **FR-012**: The bookmarking toggle and bookmark folder name MUST be nested under the red->gone transition. When red->gone is disabled, bookmarking is greyed out.

**Auto-Tab-Groups:**
- **FR-013**: System MUST provide a "Create auto groups" toggle (default: on). When off, newly created tabs are not grouped or repositioned by the extension.
- **FR-014**: System MUST provide an "Auto-name groups" toggle (default: on) with a configurable delay in minutes (default: 5). This toggle is independent of "Create auto groups" — it is a sibling setting, not a child. Auto-naming applies to any group (not just auto-created ones), so it remains active regardless of the auto-group toggle.

**Settings Page Structure:**
- **FR-015**: The settings page MUST be organized into two top-level sections: "Aging" and "Auto-Tab-Groups", with the hierarchical tree structure defined in User Story 4.
- **FR-016**: Disabling any toggle MUST grey out and disable all options nested below it in the hierarchy.
- **FR-017**: Greyed-out options MUST preserve their last-saved values when their parent feature is re-enabled.
- **FR-018**: Detail/secondary options MUST be presented in a collapsible or visually secondary form, collapsed by default.

**Age Clock Behavior:**
- **FR-019**: The age clock MUST run continuously and independently of all config toggles. Disabling aging, transitions, or any other toggle MUST NOT reset or pause the age clock.
- **FR-020**: When aging is re-enabled, tabs MUST be evaluated using their existing accumulated age (not reset to zero).
- **FR-020a**: When aging resumes after being disabled, each tab's effective age MUST be capped at the red-zone threshold + 1 minute. Tabs whose raw accumulated age exceeds this cap are evaluated as if their age equals the cap. This prevents mass tab closure after a long suspension period.

**Persistence & Testing:**
- **FR-021**: All new settings MUST be persisted to storage and survive extension restarts and Chrome restarts.
- **FR-022**: All new configuration options MUST have unit tests, integration tests, and E2E tests covering individual and combined behaviors.

### Key Entities

- **Settings**: Extended with: aging master toggle (boolean), tab sorting toggle (boolean), tabgroup sorting toggle (boolean), tabgroup coloring toggle (boolean), three transition toggles (booleans), two special group name strings (default empty), autogroup toggle (boolean). Existing fields (showGroupAge, autoGroupNamingEnabled, autoGroupNamingDelayMinutes, bookmarkEnabled, bookmarkFolderName, timeMode, thresholds) are preserved and relocated in the UI hierarchy.
- **Settings Hierarchy**: A tree structure defining parent-child relationships between settings, used by the UI to determine which controls to grey out when a parent is disabled. The hierarchy follows the two-section structure (Aging, Auto-Tab-Groups). Note: in the Auto-Tab-Groups section, "Create auto groups" and "Auto-name groups" are independent siblings — neither is a parent of the other.

## Assumptions

- Disabling "tabgroup sorting" only stops zone-reordering of user-created groups. It does NOT affect whether ungrouped tabs move into special groups (that's controlled by "tab sorting").
- Disabling "tab sorting" prevents creation of special groups entirely. Tabs that would have moved to yellow/red special groups remain ungrouped in their current position.
- Disabling "tabgroup coloring" only affects user-created groups. Special groups (yellow/red) always use their designated color since it's their identity.
- The existing threshold validation (green < yellow < red) still applies to threshold values, even when some transitions are disabled. The values are preserved for when transitions are re-enabled.
- When aging is disabled, the evaluation alarm still runs (to re-check settings) but skips status computation. The age clock (active time accumulator) continues to run.
- The "Time mode" setting (active time vs wall clock) is a detail under the Aging section because it controls how age is calculated.
- The collapsible "Details" sections use a simple expand/collapse interaction (click to toggle). No specific animation or transition style is required.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can independently toggle each aging sub-feature (tab sorting, tabgroup sorting, coloring, age in title) and observe the change in extension behavior within one evaluation cycle (30 seconds).
- **SC-002**: Users can disable any combination of transitions and verify that tabs stop aging at the expected state.
- **SC-003**: Users can configure special group names and see the change reflected in Chrome within one evaluation cycle.
- **SC-004**: The settings page correctly greys out all child options within 100ms of toggling a parent feature.
- **SC-005**: All existing tests continue to pass after the changes (zero regressions).
- **SC-006**: New test coverage includes at least: one test per toggle (including separate tab/tabgroup sorting tests), one test per transition toggle, one test per grey-out dependency, and three combination tests covering interacting features.
- **SC-007**: Settings page load time remains under 500ms with the additional options.
- **SC-008**: 100% of saved settings persist correctly across extension restart, Chrome restart, and settings page reload.
- **SC-009**: Disabling and re-enabling aging does NOT reset tab age clocks. Tabs resume from their accumulated age, capped at the red-zone threshold + 1 minute.
- **SC-010**: After a long aging suspension (e.g., 48 hours off), re-enabling aging does NOT cause any tabs to be immediately closed. All tabs are at most in the red state after re-enable.
- **SC-011**: Detail sections are collapsed by default and expand/collapse on user interaction.
