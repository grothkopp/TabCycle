# Quickstart: Bookmark Closed Tabs

**Branch**: `002-bookmark-closed-tabs` | **Date**: 2026-02-13

## Prerequisites

- Google Chrome (version 89+ for `chrome.tabGroups` API support)
- Node.js 18+ and npm (for running tests)
- Git
- TabCycle extension loaded from feature 001 (or fresh install)

## Project Setup

```bash
# Clone and switch to feature branch
git clone <repo-url>
cd TabCycle
git checkout 002-bookmark-closed-tabs

# Install dev dependencies (testing only — no runtime dependencies)
npm install
```

## Loading / Updating the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. If TabCycle is already loaded: click the **reload** button on the extension card
4. If loading fresh: click **Load unpacked** and select the `src/` directory
5. The TabCycle extension icon should appear in the toolbar

## Extension Permissions

TabCycle now requests the following permissions:

| Permission | Purpose |
|------------|---------|
| `tabs` | Read tab state, move tabs, query tabs |
| `tabGroups` | Create, update, move, and query tab groups |
| `storage` | Persist tab metadata, settings, and active-time state |
| `alarms` | 30-second periodic evaluation cycle |
| `webNavigation` | Detect all navigation types including same-URL reloads |
| **`bookmarks`** | **NEW: Create bookmarks for tabs closed by TabCycle** |

No host permissions or content scripts are used.

## New Configuration: Bookmark Settings

1. Right-click the TabCycle extension icon → **Options**
2. Scroll to the **Bookmark Closed Tabs** section
3. Configure:
   - **Save closed tabs as bookmarks**: Toggle on/off (default: on)
   - **Bookmark folder name**: Text input (default: "Closed Tabs")
4. Click **Save Settings**

### How Bookmark Saving Works

When TabCycle automatically closes a tab or tab group because it reached the "Gone" state:

- **Individual tabs**: A bookmark is created in the "Closed Tabs" folder (under "Other Bookmarks") with the tab's title and URL
- **Tab groups**: A subfolder is created inside "Closed Tabs" named after the group, containing a bookmark for each tab in the group
- **Unnamed groups**: The subfolder is named "(unnamed)"
- **Empty tabs**: Tabs with `chrome://newtab`, `about:blank`, or empty URLs are closed without creating a bookmark

### Folder Management

- The bookmark folder is created automatically on first use
- If you rename the folder in Chrome's bookmark manager, the extension detects the change and updates the setting
- If you change the folder name in settings, the existing folder is renamed (bookmarks preserved)
- If you delete the folder, the extension recreates it on the next tab close

## Existing Configuration (from Feature 001)

All existing settings remain unchanged:

- **Time tracking mode**: Active time (default) or wall-clock time
- **Green → Yellow threshold**: Default 4 hours
- **Yellow → Red threshold**: Default 8 hours
- **Red → Gone threshold**: Default 24 hours

## Running Tests

```bash
# All tests
npm test

# Unit tests only (includes bookmark-manager tests)
npm test -- --testPathPattern=unit

# Integration tests only (includes bookmark lifecycle tests)
npm test -- --testPathPattern=integration

# E2E tests only (includes bookmark saving flow)
npm test -- --testPathPattern=e2e
```

## Project Structure (Changes from Feature 001)

```
src/
├── manifest.json                # +bookmarks permission
├── background/
│   ├── service-worker.js        # Modified: bookmark creation before tab/group close
│   ├── bookmark-manager.js      # NEW: bookmark folder management, bookmark creation
│   └── [other files unchanged]
├── options/
│   ├── options.html             # Modified: bookmark settings section
│   ├── options.js               # Modified: bookmark toggle + folder name settings
│   └── options.css              # Minor styling additions
└── shared/
    ├── constants.js             # Modified: new storage key, defaults, error codes
    └── schemas.js               # Modified: validation for new settings fields

tests/
├── unit/
│   └── bookmark-manager.test.js # NEW
├── integration/
│   └── bookmark-lifecycle.test.js # NEW
└── e2e/
    └── bookmark-saving.test.js  # NEW
```

## Debugging

- Open `chrome://extensions/` → TabCycle → **Inspect views: service worker** to see background logs
- Bookmark operations log with error codes: `ERR_BOOKMARK_CREATE`, `ERR_BOOKMARK_FOLDER`, `ERR_BOOKMARK_RENAME`
- Check `chrome://bookmarks/` to verify bookmarks are created in the correct folder
- Check `chrome.storage.local` via DevTools → Application → Storage for `v1_bookmarkState` and `v1_settings`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bookmarks not being created | Check that "Save closed tabs as bookmarks" is enabled in settings |
| Bookmark folder not found | Check "Other Bookmarks" in Chrome's bookmark manager |
| Folder name not updating | Reload the options page; check `v1_bookmarkState.folderId` in storage |
| Permission error in logs | Verify `bookmarks` is listed in `manifest.json` permissions |
| Empty tabs being bookmarked | Verify `bookmark-manager.js` URL blocklist includes the URL |
| Old bookmarks missing after rename | Bookmarks are preserved on rename; check the renamed folder |
