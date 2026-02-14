# Storage Contracts: Manage Tab Lifecycle

**Branch**: `001-manage-tab-lifecycle` | **Version**: v1

## Overview

All extension state is persisted in `chrome.storage.local`. This document defines the contracts for each storage key, including shape, validation, defaults, and migration behavior.

Communication between the options page and service worker happens exclusively via `chrome.storage.onChanged` events — no direct messaging.

---

## Contract: `v1_schemaVersion`

**Purpose**: Track current storage schema version for migration support.

| Field | Type | Description |
|-------|------|-------------|
| (value) | `number` | Current schema version |

**Default**: `1`

**Read by**: service-worker.js (on startup)
**Written by**: service-worker.js (on install, on migration)

---

## Contract: `v1_settings`

**Purpose**: User-configurable extension settings.

```json
{
  "timeMode": "active",
  "thresholds": {
    "greenToYellow": 14400000,
    "yellowToRed": 28800000,
    "redToGone": 86400000
  }
}
```

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `timeMode` | `"active" \| "wallclock"` | `"active"` | Must be one of the two values |
| `thresholds.greenToYellow` | `number` (ms) | `14400000` (4h) | > 0 |
| `thresholds.yellowToRed` | `number` (ms) | `28800000` (8h) | > greenToYellow |
| `thresholds.redToGone` | `number` (ms) | `86400000` (24h) | > yellowToRed |

**Read by**: service-worker.js (every evaluation cycle), options.js (on page load)
**Written by**: options.js (on user save)
**Change event**: Service worker listens to `chrome.storage.onChanged` for `v1_settings` and re-evaluates all tabs immediately on change.

---

## Contract: `v1_activeTime`

**Purpose**: Global active-time accumulator state.

```json
{
  "accumulatedMs": 0,
  "focusStartTime": null,
  "lastPersistedAt": 1707753600000
}
```

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `accumulatedMs` | `number` (ms) | `0` | ≥ 0 |
| `focusStartTime` | `number \| null` | `null` | Valid timestamp or null |
| `lastPersistedAt` | `number` | `Date.now()` | Valid timestamp |

**Read by**: service-worker.js (on startup, on each evaluation)
**Written by**: service-worker.js (on focus change, on each alarm tick)

**Recovery protocol**: On service worker restart:
1. Read `v1_activeTime` from storage
2. If `focusStartTime !== null`, compute `delta = Date.now() - lastPersistedAt`
3. Add `delta` to `accumulatedMs` (approximate recovery of lost active time)
4. Update `lastPersistedAt = Date.now()`

---

## Contract: `v1_tabMeta`

**Purpose**: Per-tab lifecycle tracking metadata.

```json
{
  "123": {
    "tabId": 123,
    "windowId": 1,
    "refreshActiveTime": 3600000,
    "refreshWallTime": 1707753600000,
    "status": "green",
    "groupId": null,
    "isSpecialGroup": false,
    "pinned": false
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `tabId` | `number` | Positive integer, matches map key |
| `windowId` | `number` | Positive integer |
| `refreshActiveTime` | `number` (ms) | ≥ 0, ≤ current accumulatedMs |
| `refreshWallTime` | `number` (ms) | ≥ 0, ≤ Date.now() |
| `status` | `"green" \| "yellow" \| "red" \| "gone"` | "gone" is transient — tab is closed by `sortTabsAndGroups` in same cycle |
| `groupId` | `number \| null` | Chrome group ID or null |
| `isSpecialGroup` | `boolean` | True if in special Yellow/Red group |
| `pinned` | `boolean` | Pinned tabs are excluded from processing |

**Read by**: service-worker.js (every evaluation cycle)
**Written by**: service-worker.js (on tab events, on evaluation cycle)

**Cleanup**: Entries for closed tabs are removed. On startup, reconcile with `chrome.tabs.query({})`:
- Tabs in both storage and Chrome: retain persisted metadata (restored tabs keep their previous refresh times and status)
- Tabs in Chrome but not in storage: add as fresh Green
- Tabs in storage but not in Chrome: remove stale entries

---

## Contract: `v1_windowState`

**Purpose**: Per-window special group tracking and zone assignments.

```json
{
  "1": {
    "specialGroups": {
      "yellow": 456,
      "red": null
    },
    "groupZones": {
      "789": "green",
      "456": "yellow"
    }
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `windowId` (key) | `string` (number as string) | Positive integer |
| `specialGroups.yellow` | `number \| null` | Valid group ID or null |
| `specialGroups.red` | `number \| null` | Valid group ID or null |
| `groupZones[groupId]` | `"green" \| "yellow" \| "red" \| "gone"` | Zone assignment ("gone" entries cleaned up after group closure) |

**Read by**: service-worker.js (every evaluation cycle)
**Written by**: service-worker.js (on group create/remove/move, on evaluation cycle)

**Cleanup**: Entries for closed windows removed on `chrome.windows.onRemoved`. On startup, reconcile with `chrome.windows.getAll()`.

---

## Event Flow Contracts

### Settings Change Flow

```
Options Page                    chrome.storage              Service Worker
     |                               |                           |
     |-- writes v1_settings -------->|                           |
     |                               |-- onChanged event ------->|
     |                               |                           |-- re-evaluate all tabs
     |                               |                           |-- apply transitions
     |                               |<-- writes v1_tabMeta -----|
     |                               |<-- writes v1_windowState -|
```

### Alarm Evaluation Cycle Flow

```
chrome.alarms                   Service Worker              chrome.storage
     |                               |                           |
     |-- onAlarm "tabcycle-eval" --->|                           |
     |                               |-- read v1_activeTime ---->|
     |                               |-- read v1_settings ------>|
     |                               |-- read v1_tabMeta ------->|
     |                               |-- read v1_windowState --->|
     |                               |                           |
     |                               |-- compute status changes  |
     |                               |-- apply ALL transitions   |
     |                               |    (incl. gone) to tabMeta|
     |                               |-- build goneConfig with   |
     |                               |    bookmark callbacks     |
     |                               |-- per window:             |
     |                               |    sortTabsAndGroups()    |
     |                               |    (zone sort + gone      |
     |                               |     bookmark + close)     |
     |                               |                           |
     |                               |-- write v1_activeTime --->|
     |                               |-- write v1_tabMeta ------>|
     |                               |-- write v1_windowState -->|
```

### Tab Created Flow

```
chrome.tabs                     Service Worker              chrome.storage
     |                               |                           |
     |-- onCreated (tab) ---------->|                           |
     |                               |-- check if pinned         |
     |                               |-- determine active tab    |
     |                               |-- place in group (FR-008/009/033)
     |                               |-- create tab meta entry   |
     |                               |-- write v1_tabMeta ------>|
```

### Navigation/Reload Flow

```
chrome.webNavigation            Service Worker              chrome.storage
     |                               |                           |
     |-- onCommitted (frameId=0) -->|                           |
     |   OR                          |                           |
     |-- onHistoryStateUpdated ---->|                           |
     |   (SPA navigation)            |                           |
     |                               |-- debounce (200ms/tab)    |
     |                               |-- _handleNavigationEvent  |
     |                               |-- reset refreshActiveTime |
     |                               |-- reset refreshWallTime   |
     |                               |-- set status = "green"    |
     |                               |-- if in special group:    |
     |                               |     ungroup tab           |
     |                               |     remove empty special  |
     |                               |-- update group color      |
     |                               |-- sortTabsAndGroups()     |
     |                               |-- write v1_tabMeta ------>|
     |                               |-- write v1_windowState -->|
```

---

## Migration Strategy

### v1 (initial)

No migration needed. All keys created with defaults on `chrome.runtime.onInstalled`.

### Future versions

1. Read `v1_schemaVersion`
2. If < target version, run sequential migration functions
3. Each migration: read old keys → transform → write new keys → update schema version
4. Atomic: if migration fails, retain old data and log error
