# Bookmark API Contract: Bookmark Closed Tabs

**Branch**: `002-bookmark-closed-tabs` | **Version**: v1

## Overview

This document defines how the extension interacts with the `chrome.bookmarks` API. It covers which API methods are used, by which context, and the expected inputs/outputs.

---

## API: `chrome.bookmarks.getTree()`

**Used by**: bookmark-manager.js (service worker), options.js (options page)
**Purpose**: Discover the "Other Bookmarks" node ID.

**Usage**:
```
const tree = await chrome.bookmarks.getTree();
const otherBookmarks = tree[0].children.find(node => node.title === "Other Bookmarks");
// otherBookmarks.id is the parent for our folder
```

**Notes**:
- Called once per service worker lifecycle (cached after first call)
- The "Other Bookmarks" node is typically `id: "2"` but discovered dynamically for robustness
- Returns the full bookmark tree; only the top-level children are inspected

---

## API: `chrome.bookmarks.get(id)`

**Used by**: bookmark-manager.js (service worker), options.js (options page)
**Purpose**: Verify a stored folder ID is still valid; read current folder title for rename detection.

**Input**: `id` — string, the stored bookmark folder ID from `v1_bookmarkState`

**Success output**: Array with one `BookmarkTreeNode` — folder exists, read its `title`
**Failure**: Throws if ID doesn't exist — triggers fallback to name-based lookup

---

## API: `chrome.bookmarks.getChildren(id)`

**Used by**: bookmark-manager.js (service worker)
**Purpose**: Scan children of "Other Bookmarks" to find the bookmark folder by name (fallback lookup).

**Input**: `id` — string, the "Other Bookmarks" node ID

**Output**: Array of `BookmarkTreeNode` — filter for `node.url === undefined && node.title === folderName`

---

## API: `chrome.bookmarks.create(createDetails)`

**Used by**: bookmark-manager.js (called from group-manager.js `sortTabsAndGroups` via `goneConfig` callbacks, and from service worker for folder resolution)
**Purpose**: Create bookmark folders, group subfolders, and individual bookmarks.

### Creating the root bookmark folder

```json
{
  "parentId": "<otherBookmarksId>",
  "title": "Closed Tabs"
}
```
- No `url` field → creates a folder
- Returns `BookmarkTreeNode` with the new folder's `id`

### Creating a group subfolder

```json
{
  "parentId": "<bookmarkFolderId>",
  "title": "My Group Name"
}
```
- Group name from `chrome.tabGroups` title, or `"(unnamed)"` if empty
- No `url` field → creates a subfolder

### Creating a tab bookmark

```json
{
  "parentId": "<folderId or subfolderId>",
  "title": "Page Title",
  "url": "https://example.com"
}
```
- `title`: from `tab.title`, falling back to `tab.url` if title is empty/undefined
- `url`: from `tab.url`
- `parentId`: root folder ID for individual tabs, subfolder ID for group tabs

---

## API: `chrome.bookmarks.update(id, changes)`

**Used by**: options.js (options page)
**Purpose**: Rename the bookmark folder when the user changes the folder name in settings (FR-010).

**Input**:
```json
{
  "title": "New Folder Name"
}
```

**Called when**: User saves settings with a different `bookmarkFolderName` than the current value.

**Error handling**: If the folder ID is invalid (folder was deleted), the rename is silently skipped and the new name is stored in settings for future folder creation.

---

## URL Blocklist

Tabs with the following URLs are **not** bookmarked (FR-017):

| URL | Reason |
|-----|--------|
| `""` (empty string) | No content |
| `"chrome://newtab"` | Default new tab page |
| `"chrome://newtab/"` | Variant with trailing slash |
| `"about:blank"` | Blank page |

The check is performed in `bookmark-manager.js` before calling `chrome.bookmarks.create()`.

---

## Permission Requirement

```json
{
  "permissions": ["bookmarks"]
}
```

**Rationale**: Required for all `chrome.bookmarks.*` API calls. No host permissions needed.

**Graceful degradation**: If the `bookmarks` permission is somehow unavailable at runtime, all bookmark operations fail silently (logged as warnings) and tab closure proceeds normally per FR-012.

---

## Error Codes

| Code | Trigger | Severity |
|------|---------|----------|
| `ERR_BOOKMARK_CREATE` | `chrome.bookmarks.create()` fails | warn |
| `ERR_BOOKMARK_FOLDER` | Folder lookup/creation fails | warn |
| `ERR_BOOKMARK_RENAME` | `chrome.bookmarks.update()` fails during rename | warn |

All errors are logged with the tab URL (for `ERR_BOOKMARK_CREATE`) or folder name (for `ERR_BOOKMARK_FOLDER` / `ERR_BOOKMARK_RENAME`) and the error message. Tab closure is never blocked by bookmark errors.
