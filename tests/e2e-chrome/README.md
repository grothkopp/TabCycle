# E2E Chrome Tests

End-to-end tests that launch a **real Chrome instance** with the TabCycle extension loaded and observe actual browser outcomes (tab status, grouping, sorting, bookmarks, etc.) via Puppeteer + Chrome DevTools Protocol.

## Prerequisites

1. **Chrome or Chromium** installed on your machine
2. **Puppeteer** (already in `devDependencies`)
3. Set the Chrome binary path via environment variable:

```bash
# macOS (typical path)
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# or use Puppeteer's env var
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Linux
export CHROME_PATH="/usr/bin/google-chrome"
```

## Running

```bash
# Run all e2e-chrome tests (serial, 60s timeout per test)
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e-chrome

# Run a single test file
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npx jest --testPathPattern=tests/e2e-chrome/status-transitions --testTimeout=60000 --runInBand

# Run with Node ESM support (already configured in npm script)
node --experimental-vm-modules node_modules/.bin/jest \
  --testPathPattern=tests/e2e-chrome/ --testTimeout=60000 --runInBand
```

> **Note:** Tests run with `--runInBand` (serial) because each test file launches its own Chrome instance. Running in parallel would spawn many Chrome processes.

## Architecture

```
tests/e2e-chrome/
├── harness.js                    # Shared test harness (browser launch, helpers)
├── status-transitions.test.js    # green → yellow → red → gone
├── tab-grouping.test.js          # Ungrouped tabs → Yellow/Red special groups
├── group-sorting.test.js         # Zone order: green < yellow < red
├── navigation-reset.test.js      # Navigate resets to green, ungroups from special
├── tab-placement.test.js         # New tab placement (context tab rules)
├── gone-and-bookmarks.test.js    # Gone handling: close + bookmark
├── settings-persistence.test.js  # Options page, settings → re-evaluation
├── group-dissolution.test.js     # Unnamed single-tab groups dissolved
├── edge-cases.test.js            # Pinned tabs, rapid creation, empty state
└── README.md                     # This file
```

### Harness (`harness.js`)

The harness provides:

| Helper | Description |
|--------|-------------|
| `createHarness()` | Launches Chrome with extension, returns harness object |
| `h.readStorage(keys)` | Read from `chrome.storage.local` via service worker |
| `h.writeStorage(data)` | Write to `chrome.storage.local` via service worker |
| `h.getTabMeta()` | Read the `v1_tabMeta` storage key |
| `h.getWindowState()` | Read the `v1_windowState` storage key |
| `h.getSettings()` | Read the `v1_settings` storage key |
| `h.setFastThresholds(opts)` | Set very short thresholds for fast testing |
| `h.backdateTab(tabId, ageMs)` | Make a tab appear `ageMs` old without waiting |
| `h.triggerEvaluation()` | Fire the alarm to trigger an evaluation cycle |
| `h.openTab(url)` | Open a new tab, return its ID |
| `h.openTabs(count, url)` | Open multiple tabs |
| `h.closeTab(tabId)` | Close a tab |
| `h.navigateTab(tabId, url)` | Navigate a tab to a new URL |
| `h.queryTabs(opts)` | Query Chrome tabs |
| `h.queryGroups(windowId)` | Query tab groups |
| `h.getGroup(groupId)` | Get a single group |
| `h.createUserGroup(tabIds, title)` | Create a named tab group |
| `h.getBookmarksInFolder(name)` | Get bookmarks under a folder |
| `h.snapshot(windowId)` | Capture full observable state |
| `h.resetTabs()` | Close all tabs except one (between tests) |
| `h.cleanup()` | Close the browser |

### How tests work

1. **Fast thresholds**: Tests set `greenToYellow=2s`, `yellowToRed=4s`, etc. in wallclock mode
2. **Backdating**: Instead of waiting, `backdateTab()` modifies `refreshWallTime` in storage to make tabs appear old
3. **Trigger evaluation**: `triggerEvaluation()` fires the Chrome alarm, which runs the extension's full evaluation cycle
4. **Assert real state**: Tests then query real Chrome APIs (`chrome.tabs.query`, `chrome.tabGroups.query`) and extension storage to verify outcomes

This approach tests the **actual extension code** running in a **real Chrome service worker** — no mocks.

## Test Coverage

| Test File | What It Verifies |
|-----------|-----------------|
| `status-transitions` | Tabs transition green→yellow→red→gone based on age |
| `tab-grouping` | Yellow/red tabs move to special groups; green stays ungrouped |
| `group-sorting` | Groups sorted left-to-right: green, yellow, red zones |
| `navigation-reset` | Navigating resets status to green and ungroups from special groups |
| `tab-placement` | New tabs placed by context: user group, auto-group, or leftmost |
| `gone-and-bookmarks` | Gone tabs are closed; bookmarked when enabled |
| `settings-persistence` | Options page saves settings; changes trigger re-evaluation |
| `group-dissolution` | Extension-created unnamed single-tab groups are dissolved |
| `edge-cases` | Pinned tabs excluded, rapid creation, empty state, active time mode |

## Troubleshooting

- **Tests skip with "No Chrome binary found"**: Set `CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH`
- **Timeouts**: Increase `--testTimeout` (default 60s). Some tests need time for Chrome to settle.
- **Chrome crashes**: Close other Chrome instances first. The test uses `--disable-extensions-except` which can conflict with existing profiles.
- **Flaky tests**: The `sleep()` calls in the harness give Chrome time to process events. If tests are flaky, increase sleep durations in `harness.js`.
