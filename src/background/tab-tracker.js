/**
 * Creates and updates per-tab metadata entries.
 *
 * Each tab in the browser has a corresponding metadata entry that tracks
 * when it was last refreshed (by navigation or focus), what lifecycle
 * stage it's in, and which group it belongs to.
 */

import { TAB_LIFECYCLE_STAGE } from '../shared/constants.js';

/** Chrome's sentinel value meaning "this tab is not in any group". */
const CHROME_UNGROUPED_TAB_SENTINEL = -1;

/**
 * Creates a fresh metadata entry for a newly opened tab.
 * The tab starts in the GREEN stage with its age clock set to now.
 *
 * @param {chrome.tabs.Tab} tab - The Chrome tab object
 * @param {number} currentActiveTimeMs - The current accumulated active time in ms
 * @returns {object} A new tab metadata entry
 */
export function createFreshTabMetadata(tab, currentActiveTimeMs) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    refreshActiveTime: currentActiveTimeMs,
    refreshWallTime: Date.now(),
    status: TAB_LIFECYCLE_STAGE.GREEN,
    groupId: tab.groupId !== CHROME_UNGROUPED_TAB_SENTINEL ? tab.groupId : null,
    isSpecialGroup: false,
    managedGroupType: null,
    pinned: tab.pinned || false,
    url: tab.url || '',
  };
}

/**
 * Resets a tab's age after the user navigates to a new page or holds focus for 15 seconds.
 * The tab returns to GREEN status with fresh timestamps, preserving all other metadata.
 *
 * @param {object} existingMetadata - The tab's current metadata entry
 * @param {number} currentActiveTimeMs - The current accumulated active time in ms
 * @param {string} navigatedToUrl - The URL the tab navigated to (or current URL for focus refresh)
 * @returns {object} Updated metadata entry with reset age
 */
export function resetTabAgeAfterNavigation(existingMetadata, currentActiveTimeMs, navigatedToUrl) {
  return {
    ...existingMetadata,
    refreshActiveTime: currentActiveTimeMs,
    refreshWallTime: Date.now(),
    status: TAB_LIFECYCLE_STAGE.GREEN,
    managedGroupType: existingMetadata.managedGroupType ?? null,
    url: navigatedToUrl || existingMetadata.url || '',
  };
}

/**
 * Reconciles stored tab metadata with the actual tabs currently open in Chrome.
 * After a browser restart, Chrome assigns new tab IDs, so this function
 * matches stored entries by tab ID and creates fresh entries for unrecognized tabs.
 *
 * @param {object} storedMetadata - Previously persisted tab metadata (keyed by tab ID)
 * @param {chrome.tabs.Tab[]} currentBrowserTabs - All tabs currently open in Chrome
 * @param {number} currentActiveTimeMs - The current accumulated active time in ms
 * @returns {object} Reconciled metadata collection keyed by current tab IDs
 */
export function reconcileTabMetadataWithBrowserTabs(storedMetadata, currentBrowserTabs, currentActiveTimeMs) {
  const reconciledMetadata = {};
  const currentTimestamp = Date.now();

  for (const browserTab of currentBrowserTabs) {
    if (browserTab.pinned) continue;

    const existingEntry = storedMetadata[browserTab.id] || storedMetadata[String(browserTab.id)];
    if (existingEntry) {
      reconciledMetadata[browserTab.id] = {
        ...existingEntry,
        windowId: browserTab.windowId,
        groupId: browserTab.groupId !== CHROME_UNGROUPED_TAB_SENTINEL ? browserTab.groupId : null,
        managedGroupType: existingEntry.managedGroupType ?? null,
        pinned: browserTab.pinned || false,
        url: browserTab.url || existingEntry.url || '',
      };
    } else {
      reconciledMetadata[browserTab.id] = {
        tabId: browserTab.id,
        windowId: browserTab.windowId,
        refreshActiveTime: currentActiveTimeMs,
        refreshWallTime: currentTimestamp,
        status: TAB_LIFECYCLE_STAGE.GREEN,
        groupId: browserTab.groupId !== CHROME_UNGROUPED_TAB_SENTINEL ? browserTab.groupId : null,
        isSpecialGroup: false,
        managedGroupType: null,
        pinned: false,
        url: browserTab.url || '',
      };
    }
  }

  return reconciledMetadata;
}
