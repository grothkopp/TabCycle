# Quickstart: Extended Configuration

**Feature Branch**: `004-extended-config`
**Date**: 2026-02-16

## What This Feature Does

Adds granular configuration to every aspect of the TabCycle extension. Users can independently toggle aging, sorting (tab-level and group-level), coloring, transitions, special group names, and auto-grouping. The settings page is reorganized into a hierarchical layout where disabling a parent feature greys out all child options.

## Files to Modify

### Settings Schema & Defaults
1. **`src/shared/constants.js`** — Add new default constants for all new toggles
2. **`src/shared/schemas.js`** — Extend `validateSettings()` for new fields

### Background Logic
3. **`src/background/service-worker.js`** —
   - Update `defaultSettings` for fresh installs (schema v2)
   - Add migration logic in `onInstalled` for v1→v2 upgrade
   - Gate `evaluateAllTabs()` on `agingEnabled`
   - Gate `placeNewTab()` on `autoGroupEnabled`
   - Gate `showGroupAge` logic on `agingEnabled`
   - Detect settings changes and handle reactive behaviors (dissolve groups, apply age cap)
4. **`src/background/status-evaluator.js`** — Gate each transition on its toggle (`greenToYellowEnabled`, `yellowToRedEnabled`, `redToGoneEnabled`)
5. **`src/background/group-manager.js`** —
   - Read `yellowGroupName`/`redGroupName` from settings for special group titles
   - Gate `updateGroupColor()` on `tabgroupColoringEnabled`
   - Gate special group creation on `tabSortingEnabled`
   - Gate group zone-sorting on `tabgroupSortingEnabled`
   - Add dissolution logic for special groups
   - Listen for `chrome.tabGroups.onUpdated` to detect user renames of special groups
6. **`src/background/tab-placer.js`** — Gate placement logic on `autoGroupEnabled`

### Options Page
7. **`src/options/options.html`** — Complete restructure into two-section hierarchical layout
8. **`src/options/options.js`** —
   - Load/save all new settings
   - Implement grey-out dependency tree
   - Handle collapsible detail sections
9. **`src/options/options.css`** — Styles for hierarchy, grey-out, collapsible sections

### Tests
10. **`tests/unit/schemas.test.js`** — Validate new settings fields
11. **`tests/unit/status-evaluator.test.js`** — Test transition gating
12. **`tests/unit/group-manager.test.js`** — Test sorting/coloring gates, dissolution
13. **`tests/unit/tab-placer.test.js`** — Test autogroup gating
14. **`tests/integration/settings-migration.test.js`** — New: v1→v2 migration
15. **`tests/integration/toggle-combinations.test.js`** — New: feature interactions
16. **`tests/e2e-chrome/feature-toggles.test.js`** — New: full E2E for toggle behaviors
17. **`tests/e2e-chrome/settings-persistence.test.js`** — Extend for new fields
18. **`tests/e2e/settings-change.test.js`** — Extend for new settings page UI

## Implementation Order

1. **Schema first**: Constants, defaults, validation, migration
2. **Background logic**: Gate existing functions on new toggles
3. **Reactive behaviors**: Dissolution, age cap, rename detection
4. **Options page**: HTML restructure, JS logic, CSS
5. **Tests**: Unit → Integration → E2E

## Key Design Decisions

- **Age clock never stops**: `refreshActiveTime`/`refreshWallTime` timestamps continue accumulating regardless of config. Only the evaluation pipeline checks toggles.
- **Age cap at re-enable**: When aging is re-enabled, tab timestamps are adjusted so no tab appears older than `redToGone + 1 min`. This is a one-time adjustment, not ongoing.
- **Special group dissolution is immediate**: Disabling tab sorting ungroups tabs from special groups synchronously, not on the next cycle.
- **Collapsible sections via native HTML**: `<details>/<summary>` elements, no JS framework.
- **No new permissions**: All new functionality uses existing Chrome APIs (`tabs`, `tabGroups`, `storage`).
