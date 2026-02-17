# Research: Extended Configuration

**Feature Branch**: `004-extended-config`
**Date**: 2026-02-16

## Research Questions & Findings

### R1: How to detect when a user renames a special group in Chrome?

**Decision**: Listen for `chrome.tabGroups.onUpdated` events. When a special group's title changes and the change was NOT initiated by the extension (tracked via a guard flag), persist the new name to settings.

**Rationale**: The extension already tracks special groups by ID in `windowState.specialGroups`. The `chrome.tabGroups.onUpdated` event fires whenever a group's properties (title, color, collapsed state) change. By comparing the group ID against known special group IDs and checking that the extension didn't initiate the change (using the existing `markExtensionColorUpdate` pattern), we can reliably detect user-initiated renames.

**Alternatives considered**:
- Polling group titles on each evaluation cycle: rejected because it adds latency (up to 30s delay) and wastes API calls.
- MutationObserver on the tab strip: not available from the service worker context.

### R2: How to implement collapsible/detail sections in the options page?

**Decision**: Use native HTML `<details>/<summary>` elements for collapsible sections. No JavaScript framework needed.

**Rationale**: The options page is a simple static HTML page with vanilla JS. `<details>/<summary>` is natively supported in all Chrome versions relevant to Manifest V3, provides built-in collapse/expand with zero JS, and is accessible by default (keyboard navigable, screen reader support). CSS can style the collapsed/expanded states.

**Alternatives considered**:
- Custom JS toggle with `display:none/block`: works but reinvents the wheel and lacks accessibility without ARIA attributes.
- A lightweight framework (e.g., Alpine.js): rejected per constitution principle IV (least-privilege, no unnecessary dependencies).

### R3: How to implement the age cap when aging resumes?

**Decision**: When aging is re-enabled (transition from `agingEnabled: false` to `agingEnabled: true`), compute a "cap timestamp" and update each tab's `refreshActiveTime` / `refreshWallTime` to be no earlier than `now - (redToGone threshold + 1 minute)`. This ensures `computeAge()` never returns more than `redToGone + 1 min` for any tab.

**Rationale**: Modifying the age at the source (the refresh timestamp) is the simplest approach because all downstream code (`computeAge`, `computeStatus`, sorting) continues to work unchanged. The cap only needs to be applied once, at the moment aging is re-enabled — not on every evaluation cycle. This avoids adding conditional logic throughout the evaluation pipeline.

**Alternatives considered**:
- Capping in `computeAge()`: rejected because it would apply on every evaluation cycle (unnecessary overhead), and the cap is only meaningful at the re-enable moment.
- Adding a separate "cappedAge" field: rejected because it complicates the data model with a redundant field.
- Capping in `computeStatus()`: rejected because the age value would still be uncapped in other uses (e.g., age display).

### R4: How to dissolve special groups when tab sorting is disabled?

**Decision**: When the `tabSortingEnabled` setting changes from `true` to `false`, iterate over all windows, find special groups, ungroup their tabs using `chrome.tabs.ungroup()`, and clear the `specialGroups` references in `windowState`.

**Rationale**: `chrome.tabs.ungroup()` moves tabs out of a group without changing their position. If the group becomes empty, Chrome automatically removes it. This gives the exact behavior specified: tabs stay in place, group disappears.

**Alternatives considered**:
- Closing and re-opening tabs: rejected because it destroys tab state (scroll position, form data).
- Just clearing the references without ungrouping: rejected because the visual groups would persist in Chrome, confusing the user.

### R5: Settings schema migration strategy (v1 → v2)

**Decision**: Bump schema version from 1 to 2. On extension update (`chrome.runtime.onInstalled` with `reason: 'update'`), detect schema version 1 and migrate by adding new fields with their defaults. Existing fields are preserved as-is.

**Rationale**: The existing schema has `v1_schemaVersion` for exactly this purpose. All new fields have safe defaults that preserve current behavior (all new toggles default to `on`). The migration is additive-only (no fields removed or renamed), so it's a simple merge.

**Alternatives considered**:
- No migration (just rely on fallback defaults in code): rejected because it scatters default logic across the codebase instead of having a single source of truth in storage.
- Breaking change requiring fresh install: rejected because it destroys user settings.

### R6: Settings hierarchy dependency implementation for grey-out

**Decision**: Define a static dependency tree as a data structure in the options page JS. Each node references its parent setting key. A recursive function computes the "effective enabled" state for each node: it's enabled only if its own toggle is on AND all ancestors are enabled. The UI iterates this tree to set `disabled` attributes on form controls.

**Rationale**: The hierarchy is static (doesn't change at runtime), so a simple tree data structure suffices. Computing enabled state recursively is O(n) for the number of settings (about 15), which is trivially fast. This avoids event-driven cascading updates that would be harder to reason about.

**Alternatives considered**:
- Event-driven cascading: each toggle's change handler walks down and disables children. Rejected because it requires careful ordering and is fragile when the hierarchy changes.
- CSS-only with `:has()` selectors: Chrome supports `:has()`, but it can't disable `<input>` elements (only style them). Still need JS to set the `disabled` attribute for proper form semantics.

### R7: Impact on existing `showGroupAge` field

**Decision**: The existing `showGroupAge` setting (currently a boolean on the settings object, defaulting to `false`) will be preserved as-is in storage. In the options page, it will be displayed under the new "Age in group title" label within the Aging hierarchy. No storage key change needed.

**Rationale**: Renaming storage keys would require migration logic for a purely cosmetic change. The UI label can differ from the storage key without issues.

**Alternatives considered**:
- Renaming the storage key to `ageInGroupTitle`: rejected because it adds migration complexity for no functional benefit.
