# Storage Contracts: Auto-Name Unnamed Groups

**Branch**: `003-auto-group-names` | **Version**: v1 (additive extension)

## Overview

This feature extends existing `v1` storage contracts with auto-group-naming settings and runtime group-naming metadata. Existing contracts remain valid.

---

## Contract: `v1_settings` (Extended)

**Purpose**: Persist user controls for auto-naming behavior.

```json
{
  "autoGroupNamingEnabled": true,
  "autoGroupNamingDelayMinutes": 5
}
```

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `autoGroupNamingEnabled` | `boolean` | `true` | Must be boolean |
| `autoGroupNamingDelayMinutes` | `number` | `5` | Positive whole number |

**Read by**: `service-worker.js`, `options.js`  
**Written by**: `options.js`  
**Change event**: `chrome.storage.onChanged` for `v1_settings` triggers immediate re-evaluation cycle.

**Backward compatibility**:
- Missing fields are interpreted as defaults (`true`, `5`).

---

## Contract: `v1_windowState` (Extended)

**Purpose**: Persist per-window runtime metadata needed to evaluate unnamed-group age and user-edit lock windows.

```json
{
  "1": {
    "specialGroups": { "yellow": 456, "red": null },
    "groupZones": { "789": "green" },
    "groupNaming": {
      "789": {
        "firstUnnamedSeenAt": 1708135200000,
        "lastAutoNamedAt": null,
        "lastCandidate": null,
        "userEditLockUntil": 1708135500000
      }
    }
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `groupNaming` | `object` | Optional map keyed by group ID string |
| `firstUnnamedSeenAt` | `number` | Positive timestamp |
| `lastAutoNamedAt` | `number \| null` | Positive timestamp or null |
| `lastCandidate` | `string \| null` | Null or 1-2 word candidate |
| `userEditLockUntil` | `number` | Positive timestamp |

**Read by**: `service-worker.js`, `group-manager.js` (during evaluation/sort/title update pass)  
**Written by**: `service-worker.js` / `group-manager.js` during cycle and group update events  
**Cleanup**: entries removed for non-existent groups during reconciliation.

---

## Event Flow Contracts

### Settings Save Flow

```text
Options Page                    chrome.storage              Service Worker
     |                               |                           |
     |-- writes v1_settings -------->|                           |
     |   (autoGroupNamingEnabled,    |                           |
     |    autoGroupNamingDelayMinutes)|                          |
     |                               |-- onChanged event ------->|
     |                               |                           |-- runEvaluationCycle()
```

### Evaluation + Naming Flow

```text
chrome.alarms                   Service Worker              group-manager
     |                               |                           |
     |-- onAlarm "tabcycle-eval" --->|                           |
     |                               |-- read v1_settings        |
     |                               |-- read v1_windowState     |
     |                               |-- sortTabsAndGroups() --->|
     |                               |-- updateGroupTitlesWithAge |
     |                               |-- auto-name pass --------->|
     |                               |   (base name only)         |
     |                               |-- write v1_windowState --->|
```

### User Group-Title Edit Flow

```text
chrome.tabGroups                Service Worker              chrome.storage
     |                               |                           |
     |-- onUpdated(group.title) ---->|                           |
     |                               |-- set userEditLockUntil   |
     |                               |   for groupNaming[groupId]|
     |                               |-- write v1_windowState --->|
```

---

## Migration Strategy

No migration required. This is additive:
- Existing installations continue working with fallback defaults.
- New runtime `groupNaming` map is created lazily when groups become eligible for tracking.
