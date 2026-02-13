# Storage Contracts: Bookmark Closed Tabs

**Branch**: `002-bookmark-closed-tabs` | **Version**: v1 (additive extension)

## Overview

This document defines the storage contract changes for the bookmark-closed-tabs feature. It extends the existing v1 storage schema with backward-compatible additions. All existing contracts from feature 001 remain unchanged.

Communication between the options page and service worker continues via `chrome.storage.onChanged` events.

---

## Contract: `v1_settings` (Extended)

**Purpose**: User-configurable extension settings — now includes bookmark settings.

```json
{
  "timeMode": "active",
  "thresholds": {
    "greenToYellow": 14400000,
    "yellowToRed": 28800000,
    "redToGone": 86400000
  },
  "bookmarkEnabled": true,
  "bookmarkFolderName": "Closed Tabs"
}
```

### New Fields

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `bookmarkEnabled` | `boolean` | `true` | Must be boolean |
| `bookmarkFolderName` | `string` | `"Closed Tabs"` | Must be non-empty string |

**Backward compatibility**: Both fields are optional. If missing (upgrade from feature 001), code uses defaults: `bookmarkEnabled = true`, `bookmarkFolderName = "Closed Tabs"`.

**Read by**: service-worker.js (every evaluation cycle), options.js (on page load)
**Written by**: options.js (on user save)
**Change event**: Service worker listens to `chrome.storage.onChanged` for `v1_settings`. Options page performs folder rename via `chrome.bookmarks.update()` before writing new settings when `bookmarkFolderName` changes.

---

## Contract: `v1_bookmarkState` (New)

**Purpose**: Track the Chrome bookmark folder ID used for storing closed-tab bookmarks.

```json
{
  "folderId": "42"
}
```

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `folderId` | `string \| null` | `null` | Valid Chrome bookmark node ID or null |

**Read by**: service-worker.js (on bookmark save), options.js (on folder rename)
**Written by**: service-worker.js (on folder creation/discovery), options.js (if folder is created during rename)

**Validation**: On read, verify the stored ID references an existing bookmark node via `chrome.bookmarks.get()`. If invalid, clear to `null` and fall back to name-based lookup.

---

## Event Flow Contracts

### Tab Close with Bookmark Flow

```
chrome.alarms                   Service Worker              chrome.storage / chrome.bookmarks
     |                               |                           |
     |-- onAlarm "tabcycle-eval" --->|                           |
     |                               |-- read v1_settings ------>|
     |                               |-- check bookmarkEnabled   |
     |                               |                           |
     |                               |  [if enabled]             |
     |                               |-- read v1_bookmarkState ->|
     |                               |-- resolve folder (by ID,  |
     |                               |   then name, then create) |
     |                               |                           |
     |                               |  [for each gone tab]      |
     |                               |-- check URL blocklist     |
     |                               |-- chrome.bookmarks.create |
     |                               |   (title, url, parentId)  |
     |                               |                           |
     |                               |-- chrome.tabs.remove ---->|
     |                               |-- write v1_tabMeta ------>|
     |                               |-- write v1_bookmarkState >|
```

### Group Close with Bookmark Flow

```
Service Worker                  chrome.bookmarks            chrome.tabs
     |                               |                           |
     |  [group reached Gone]         |                           |
     |-- create subfolder ---------->|                           |
     |   (parentId=folder,           |                           |
     |    title=groupName)           |                           |
     |                               |                           |
     |  [for each tab in group]      |                           |
     |-- check URL blocklist         |                           |
     |-- chrome.bookmarks.create --->|                           |
     |   (parentId=subfolder)        |                           |
     |                               |                           |
     |-- chrome.tabs.remove -------->|                           |
     |-- chrome.tabGroups.remove? -->|  (auto-removed when empty)|
```

### Settings Save with Folder Rename Flow

```
Options Page                    chrome.bookmarks            chrome.storage
     |                               |                           |
     |-- read v1_bookmarkState ----->|                           |
     |                               |                           |
     |  [if folderName changed       |                           |
     |   AND folderId exists]        |                           |
     |-- chrome.bookmarks.update --->|                           |
     |   (folderId, {title: new})    |                           |
     |                               |                           |
     |-- write v1_settings --------->|                           |
     |                               |-- onChanged event ------->| (service worker)
```

### External Folder Rename Detection Flow

```
Service Worker                  chrome.bookmarks            chrome.storage
     |                               |                           |
     |  [bookmark save operation]    |                           |
     |-- chrome.bookmarks.get ------>|                           |
     |   (stored folderId)           |                           |
     |                               |                           |
     |  [folder.title != stored      |                           |
     |   bookmarkFolderName]         |                           |
     |-- update v1_settings -------->|                           |
     |   (bookmarkFolderName =       |                           |
     |    folder.title)              |                           |
```

---

## Migration Strategy

### From feature 001 (v1 without bookmark fields)

No migration needed. The code reads `bookmarkEnabled` and `bookmarkFolderName` from `v1_settings` with fallback defaults. The `v1_bookmarkState` key is created on first use.

### Future versions

If bookmark settings need breaking changes, follow the existing v1→v2 migration pattern: read old keys, transform, write new keys, update schema version.
