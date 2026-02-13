# Data Model: Bookmark Closed Tabs

**Branch**: `002-bookmark-closed-tabs` | **Date**: 2026-02-13

## Storage Schema Version

**Current**: `v1` (no version bump — additive changes only)
**Key**: `v1_schemaVersion` → `1` (unchanged)

This feature extends the existing v1 schema with backward-compatible additions. No migration needed.

## New Entities

### 1. Bookmark State (`v1_bookmarkState`)

Tracks the bookmark folder's Chrome-internal ID for resilient lookup.

```
v1_bookmarkState: {
  folderId: string | null       // Chrome bookmark node ID of the "Closed Tabs" folder (null if not yet created)
}
```

**Lifecycle**:
- **Created**: On first bookmark save operation (when a tab first reaches Gone with bookmark saving enabled)
- **Updated**: When folder is created, rediscovered (after deletion), or when folder ID changes
- **Read**: On every bookmark save operation (to locate the folder by ID)
- **Persisted**: Survives browser restarts and service worker suspensions

**Validation rules**:
- `folderId` must be `null` or a non-empty string
- If non-null, must reference a valid bookmark node (verified on access; cleared if invalid)

## Modified Entities

### 2. Settings (`v1_settings`) — Extended

Two new optional fields added to the existing settings object.

```
v1_settings: {
  timeMode: "active" | "wallclock",
  thresholds: {
    greenToYellow: number,
    yellowToRed: number,
    redToGone: number
  },
  bookmarkEnabled: boolean,          // NEW: Enable/disable bookmark saving (default: true)
  bookmarkFolderName: string         // NEW: Name of the bookmark folder (default: "Closed Tabs")
}
```

**New fields**:

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `bookmarkEnabled` | `boolean` | `true` | Must be boolean |
| `bookmarkFolderName` | `string` | `"Closed Tabs"` | Must be non-empty string |

**Backward compatibility**: If `bookmarkEnabled` or `bookmarkFolderName` are missing from stored settings (e.g., after upgrade from feature 001), code reads them with fallback defaults (`true` and `"Closed Tabs"` respectively). No migration required.

**Lifecycle changes**:
- **Read by**: service-worker.js (every evaluation cycle — to check if bookmarks enabled), options.js (on page load)
- **Written by**: options.js (on user save — includes new fields)
- **Change event**: Service worker reacts to `chrome.storage.onChanged` for `v1_settings`; if `bookmarkFolderName` changed, the options page performs the folder rename before writing

## Unchanged Entities

The following entities from feature 001 are **not modified**:

- **Tab Metadata** (`v1_tabMeta`) — no changes
- **Active Time State** (`v1_activeTime`) — no changes
- **Window State** (`v1_windowState`) — no changes
- **Schema Version** (`v1_schemaVersion`) — remains at `1`

## Bookmark Tree Structure (Chrome Bookmarks, not extension storage)

This is the structure created in Chrome's bookmark tree, not in extension storage.

```
Other Bookmarks/                          # Chrome's built-in "Other Bookmarks" node
└── Closed Tabs/                          # Configurable name (FR-008), tracked by ID (FR-006/016)
    ├── Example Tab Title                 # Individual tab bookmark (FR-001/004)
    ├── Another Tab                       # Individual tab bookmark
    ├── My Research Group/                # Subfolder for a closed tab group (FR-002)
    │   ├── Research Paper 1              # Tab bookmark within group
    │   └── Research Paper 2              # Tab bookmark within group
    └── (unnamed)/                        # Subfolder for unnamed group (FR-003)
        ├── Tab A                         # Tab bookmark within unnamed group
        └── Tab B                         # Tab bookmark within unnamed group
```

**Rules**:
- Individual tabs (including those from the special "Red" group) → bookmarks directly in "Closed Tabs" folder
- User-created tab groups → subfolder named after the group, containing bookmarks for each tab
- Unnamed groups → subfolder named "(unnamed)"
- Multiple subfolders with the same name are permitted (separate group closures)
- Tabs with empty URL, `chrome://newtab`, or `about:blank` → skipped (FR-017)
- Tabs with no title → bookmark title falls back to the tab's URL

## Folder Lookup Algorithm

```
1. Read folderId from v1_bookmarkState
2. If folderId is not null:
   a. Call chrome.bookmarks.get(folderId)
   b. If found:
      - Compare folder.title with settings.bookmarkFolderName
      - If different: update settings.bookmarkFolderName to match (FR-018)
      - Return folder
   c. If not found (deleted): clear folderId, continue to step 3
3. Scan children of "Other Bookmarks" for a folder matching settings.bookmarkFolderName
   a. If found: store its ID in v1_bookmarkState, return folder
   b. If not found: continue to step 4
4. Create new folder under "Other Bookmarks" with title = settings.bookmarkFolderName
   a. Store new folder ID in v1_bookmarkState
   b. Return new folder
```

## Persistence Strategy

- **Bookmark state writes**: On folder creation, rediscovery, or ID change only (infrequent)
- **Settings writes**: On user save in options page (includes bookmark fields)
- **Bookmark creation**: Synchronous before tab removal (await `chrome.bookmarks.create()` then `chrome.tabs.remove()`)
- **Error isolation**: Each bookmark creation is independently try/caught; one failure does not block others or tab closure
