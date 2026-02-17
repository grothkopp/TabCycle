# Data Model: Extended Configuration

**Feature Branch**: `004-extended-config`
**Date**: 2026-02-16

## Entity: Settings (v2)

The settings object stored under `v1_settings` in `chrome.storage.local`. Schema version bumps from 1 to 2.

### Fields

| Field | Type | Default | Source | Description |
|-------|------|---------|--------|-------------|
| `timeMode` | `'active' \| 'wallclock'` | `'active'` | Existing | How tab age is calculated |
| `thresholds.greenToYellow` | `number` (ms, >0) | `14400000` (4h) | Existing | Age threshold for green→yellow transition |
| `thresholds.yellowToRed` | `number` (ms, >0) | `28800000` (8h) | Existing | Age threshold for yellow→red transition |
| `thresholds.redToGone` | `number` (ms, >0) | `86400000` (24h) | Existing | Age threshold for red→gone transition |
| `agingEnabled` | `boolean` | `true` | **New** | Master toggle for the aging system |
| `tabSortingEnabled` | `boolean` | `true` | **New** | Whether ungrouped tabs are sorted into special groups |
| `tabgroupSortingEnabled` | `boolean` | `true` | **New** | Whether user groups are zone-sorted |
| `tabgroupColoringEnabled` | `boolean` | `true` | **New** | Whether user group colors are updated |
| `showGroupAge` | `boolean` | `false` | Existing | Whether age suffix is appended to group titles |
| `greenToYellowEnabled` | `boolean` | `true` | **New** | Whether green→yellow transition fires |
| `yellowToRedEnabled` | `boolean` | `true` | **New** | Whether yellow→red transition fires |
| `redToGoneEnabled` | `boolean` | `true` | **New** | Whether red→gone transition fires |
| `yellowGroupName` | `string` | `''` | **New** | Custom title for the yellow special group |
| `redGroupName` | `string` | `''` | **New** | Custom title for the red special group |
| `bookmarkEnabled` | `boolean` | `true` | Existing | Whether gone tabs are bookmarked |
| `bookmarkFolderName` | `string` (non-empty) | `'Closed Tabs'` | Existing | Bookmark folder name |
| `autoGroupEnabled` | `boolean` | `true` | **New** | Whether new tabs are auto-grouped |
| `autoGroupNamingEnabled` | `boolean` | `true` | Existing | Whether unnamed groups are auto-named |
| `autoGroupNamingDelayMinutes` | `integer` (>0) | `5` | Existing | Delay before auto-naming fires |

### Validation Rules

1. `thresholds.greenToYellow < thresholds.yellowToRed < thresholds.redToGone` (existing rule, enforced even when transitions are disabled)
2. All boolean fields must be strictly `true` or `false`
3. `yellowGroupName` and `redGroupName` may be empty strings (valid); no maximum length enforced
4. `bookmarkFolderName` must be a non-empty string (existing rule)
5. `autoGroupNamingDelayMinutes` must be a positive integer (existing rule)

### Migration (v1 → v2)

When `v1_schemaVersion === 1`:
1. Add new fields with defaults:
   ```
   agingEnabled: true
   tabSortingEnabled: true
   tabgroupSortingEnabled: true
   tabgroupColoringEnabled: true
   greenToYellowEnabled: true
   yellowToRedEnabled: true
   redToGoneEnabled: true
   yellowGroupName: ''
   redGroupName: ''
   autoGroupEnabled: true
   ```
2. Preserve all existing fields unchanged
3. Update `v1_schemaVersion` to `2`

### State Transitions

```
Settings change detected (via chrome.storage.onChanged)
  ├── agingEnabled: false → true
  │   └── Apply age cap: set refreshTime = max(refreshTime, now - redToGone - 60000)
  │       for all tabs in tabMeta
  │
  ├── tabSortingEnabled: true → false
  │   └── Dissolve special groups in all windows:
  │       ├── chrome.tabs.ungroup() for all tabs in special groups
  │       └── Clear windowState.specialGroups.yellow/red
  │
  ├── tabSortingEnabled: false → true
  │   └── Next evaluation cycle recreates special groups based on current tab statuses
  │
  └── Any other toggle change
      └── Next evaluation cycle applies new behavior
```

## Entity: Settings Hierarchy (UI-only)

A static tree structure used exclusively by the options page to determine grey-out state. Not persisted to storage.

### Tree Structure

```
Root
├── Aging Section
│   ├── agingEnabled (master)
│   │   ├── timeMode
│   │   ├── tabSortingEnabled
│   │   ├── tabgroupSortingEnabled
│   │   ├── tabgroupColoringEnabled
│   │   ├── showGroupAge
│   │   ├── greenToYellowEnabled
│   │   │   ├── thresholds.greenToYellow
│   │   │   ├── yellowGroupName
│   │   │   ├── yellowToRedEnabled
│   │   │   │   ├── thresholds.yellowToRed
│   │   │   │   ├── redGroupName
│   │   │   │   ├── redToGoneEnabled
│   │   │   │   │   ├── thresholds.redToGone
│   │   │   │   │   ├── bookmarkEnabled
│   │   │   │   │   │   └── bookmarkFolderName
│   │   │   │   │   └── (end redToGoneEnabled)
│   │   │   │   └── (end yellowToRedEnabled)
│   │   │   └── (end greenToYellowEnabled)
│   │   └── (end agingEnabled)
│   └── (end Aging Section)
│
└── Auto-Tab-Groups Section
    ├── autoGroupEnabled (independent)
    ├── autoGroupNamingEnabled (independent)
    │   └── autoGroupNamingDelayMinutes
    └── (end Auto-Tab-Groups Section)
```

### Grey-out Rule

A control is disabled if **any ancestor** in the tree has its toggle set to `false`. The effective enabled state is:

```
effectiveEnabled(node) = node.value AND effectiveEnabled(node.parent)
effectiveEnabled(root) = true
```

## Entity: TabMeta (unchanged structure)

No schema changes to tabMeta. The `refreshActiveTime` and `refreshWallTime` fields continue to be used for age calculation. The age cap is applied by modifying these timestamps when aging is re-enabled (not by adding new fields).

## Entity: WindowState (unchanged structure)

No schema changes to windowState. The `specialGroups` references are cleared when tab sorting is disabled and repopulated when re-enabled.

## Entity: GROUP_CONFIG (modified)

The hardcoded `GROUP_CONFIG` in group-manager.js changes to read titles from settings:

**Before**:
```
GROUP_CONFIG = {
  yellow: { title: 'Yellow', color: 'yellow' },
  red: { title: 'Red', color: 'red' }
}
```

**After**: Titles are read from `settings.yellowGroupName` / `settings.redGroupName` at group creation/update time, not from a static config. The color remains hardcoded (it's the group's identity).
