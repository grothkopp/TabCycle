# Data Model: Manage Tab Lifecycle

**Branch**: `001-manage-tab-lifecycle` | **Date**: 2026-02-12

## Storage Schema Version

**Current**: `v1`
**Key**: `v1_schemaVersion` → `1`

On service worker startup, read `v1_schemaVersion`. If missing or outdated, run migration logic. Greenfield starts at version 1.

## Entities

### 1. Tab Metadata (`v1_tabMeta`)

Per-tab tracking data, stored as a map keyed by Chrome tab ID.

```
v1_tabMeta: {
  [tabId: number]: {
    tabId: number,                    // Chrome tab ID
    windowId: number,                 // Chrome window ID the tab belongs to
    refreshActiveTime: number,        // Global active-time value (ms) at last refresh (creation/navigation/reload)
    refreshWallTime: number,          // Wall-clock timestamp (ms since epoch) at last refresh
    status: "green" | "yellow" | "red",  // Current computed status (tabs at "gone" are removed)
    groupId: number | null,           // Chrome group ID if grouped, null if ungrouped
    isSpecialGroup: boolean,          // Whether the tab is in a special "Yellow" or "Red" group
    pinned: boolean                   // Cached pinned state (pinned tabs excluded from processing)
  }
}
```

**Lifecycle**:
- **Created**: When `chrome.tabs.onCreated` fires for a non-pinned tab
- **Updated**: On navigation/reload (`chrome.webNavigation.onCommitted`, frameId 0), on group change, on status transition
- **Deleted**: When tab is closed (`chrome.tabs.onRemoved`) or transitions to Gone

**Validation rules**:
- `tabId` must be a positive integer
- `refreshActiveTime` must be ≥ 0 and ≤ current global active time
- `refreshWallTime` must be ≥ 0 and ≤ `Date.now()`
- `status` must be one of: `"green"`, `"yellow"`, `"red"`
- Pinned tabs must not have status transitions applied

### 2. Active Time State (`v1_activeTime`)

Global active-time accumulator and focus tracking state.

```
v1_activeTime: {
  accumulatedMs: number,             // Total accumulated active time in milliseconds
  focusStartTime: number | null,     // Wall-clock timestamp when a window last gained focus (null if no window focused)
  lastPersistedAt: number            // Wall-clock timestamp of last storage write (for recovery)
}
```

**Lifecycle**:
- **Created**: On extension install (`chrome.runtime.onInstalled`)
- **Updated**: On every alarm tick (30s), on window focus change, on browser startup
- **Recovery**: On service worker restart, compute elapsed active time since `lastPersistedAt` if `focusStartTime` is not null (browser was focused when service worker suspended)

**Validation rules**:
- `accumulatedMs` must be ≥ 0
- `focusStartTime` must be null or a valid timestamp
- `lastPersistedAt` must be a valid timestamp

### 3. Settings (`v1_settings`)

User-configurable extension settings.

```
v1_settings: {
  timeMode: "active" | "wallclock",  // Time tracking mode (default: "active")
  thresholds: {
    greenToYellow: number,           // Duration in ms (default: 14400000 = 4 hours)
    yellowToRed: number,             // Duration in ms (default: 28800000 = 8 hours)
    redToGone: number                // Duration in ms (default: 86400000 = 24 hours)
  }
}
```

**Lifecycle**:
- **Created**: On extension install with defaults
- **Updated**: When user changes settings on the options page
- **Read**: On every evaluation cycle, on service worker startup

**Validation rules**:
- `timeMode` must be `"active"` or `"wallclock"`
- All thresholds must be positive integers (> 0)
- `greenToYellow` < `yellowToRed` < `redToGone` (enforced in options UI)

### 4. Window State (`v1_windowState`)

Per-window tracking of special group IDs and group zone assignments.

```
v1_windowState: {
  [windowId: number]: {
    specialGroups: {
      yellow: number | null,         // Chrome group ID of the special "Yellow" group (null if not present)
      red: number | null             // Chrome group ID of the special "Red" group (null if not present)
    },
    groupZones: {
      [groupId: number]: "green" | "yellow" | "red"  // Last known zone assignment per group
    }
  }
}
```

**Lifecycle**:
- **Created**: When a window is first encountered
- **Updated**: On special group creation/removal, on group zone changes
- **Deleted**: When window is closed (`chrome.windows.onRemoved`)

**Validation rules**:
- `windowId` must be a positive integer
- Special group IDs must reference valid existing groups (re-validated on startup)
- Zone values must be one of: `"green"`, `"yellow"`, `"red"`

### 5. Schema Version (`v1_schemaVersion`)

```
v1_schemaVersion: number             // Current schema version (starts at 1)
```

## State Transitions

### Tab Status Transitions

```
                    age >= greenToYellow         age >= yellowToRed          age >= redToGone
  [Created] → GREEN ──────────────────→ YELLOW ──────────────────→ RED ──────────────────→ GONE (closed)
                ↑                                                                 
                └──────────────── navigation/reload resets to GREEN ──────────────┘
```

- **GREEN → YELLOW**: Tab age exceeds `greenToYellow` threshold
  - If ungrouped: move to special "Yellow" group
  - If in user-created group: stay in group; group status may change
- **YELLOW → RED**: Tab age exceeds `yellowToRed` threshold
  - If in special "Yellow" group: move to special "Red" group
  - If in user-created group: stay in group; group status may change
- **RED → GONE**: Tab age exceeds `redToGone` threshold
  - If in special "Red" group: close the tab
  - If in user-created group: stay in group; group reaches Gone → close group + all tabs
- **Any → GREEN**: Navigation or reload resets refresh time
  - If in special "Yellow" or "Red" group: move out to appropriate green position

### Group Status (user-created groups only)

```
  Status = status of newest (freshest) tab in the group

  GREEN ←→ YELLOW ←→ RED → GONE (close group + all tabs)
```

- Special "Yellow" and "Red" groups have no group-level status
- Special groups are never sorted, never closed as a group

### Group Zone Sorting

```
  Tab bar layout per window:
  
  [Pinned tabs] | [GREEN zone] | [YELLOW zone] | [RED zone]
                                  ↑ special "Yellow"   ↑ special "Red"
                                    leftmost here        leftmost here
```

## Persistence Strategy

- **Write frequency**: Every alarm tick (30s) + on critical events (focus change, tab close, group change)
- **Batch writes**: Collect all changes during an evaluation cycle, write once at the end
- **Recovery**: On service worker wake, read all state from storage, validate, and reconcile with actual Chrome tab/group state via API queries
- **Cleanup**: Entries for closed tabs are removed. On startup, reconcile with `chrome.tabs.query({})` to remove stale entries. Tabs present in Chrome but missing from storage (e.g., tabs created while service worker was suspended) are added as fresh Green. Tabs present in both storage and Chrome retain their persisted metadata — restored tabs continue with their previous active time and status.
