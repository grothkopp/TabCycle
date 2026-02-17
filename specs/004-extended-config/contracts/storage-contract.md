# Storage Contract: Settings v2

**Feature Branch**: `004-extended-config`
**Date**: 2026-02-16

## Overview

This contract defines the storage schema changes for the extended configuration feature. The extension uses `chrome.storage.local` with a single settings object under key `v1_settings`.

## Schema Version

**Previous**: 1
**New**: 2

## Settings Object Schema (v2)

```javascript
{
  // Time & Thresholds (existing)
  timeMode: 'active' | 'wallclock',
  thresholds: {
    greenToYellow: number,  // ms, > 0
    yellowToRed: number,    // ms, > greenToYellow
    redToGone: number       // ms, > yellowToRed
  },

  // Core Feature Toggles (NEW)
  agingEnabled: boolean,           // default: true
  tabSortingEnabled: boolean,      // default: true
  tabgroupSortingEnabled: boolean, // default: true
  tabgroupColoringEnabled: boolean,// default: true

  // Transition Toggles (NEW)
  greenToYellowEnabled: boolean,   // default: true
  yellowToRedEnabled: boolean,     // default: true
  redToGoneEnabled: boolean,       // default: true

  // Special Group Names (NEW)
  yellowGroupName: string,         // default: '' (empty)
  redGroupName: string,            // default: '' (empty)

  // Auto-Tab-Groups (NEW + existing) — autoGroupEnabled and autoGroupNamingEnabled are independent siblings
  autoGroupEnabled: boolean,       // default: true (NEW) — controls new tab placement
  autoGroupNamingEnabled: boolean,  // default: true (existing) — controls naming of ANY group, independent of autoGroupEnabled
  autoGroupNamingDelayMinutes: number, // default: 5, integer > 0 (existing) — child of autoGroupNamingEnabled only

  // Bookmarking (existing)
  bookmarkEnabled: boolean,        // default: true
  bookmarkFolderName: string,      // default: 'Closed Tabs', non-empty

  // Display (existing)
  showGroupAge: boolean            // default: false
}
```

## Migration Contract

### Trigger
`chrome.runtime.onInstalled` with `reason: 'update'` AND `v1_schemaVersion === 1`

### Steps
1. Read current `v1_settings`
2. Merge new fields (only add fields that don't already exist):
   ```javascript
   const migrated = {
     ...currentSettings,
     agingEnabled: currentSettings.agingEnabled ?? true,
     tabSortingEnabled: currentSettings.tabSortingEnabled ?? true,
     tabgroupSortingEnabled: currentSettings.tabgroupSortingEnabled ?? true,
     tabgroupColoringEnabled: currentSettings.tabgroupColoringEnabled ?? true,
     greenToYellowEnabled: currentSettings.greenToYellowEnabled ?? true,
     yellowToRedEnabled: currentSettings.yellowToRedEnabled ?? true,
     redToGoneEnabled: currentSettings.redToGoneEnabled ?? true,
     yellowGroupName: currentSettings.yellowGroupName ?? '',
     redGroupName: currentSettings.redGroupName ?? '',
     autoGroupEnabled: currentSettings.autoGroupEnabled ?? true,
   };
   ```
3. Write `v1_settings` with merged object
4. Update `v1_schemaVersion` to `2`

### Rollback
Not applicable — migration is additive-only. Old extension versions ignore unknown fields.

## Event Contract: Settings Change Detection

### Source
`chrome.storage.onChanged` listener in service-worker.js

### Reactive Behaviors

| Changed Field | Immediate Action | Next Cycle Action |
|---------------|-----------------|-------------------|
| `agingEnabled` (false→true) | Apply age cap to all tabMeta entries | Evaluate all tabs with new statuses |
| `agingEnabled` (true→false) | None (tabs freeze in current state) | Skip status evaluation |
| `tabSortingEnabled` (true→false) | Dissolve all special groups | Skip tab sorting |
| `tabSortingEnabled` (false→true) | None | Recreate special groups from tab statuses |
| `tabgroupSortingEnabled` | None | Skip/resume group zone-sorting |
| `tabgroupColoringEnabled` | None | Skip/resume group color updates |
| `greenToYellowEnabled` | None | Cap status at green if disabled |
| `yellowToRedEnabled` | None | Cap status at yellow if disabled |
| `redToGoneEnabled` | None | Cap status at red if disabled |
| `yellowGroupName` | Update existing yellow group title | — |
| `redGroupName` | Update existing red group title | — |
| `autoGroupEnabled` | None | Skip/resume new tab placement |
| `autoGroupNamingEnabled` | None | Skip/resume auto-naming of groups (independent of autoGroupEnabled) |
| All other fields | None | Applied on next relevant action |

## Age Cap Contract

### Trigger
`agingEnabled` changes from `false` to `true`

### Algorithm
```
capTimestamp = now - (settings.thresholds.redToGone + 60000)

for each tab in tabMeta:
  if tab.refreshActiveTime < capTimestamp (for active time mode):
    tab.refreshActiveTime = capTimestamp
  if tab.refreshWallTime < capTimestamp (for wall clock mode):
    tab.refreshWallTime = capTimestamp
```

### Effect
After capping, `computeAge()` for any tab returns at most `redToGone + 1 minute`, which puts the tab in the "red" state (not "gone"). The user then has a full `redToGone` threshold worth of time before the tab transitions to gone.
