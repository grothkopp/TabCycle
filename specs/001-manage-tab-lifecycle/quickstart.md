# Quickstart: TabCycle Extension

**Branch**: `001-manage-tab-lifecycle` | **Date**: 2026-02-12

## Prerequisites

- Google Chrome (version 89+ for `chrome.tabGroups` API support)
- Node.js 18+ and npm (for running tests)
- Git

## Project Setup

```bash
# Clone and switch to feature branch
git clone <repo-url>
cd TabCycle
git checkout 001-manage-tab-lifecycle

# Install dev dependencies (testing only — no runtime dependencies)
npm install
```

## Loading the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `src/` directory from the project root
5. The TabCycle extension icon should appear in the toolbar

## Extension Permissions

TabCycle requests the following permissions (all documented in the implementation plan):

| Permission | Purpose |
|------------|---------|
| `tabs` | Read tab state, move tabs, query tabs |
| `tabGroups` | Create, update, move, and query tab groups |
| `storage` | Persist tab metadata, settings, and active-time state |
| `alarms` | 30-second periodic evaluation cycle |
| `webNavigation` | Detect all navigation types including same-URL reloads |

No host permissions or content scripts are used.

## Configuration

1. Right-click the TabCycle extension icon → **Options** (or go to `chrome://extensions/` → TabCycle → Details → Extension options)
2. Configure:
   - **Time tracking mode**: Active time (default) or wall-clock time
   - **Green → Yellow threshold**: Duration before a tab turns Yellow (default: 4 hours)
   - **Yellow → Red threshold**: Duration before a tab turns Red (default: 8 hours)
   - **Red → Gone threshold**: Duration before a tab is closed (default: 24 hours)
3. Thresholds can be specified in minutes, hours, or days

## How It Works

### Tab Lifecycle

Every 30 seconds, TabCycle evaluates all non-pinned tabs:

1. **Green** (fresh) — newly created or recently navigated tabs
2. **Yellow** (aging) — tabs that haven't been navigated in a while
3. **Red** (stale) — tabs approaching expiration
4. **Gone** (expired) — tabs are automatically closed

### Active Time vs Wall Clock

- **Active time** (default): Only counts time when you're actively using Chrome. Leaving the browser overnight doesn't age your tabs.
- **Wall clock**: Standard elapsed time. Tabs age regardless of browser activity.

### Tab Groups

- Ungrouped tabs that turn Yellow are moved to a special "Yellow" group
- Tabs in "Yellow" that turn Red are moved to a special "Red" group
- Tabs in "Red" that reach Gone are closed
- Tab groups are color-coded and sorted: Green (left) → Yellow (middle) → Red (right)
- User-created groups are managed as a unit — individual tabs stay in their group

### New Tab Behavior

- Opening a tab while a grouped tab is active: new tab joins the same group
- Opening a tab while in "Yellow"/"Red" group: new tab created fresh at the far left
- Opening a tab while an ungrouped tab is active: both tabs are placed in a new group

## Running Tests

```bash
# Unit tests (pure logic, mocked Chrome APIs)
npm test -- --testPathPattern=unit

# Integration tests (storage, alarms, service worker restart)
npm test -- --testPathPattern=integration

# E2E tests (requires Chrome, loads actual extension)
npm test -- --testPathPattern=e2e

# All tests
npm test
```

## Project Structure

```
src/
├── manifest.json                # Manifest V3 configuration
├── background/
│   ├── service-worker.js        # Entry point: alarm setup, event listeners
│   ├── tab-tracker.js           # Tab refresh-time tracking
│   ├── time-accumulator.js      # Global active-time counter
│   ├── status-evaluator.js      # Status calculation (Green/Yellow/Red/Gone)
│   ├── group-manager.js         # Group creation, colors, zone sorting
│   ├── tab-placer.js            # New tab placement logic
│   └── state-persistence.js     # chrome.storage read/write and recovery
├── options/
│   ├── options.html             # Settings page
│   ├── options.js               # Settings logic
│   └── options.css              # Settings styling
└── shared/
    ├── constants.js             # Enums, defaults, storage keys, error codes
    ├── logger.js                # Structured logging
    └── schemas.js               # Storage schema validation
```

## Debugging

- Open `chrome://extensions/` → TabCycle → **Inspect views: service worker** to see background logs
- All logs use structured format: `{ timestamp, severity, context, correlationId, message, data }`
- Error codes are prefixed with `ERR_` (e.g., `ERR_STORAGE_WRITE`, `ERR_GROUP_CREATE`)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Tabs not aging | Check if time mode is "active" and Chrome has focus |
| Groups not sorting | Verify `tabGroups` permission is granted |
| State lost after restart | Check `chrome.storage.local` via DevTools → Application → Storage |
| Alarm not firing | Check `chrome://extensions/` → service worker is active |
| Extension not loading | Ensure `src/manifest.json` exists and is valid JSON |
