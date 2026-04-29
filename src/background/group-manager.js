/**
 * Manages Chrome tab groups created and maintained by the TabCycle extension.
 *
 * This module handles:
 *   - "Managed groups": the yellow and red groups that hold aging tabs
 *   - Group sorting: arranging groups into lifecycle zones (green → yellow → red)
 *   - Group color updates: coloring groups to match their lifecycle stage
 *   - Auto-naming: generating descriptive names for unnamed groups after a delay
 *   - Age display: appending age suffixes like "(2h)" to group titles
 *   - Dissolution: removing single-tab unnamed groups to keep the tab bar tidy
 */

import { MANAGED_GROUP_TYPES, ERROR_CODES, TAB_LIFECYCLE_STAGE } from '../shared/constants.js';
import { calculateTabAgeInMs } from './status-evaluator.js';
import { createLogger } from '../shared/logger.js';
import { generateBestGroupNameFromTabs } from './group-name-generator.js';

const logger = createLogger('background');

const DEFAULT_AUTO_NAMING_DELAY_MINUTES = 5;
const TITLE_UPDATE_TRACKING_EXPIRY_MS = 10_000;

/**
 * Tracks title changes initiated by this extension (keyed by groupId).
 * Used to distinguish extension-initiated title changes from user edits
 * in the onGroupUpdated handler.
 */
const pendingExtensionTitleChanges = new Map();

/**
 * Tracks color changes initiated by this extension (keyed by groupId).
 * Same purpose as title tracking — prevents false "user edit" detection.
 */
const pendingExtensionColorChanges = new Map();

/**
 * Set of group IDs that were created by this extension (not by the user).
 * Only extension-created groups are eligible for auto-dissolution.
 */
const groupsCreatedByExtension = new Set();

/** Records that a group was created by this extension. */
export function markGroupAsCreatedByExtension(groupId) {
  groupsCreatedByExtension.add(groupId);
  logger.debug('Tracking extension-created group', { groupId });
}

/** Removes a group from the extension-created tracking set. */
export function unmarkGroupAsCreatedByExtension(groupId) {
  groupsCreatedByExtension.delete(groupId);
}

/** Returns true if this group was created by the extension (not by the user). */
export function wasGroupCreatedByExtension(groupId) {
  return groupsCreatedByExtension.has(groupId);
}

// ─── Drag-Lock Dissolution Retry ──────────────────────────────────────────────
// When Chrome has a drag operation in progress, tabs "cannot be edited".
// We retry dissolution every 300ms until the drag completes or 10 seconds elapse.

const groupsAwaitingDissolutionAfterDragLock = new Map();
let dissolutionRetryIntervalId = null;

async function retryDissolvingGroupsBlockedByDragLock() {
  if (groupsAwaitingDissolutionAfterDragLock.size === 0) {
    clearInterval(dissolutionRetryIntervalId);
    dissolutionRetryIntervalId = null;
    return;
  }

  for (const [groupId, retryInfo] of groupsAwaitingDissolutionAfterDragLock) {
    if (Date.now() - retryInfo.startTime > 10000) {
      logger.warn('Giving up on pending dissolution after timeout', { groupId, tabId: retryInfo.tabId });
      groupsAwaitingDissolutionAfterDragLock.delete(groupId);
      continue;
    }

    try {
      await chrome.tabs.ungroup(retryInfo.tabId);
      const { readValidatedStateFromStorage, writeMultipleStateEntries } = await import('./state-persistence.js');
      const { STORAGE_KEYS } = await import('../shared/constants.js');
      const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const tabEntry = tabMeta[retryInfo.tabId] || tabMeta[String(retryInfo.tabId)];
      if (tabEntry) {
        tabEntry.groupId = null;
        tabEntry.isSpecialGroup = false;
      }
      await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
      groupsCreatedByExtension.delete(groupId);
      groupsAwaitingDissolutionAfterDragLock.delete(groupId);
      logger.debug('Dissolved pending single-tab group after drag', {
        groupId, tabId: retryInfo.tabId, windowId: retryInfo.windowId,
      });
    } catch (error) {
      if (error.message && error.message.includes('cannot be edited')) {
        // Still dragging — will retry on next interval tick
      } else {
        logger.warn('Failed pending dissolution with unexpected error', {
          groupId, tabId: retryInfo.tabId, error: error.message,
        });
        groupsAwaitingDissolutionAfterDragLock.delete(groupId);
      }
    }
  }

  if (groupsAwaitingDissolutionAfterDragLock.size === 0) {
    clearInterval(dissolutionRetryIntervalId);
    dissolutionRetryIntervalId = null;
  }
}

function scheduleGroupDissolutionRetry(groupId, tabId, windowId) {
  groupsAwaitingDissolutionAfterDragLock.set(groupId, { tabId, windowId, startTime: Date.now() });
  if (!dissolutionRetryIntervalId) {
    dissolutionRetryIntervalId = setInterval(retryDissolvingGroupsBlockedByDragLock, 300);
  }
}

// ─── Managed Group Configuration ──────────────────────────────────────────────

/** Visual configuration for managed groups. Colors are identity-based and fixed. */
const MANAGED_GROUP_VISUAL_CONFIG = {
  [MANAGED_GROUP_TYPES.YELLOW]: { color: 'yellow' },
  [MANAGED_GROUP_TYPES.RED]: { color: 'red' },
};

/** Gets the title for a managed group type from settings, falling back to empty string. */
function getTitleForManagedGroupType(groupType, settings) {
  if (groupType === MANAGED_GROUP_TYPES.YELLOW) {
    return settings?.yellowGroupName ?? '';
  }
  if (groupType === MANAGED_GROUP_TYPES.RED) {
    return settings?.redGroupName ?? '';
  }
  return '';
}

/**
 * Returns true if the given group ID is one of the extension-managed aging groups
 * (the yellow or red special group) for the specified window.
 */
export function isManagedAgingGroup(groupId, windowId, windowState) {
  if (groupId === null || groupId === undefined) return false;
  const windowEntry = windowState[windowId] || windowState[String(windowId)];
  if (!windowEntry || !windowEntry.specialGroups) return false;
  return windowEntry.specialGroups.yellow === groupId || windowEntry.specialGroups.red === groupId;
}

/**
 * Returns which type ('yellow' or 'red') of managed group this is, or null if it's not managed.
 */
export function getManagedGroupType(groupId, windowId, windowState) {
  const windowEntry = windowState[windowId] || windowState[String(windowId)];
  if (!windowEntry || !windowEntry.specialGroups) return null;
  if (windowEntry.specialGroups.yellow === groupId) return MANAGED_GROUP_TYPES.YELLOW;
  if (windowEntry.specialGroups.red === groupId) return MANAGED_GROUP_TYPES.RED;
  return null;
}

/**
 * Ensures that a window state entry exists for the given window,
 * creating a default one if needed.
 */
function ensureWindowStateEntryExists(windowId, windowState) {
  const key = windowId;
  if (!windowState[key]) {
    windowState[key] = {
      specialGroups: { yellow: null, red: null },
      groupZones: {},
      groupNaming: {},
    };
  } else if (!windowState[key].groupNaming || typeof windowState[key].groupNaming !== 'object') {
    windowState[key].groupNaming = {};
  }
  return windowState[key];
}

/**
 * Returns the value if it's a valid positive timestamp, otherwise returns the fallback.
 */
function asPositiveTimestampOrFallback(value, fallback) {
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

/**
 * Normalizes a candidate name to at most two words, or returns null if empty.
 */
function normalizeCandidateToOneOrTwoWords(candidateName) {
  if (typeof candidateName !== 'string') return null;
  const words = candidateName.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return null;
  return words.join(' ');
}

/**
 * Normalizes a group naming metadata entry, filling in defaults for missing/invalid fields.
 */
function normalizeGroupNamingMetadata(rawEntry, currentTimestamp) {
  const now = asPositiveTimestampOrFallback(currentTimestamp, Date.now());
  return {
    firstUnnamedSeenAt: asPositiveTimestampOrFallback(rawEntry?.firstUnnamedSeenAt, now),
    lastAutoNamedAt: Number.isFinite(rawEntry?.lastAutoNamedAt) && rawEntry.lastAutoNamedAt > 0
      ? rawEntry.lastAutoNamedAt
      : null,
    lastCandidate: normalizeCandidateToOneOrTwoWords(rawEntry?.lastCandidate),
    userEditLockUntil: asPositiveTimestampOrFallback(rawEntry?.userEditLockUntil, now),
  };
}

function getGroupNamingMetadata(windowEntry, groupId) {
  return windowEntry.groupNaming[groupId] || windowEntry.groupNaming[String(groupId)] || null;
}

function setGroupNamingMetadata(windowEntry, groupId, metadata) {
  windowEntry.groupNaming[String(groupId)] = metadata;
}

function removeGroupNamingMetadata(windowEntry, groupId) {
  delete windowEntry.groupNaming[groupId];
  delete windowEntry.groupNaming[String(groupId)];
}

// ─── Extension Update Tracking ────────────────────────────────────────────────
// These track title/color changes made by the extension itself, so the
// onGroupUpdated handler can tell them apart from user edits.

function removeExpiredTitleChangeRecords(currentTime = Date.now()) {
  for (const [groupId, record] of pendingExtensionTitleChanges.entries()) {
    if (record.expiresAt <= currentTime) {
      pendingExtensionTitleChanges.delete(groupId);
    }
  }
}

function recordPendingExtensionTitleChange(groupId, newTitle, currentTime = Date.now()) {
  removeExpiredTitleChangeRecords(currentTime);
  pendingExtensionTitleChanges.set(groupId, {
    title: newTitle,
    expiresAt: currentTime + TITLE_UPDATE_TRACKING_EXPIRY_MS,
  });
}

function removeExpiredColorChangeRecords(currentTime = Date.now()) {
  for (const [groupId, record] of pendingExtensionColorChanges.entries()) {
    if (record.expiresAt <= currentTime) {
      pendingExtensionColorChanges.delete(groupId);
    }
  }
}

function recordPendingExtensionColorChange(groupId, newColor, currentTime = Date.now()) {
  removeExpiredColorChangeRecords(currentTime);
  pendingExtensionColorChanges.set(groupId, {
    color: newColor,
    expiresAt: currentTime + TITLE_UPDATE_TRACKING_EXPIRY_MS,
  });
}

/**
 * Checks if the given title change was initiated by the extension.
 * If so, consumes the tracking record and returns true.
 * Used by onGroupUpdated to avoid treating our own changes as user edits.
 */
export function acknowledgeExtensionTitleChangeIfExpected(groupId, title, currentTime = Date.now()) {
  removeExpiredTitleChangeRecords(currentTime);
  const record = pendingExtensionTitleChanges.get(groupId);
  if (!record) return false;
  if (typeof title === 'string' && record.title !== title) return false;
  pendingExtensionTitleChanges.delete(groupId);
  return true;
}

/**
 * Checks if the given color change was initiated by the extension.
 * If so, consumes the tracking record and returns true.
 */
export function acknowledgeExtensionColorChangeIfExpected(groupId, color, currentTime = Date.now()) {
  removeExpiredColorChangeRecords(currentTime);
  const record = pendingExtensionColorChanges.get(groupId);
  if (!record) return false;
  if (typeof color === 'string' && record.color !== color) return false;
  pendingExtensionColorChanges.delete(groupId);
  return true;
}

// ─── Managed Group Lifecycle ──────────────────────────────────────────────────

/**
 * Ensures that a managed aging group (yellow or red) exists for the given window.
 * Creates a new one if needed, or validates the existing one is still alive.
 *
 * @param {number} windowId - The Chrome window ID
 * @param {string} groupType - 'yellow' or 'red'
 * @param {object} windowState - The per-window state object
 * @param {number} tabIdForCreation - A tab ID to seed the group with (needed for chrome.tabs.group)
 * @param {object} settings - User settings (for group title)
 * @returns {Promise<{groupId: number|null, created: boolean}>}
 */
export async function ensureManagedGroupExists(windowId, groupType, windowState, tabIdForCreation, settings) {
  const windowEntry = ensureWindowStateEntryExists(windowId, windowState);
  const existingGroupId = windowEntry.specialGroups[groupType];

  if (existingGroupId !== null) {
    try {
      const tabsInGroup = await chrome.tabs.query({ groupId: existingGroupId });
      if (tabsInGroup.length > 0) {
        return { groupId: existingGroupId, created: false };
      }
    } catch {
      // Group may not exist anymore
    }
    windowEntry.specialGroups[groupType] = null;
  }

  if (!tabIdForCreation) {
    return { groupId: null, created: false };
  }

  try {
    const visualConfig = MANAGED_GROUP_VISUAL_CONFIG[groupType];
    const groupTitle = getTitleForManagedGroupType(groupType, settings);
    const newGroupId = await chrome.tabs.group({ tabIds: [tabIdForCreation], createProperties: { windowId } });
    await chrome.tabGroups.update(newGroupId, {
      title: groupTitle,
      color: visualConfig.color,
      collapsed: false,
    });
    windowEntry.specialGroups[groupType] = newGroupId;
    logger.info('Created special group', { windowId, type: groupType, groupId: newGroupId });
    return { groupId: newGroupId, created: true };
  } catch (error) {
    logger.error('Failed to create special group', {
      windowId,
      type: groupType,
      error: error.message,
      errorCode: ERROR_CODES.ERR_GROUP_CREATE,
    });
    return { groupId: null, created: false };
  }
}

/**
 * Removes the managed group reference if the group has become empty.
 * This happens when all tabs in a managed group navigate (resetting to green) or are closed.
 */
export async function removeManagedGroupIfEmpty(windowId, groupType, windowState) {
  const windowEntry = windowState[windowId] || windowState[String(windowId)];
  if (!windowEntry || !windowEntry.specialGroups) return { removed: false };

  const groupId = windowEntry.specialGroups[groupType];
  if (groupId === null || groupId === undefined) return { removed: false };

  try {
    const tabsRemaining = await chrome.tabs.query({ groupId });
    if (tabsRemaining.length === 0) {
      windowEntry.specialGroups[groupType] = null;
      logger.info('Removed empty special group reference', { windowId, type: groupType, groupId });
      return { removed: true };
    }
    return { removed: false };
  } catch {
    windowEntry.specialGroups[groupType] = null;
    return { removed: true };
  }
}

/**
 * Moves a tab into the specified managed aging group (yellow or red).
 * Creates the group if it doesn't exist. Handles the edge case where
 * the group is deleted between validation and the move attempt.
 */
export async function moveTabToManagedGroup(tabId, groupType, windowId, windowState, settings) {
  const windowEntry = ensureWindowStateEntryExists(windowId, windowState);
  const ensured = await ensureManagedGroupExists(windowId, groupType, windowState, tabId, settings);
  let targetGroupId = ensured.groupId;

  if (targetGroupId === null) {
    logger.warn('Could not create special group for tab move', {
      tabId,
      type: groupType,
      windowId,
      errorCode: ERROR_CODES.ERR_GROUP_CREATE,
    });
    return { success: false };
  }

  if (ensured.created) {
    return { success: true, groupId: targetGroupId };
  }

  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId });
    logger.debug('Moved tab to special group', { tabId, type: groupType, groupId: targetGroupId });
    return { success: true, groupId: targetGroupId };
  } catch (error) {
    const isDragLock = error?.message?.includes('cannot be edited');
    if (isDragLock) {
      logger.warn('Tab move blocked by drag lock, will retry next cycle', {
        tabId, type: groupType, groupId: targetGroupId,
      });
      return { success: false, dragLocked: true };
    }

    if (error?.message?.includes('No group with id')) {
      windowEntry.specialGroups[groupType] = null;
      const retryResult = await ensureManagedGroupExists(windowId, groupType, windowState, tabId, settings);
      targetGroupId = retryResult.groupId;
      if (targetGroupId !== null) {
        if (retryResult.created) return { success: true, groupId: targetGroupId };
        try {
          await chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId });
          logger.debug('Moved tab to recreated special group', { tabId, type: groupType, groupId: targetGroupId });
          return { success: true, groupId: targetGroupId };
        } catch (retryError) {
          if (retryError?.message?.includes('cannot be edited')) {
            logger.warn('Tab move blocked by drag lock, will retry next cycle', {
              tabId, type: groupType, groupId: targetGroupId,
            });
            return { success: false, dragLocked: true };
          }
          logger.error('Failed to move tab to special group', {
            tabId,
            type: groupType,
            groupId: targetGroupId,
            error: retryError.message,
            errorCode: ERROR_CODES.ERR_TAB_GROUP,
          });
          return { success: false };
        }
      }
    }

    logger.error('Failed to move tab to special group', {
      tabId,
      type: groupType,
      groupId: targetGroupId,
      error: error.message,
      errorCode: ERROR_CODES.ERR_TAB_GROUP,
    });
    return { success: false };
  }
}

// ─── Group Status & Sorting ───────────────────────────────────────────────────

/** Priority ordering for lifecycle stages (lower = fresher/healthier). */
const LIFECYCLE_STAGE_PRIORITY = { green: 0, yellow: 1, red: 2, gone: 3 };

/**
 * Determines the lifecycle stage of a tab group by finding its freshest (greenest) tab.
 * A group's status is only as old as its youngest member.
 */
export function determineFreshestStatusInGroup(groupId, tabMeta) {
  let freshestStage = null;
  for (const tabEntry of Object.values(tabMeta)) {
    if (tabEntry.groupId !== groupId) continue;
    if (tabEntry.pinned) continue;
    if (tabEntry.isSpecialGroup) continue;
    if (freshestStage === null || LIFECYCLE_STAGE_PRIORITY[tabEntry.status] < LIFECYCLE_STAGE_PRIORITY[freshestStage]) {
      freshestStage = tabEntry.status;
    }
  }
  return freshestStage;
}

/** Valid Chrome tab group colors that can be passed to chrome.tabGroups.update(). */
const VALID_GROUP_COLORS = new Set(['blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow']);

/**
 * Updates a tab group's color to match its current lifecycle stage.
 */
export async function updateGroupColorToMatchStatus(groupId, lifecycleStage) {
  if (!VALID_GROUP_COLORS.has(lifecycleStage)) {
    logger.debug('Skipping color update for non-color lifecycle stage', { groupId, lifecycleStage });
    return;
  }
  try {
    recordPendingExtensionColorChange(groupId, lifecycleStage);
    const updateResult = await chrome.tabGroups.update(groupId, { color: lifecycleStage });
    logger.debug('Updated group color', { groupId, status: lifecycleStage, resultColor: updateResult?.color });
  } catch (error) {
    logger.warn('Failed to update group color', {
      groupId,
      status: lifecycleStage,
      error: error.message,
      errorCode: ERROR_CODES.ERR_GROUP_MOVE,
    });
  }
}

/**
 * Closes all tabs belonging to groups that have reached the GONE stage.
 * Returns the IDs of tabs that were successfully closed.
 */
export async function closeAllTabsInGoneGroups(windowId, goneGroupIds, tabMeta, windowState) {
  const closedTabIds = [];
  const windowEntry = windowState[windowId] || windowState[String(windowId)];

  for (const groupId of goneGroupIds) {
    if (windowEntry && isManagedAgingGroup(groupId, windowId, windowState)) {
      continue;
    }

    const tabsInThisGroup = Object.values(tabMeta).filter(
      (entry) => entry.groupId === groupId && entry.windowId === Number(windowId) && !entry.pinned
    );

    for (const tabEntry of tabsInThisGroup) {
      try {
        await chrome.tabs.remove(tabEntry.tabId);
        closedTabIds.push(tabEntry.tabId);
      } catch (error) {
        logger.warn('Failed to remove tab from gone group', {
          tabId: tabEntry.tabId,
          groupId,
          error: error.message,
        });
      }
    }

    if (windowEntry && windowEntry.groupZones) {
      delete windowEntry.groupZones[groupId];
      delete windowEntry.groupZones[String(groupId)];
    }
  }

  return closedTabIds;
}

/** Sort order for lifecycle zones (green first, red last). */
const ZONE_SORT_ORDER = { green: 0, yellow: 1, red: 2 };

/**
 * Sorts all tabs and groups in a window according to their lifecycle zones.
 *
 * This is the unified sorting algorithm that:
 *   1. Moves ungrouped tabs into managed groups (yellow/red) based on their status
 *   2. Returns tabs to the green zone when they're refreshed
 *   3. Bookmarks and closes gone tabs/groups
 *   4. Reorders user groups by zone: green → yellow → red
 *   5. Updates group colors to match their zone
 *
 * @param {number} windowId - The Chrome window to sort
 * @param {object} tabMeta - All tab metadata entries
 * @param {object} windowState - Per-window state
 * @param {object} [goneConfig] - Configuration for handling gone tabs (bookmarking + closing)
 * @param {object} settings - User settings (controls which sorting features are active)
 */
export async function sortTabsAndGroupsByLifecycleZone(windowId, tabMeta, windowState, goneConfig, settings) {
  const windowEntry = ensureWindowStateEntryExists(windowId, windowState);
  const sortingResults = { tabsMoved: 0, groupsMoved: 0, goneTabsClosed: 0, goneGroupsClosed: 0 };

  const isTabSortingEnabled = settings?.tabSortingEnabled !== false;
  const isGroupSortingEnabled = settings?.tabgroupSortingEnabled !== false;
  const isGroupColoringEnabled = settings?.tabgroupColoringEnabled !== false;

  try {
    // ── Step 1: Read current browser state ──────────────────────────
    const [allBrowserTabs, allBrowserGroups] = await Promise.all([
      chrome.tabs.query({ windowId: Number(windowId) }),
      chrome.tabGroups.query({ windowId: Number(windowId) }),
    ]);

    const browserTabById = new Map();
    for (const browserTab of allBrowserTabs) browserTabById.set(browserTab.id, browserTab);

    const managedGroupIds = new Set();
    for (const group of allBrowserGroups) {
      if (isManagedAgingGroup(group.id, windowId, windowState)) managedGroupIds.add(group.id);
    }

    logger.debug('sortTabsAndGroups: browser state read', {
      windowId,
      tabCount: allBrowserTabs.length,
      groupCount: allBrowserGroups.length,
      specialGroupIds: [...managedGroupIds],
    });

    // Reconcile tabMeta groupIds against fresh Chrome state.  Between the
    // global groupId reconciliation (in the evaluation cycle) and here, group
    // assignments can drift — especially during startup when session restore
    // may still be settling.  Without this, determineFreshestStatusInGroup
    // finds no matching tabs and the group is silently excluded from sorting,
    // leaving it wherever Chrome placed it and breaking zone ordering.
    let sortLocalGroupIdFixes = 0;
    for (const browserTab of allBrowserTabs) {
      if (browserTab.pinned) continue;
      const tabEntry = tabMeta[browserTab.id] || tabMeta[String(browserTab.id)];
      if (!tabEntry) continue;
      const actualGroupId = browserTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? browserTab.groupId : null;
      if (tabEntry.groupId !== actualGroupId) {
        tabEntry.groupId = actualGroupId;
        tabEntry.isSpecialGroup = actualGroupId !== null && managedGroupIds.has(actualGroupId);
        sortLocalGroupIdFixes++;
      }
    }
    if (sortLocalGroupIdFixes > 0) {
      logger.info('Sort-local groupId reconciliation fixed stale entries', {
        windowId, fixes: sortLocalGroupIdFixes,
      });
    }

    // ── Step 2: Sort ungrouped tabs into managed groups ──────────────
    for (const browserTab of allBrowserTabs) {
      if (browserTab.pinned) continue;
      const tabEntry = tabMeta[browserTab.id] || tabMeta[String(browserTab.id)];
      if (!tabEntry) continue;

      const actualGroupId = browserTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? browserTab.groupId : null;
      const isInManagedGroup = actualGroupId !== null && managedGroupIds.has(actualGroupId);
      const isInUserGroup = actualGroupId !== null && !isInManagedGroup;

      if (isInUserGroup) continue;

      let currentZone = 'green';
      if (isInManagedGroup) {
        const managedType = getManagedGroupType(actualGroupId, windowId, windowState);
        if (managedType === MANAGED_GROUP_TYPES.YELLOW) currentZone = 'yellow';
        else if (managedType === MANAGED_GROUP_TYPES.RED) currentZone = 'red';
      }

      const desiredZone = tabEntry.status;

      // Handle gone tabs (always runs regardless of tab sorting toggle)
      if (desiredZone === TAB_LIFECYCLE_STAGE.GONE) {
        if (goneConfig) {
          if (goneConfig.bookmarkEnabled && goneConfig.bookmarkFolderId) {
            try {
              const liveTab = browserTabById.get(browserTab.id);
              if (liveTab && goneConfig.isBookmarkableUrl(liveTab.url)) {
                await goneConfig.bookmarkTab(liveTab, goneConfig.bookmarkFolderId);
                logger.debug('Bookmarked gone ungrouped tab', { tabId: browserTab.id, url: liveTab.url });
              }
            } catch (error) {
              logger.warn('Failed to bookmark gone tab', { tabId: browserTab.id, error: error.message });
            }
          }
          try {
            await chrome.tabs.remove(browserTab.id);
            delete tabMeta[browserTab.id];
            delete tabMeta[String(browserTab.id)];
            sortingResults.goneTabsClosed++;
          } catch (error) {
            logger.warn('Failed to close gone tab', { tabId: browserTab.id, error: error.message });
          }
        }
        continue;
      }

      if (!isTabSortingEnabled) continue;
      if (currentZone === desiredZone) continue;

      if (desiredZone === 'yellow') {
        const moveResult = await moveTabToManagedGroup(browserTab.id, 'yellow', windowId, windowState, settings);
        if (moveResult.dragLocked) break;
        if (moveResult.success) {
          tabEntry.groupId = moveResult.groupId;
          tabEntry.isSpecialGroup = true;
          sortingResults.tabsMoved++;
          if (!managedGroupIds.has(moveResult.groupId)) managedGroupIds.add(moveResult.groupId);
        }
      } else if (desiredZone === 'red') {
        const moveResult = await moveTabToManagedGroup(browserTab.id, 'red', windowId, windowState, settings);
        if (moveResult.dragLocked) break;
        if (moveResult.success) {
          tabEntry.groupId = moveResult.groupId;
          tabEntry.isSpecialGroup = true;
          sortingResults.tabsMoved++;
          if (!managedGroupIds.has(moveResult.groupId)) managedGroupIds.add(moveResult.groupId);
        }
      } else if (desiredZone === 'green' && isInManagedGroup) {
        const wasUngrouped = await removeTabFromItsGroup(browserTab.id);
        if (wasUngrouped) {
          tabEntry.groupId = null;
          tabEntry.isSpecialGroup = false;
          sortingResults.tabsMoved++;
        }
      }
    }

    if (sortingResults.tabsMoved > 0) {
      await removeManagedGroupIfEmpty(windowId, 'yellow', windowState);
      await removeManagedGroupIfEmpty(windowId, 'red', windowState);
    }

    // ── Step 3: Sort groups by lifecycle zone ─────────────────────────
    const [tabsAfterMoves, groupsAfterMoves] = await Promise.all([
      chrome.tabs.query({ windowId: Number(windowId) }),
      chrome.tabGroups.query({ windowId: Number(windowId) }),
    ]);

    const firstTabIndexByGroup = new Map();
    for (let i = 0; i < tabsAfterMoves.length; i++) {
      const browserTab = tabsAfterMoves[i];
      if (browserTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
      const tabIndex = Number.isFinite(browserTab.index) ? browserTab.index : i;
      const previousFirst = firstTabIndexByGroup.get(browserTab.groupId);
      if (previousFirst === undefined || tabIndex < previousFirst) {
        firstTabIndexByGroup.set(browserTab.groupId, tabIndex);
      }
    }

    const managedGroupIdsAfterMoves = new Set();
    for (const group of groupsAfterMoves) {
      if (isManagedAgingGroup(group.id, windowId, windowState)) {
        managedGroupIdsAfterMoves.add(group.id);
      }
    }

    const userGroupsSortedByPosition = groupsAfterMoves
      .filter((group) => !managedGroupIdsAfterMoves.has(group.id))
      .sort((groupA, groupB) => {
        const indexA = firstTabIndexByGroup.get(groupA.id);
        const indexB = firstTabIndexByGroup.get(groupB.id);
        if (indexA === undefined && indexB === undefined) return groupA.id - groupB.id;
        if (indexA === undefined) return 1;
        if (indexB === undefined) return -1;
        return indexA - indexB;
      });

    const previousZoneAssignments = { ...windowEntry.groupZones };

    const groupStatusMap = new Map();
    for (const group of userGroupsSortedByPosition) {
      const groupLifecycleStage = determineFreshestStatusInGroup(group.id, tabMeta);
      if (!groupLifecycleStage) continue;
      groupStatusMap.set(group.id, groupLifecycleStage);
      windowEntry.groupZones[group.id] = groupLifecycleStage;
    }

    // Handle gone groups: bookmark and close
    const goneGroupIds = [];
    for (const [groupId, lifecycleStage] of groupStatusMap) {
      if (lifecycleStage === TAB_LIFECYCLE_STAGE.GONE) goneGroupIds.push(groupId);
    }

    // Even when goneConfig is not provided (non-evaluation callers like focus-refresh),
    // exclude gone groups from sorting/coloring — "gone" is not a valid Chrome group color
    // and these groups should not participate in zone ordering.
    if (!goneConfig && goneGroupIds.length > 0) {
      for (const goneGroupId of goneGroupIds) {
        groupStatusMap.delete(goneGroupId);
      }
    }

    if (goneConfig && goneGroupIds.length > 0) {
      for (const goneGroupId of goneGroupIds) {
        if (goneConfig.bookmarkEnabled && goneConfig.bookmarkFolderId) {
          try {
            const groupInfo = await chrome.tabGroups.get(goneGroupId);
            const groupTabs = await chrome.tabs.query({ groupId: goneGroupId });
            await goneConfig.bookmarkGroupTabs(
              groupInfo.title || '', groupTabs, goneConfig.bookmarkFolderId
            );
            logger.info('Bookmarked gone group', {
              groupId: goneGroupId, title: groupInfo.title || '(unnamed)', tabCount: groupTabs.length,
            });
          } catch (error) {
            logger.warn('Failed to bookmark gone group', { groupId: goneGroupId, error: error.message });
          }
        }

        const tabsInGoneGroup = Object.values(tabMeta).filter(
          (entry) => entry.groupId === goneGroupId && entry.windowId === Number(windowId) && !entry.pinned
        );
        for (const tabEntry of tabsInGoneGroup) {
          let tabStillExists = false;
          try {
            await chrome.tabs.remove(tabEntry.tabId);
          } catch (error) {
            // Check whether the tab is genuinely gone or still alive but temporarily unremovable.
            // Only preserve tabMeta for tabs that are confirmed to still exist in Chrome,
            // otherwise stale "gone" entries cause infinite re-bookmarking loops.
            const msg = error?.message || '';
            const isTabGone = msg.includes('No tab with id');
            tabStillExists = !isTabGone;
            logger.warn('Failed to remove tab from gone group', {
              tabId: tabEntry.tabId, groupId: goneGroupId, error: msg, tabStillExists,
            });
          }
          if (!tabStillExists) {
            delete tabMeta[tabEntry.tabId];
            delete tabMeta[String(tabEntry.tabId)];
          }
        }

        delete windowEntry.groupZones[goneGroupId];
        delete windowEntry.groupZones[String(goneGroupId)];
        sortingResults.goneGroupsClosed++;
        groupStatusMap.delete(goneGroupId);
      }
    }

    const survivingUserGroups = userGroupsSortedByPosition.filter((group) => groupStatusMap.has(group.id));

    // Detect groups that just transitioned into a new zone
    const groupsThatJustChangedZone = new Set();
    for (const group of survivingUserGroups) {
      const currentStage = groupStatusMap.get(group.id);
      const previousZone = previousZoneAssignments[group.id] || previousZoneAssignments[String(group.id)];
      if (previousZone === undefined) {
        if (currentStage === 'green') groupsThatJustChangedZone.add(group.id);
      } else if (previousZone !== currentStage) {
        groupsThatJustChangedZone.add(group.id);
      }
    }

    // Build sorted list per zone: newly arrived groups go to the LEFT of their zone
    const greenZoneGroups = survivingUserGroups.filter((group) => groupStatusMap.get(group.id) === 'green');
    const yellowZoneGroups = survivingUserGroups.filter((group) => groupStatusMap.get(group.id) === 'yellow');
    const redZoneGroups = survivingUserGroups.filter((group) => groupStatusMap.get(group.id) === 'red');

    const sortNewlyArrivedFirst = (groups) => {
      const justArrived = groups.filter((group) => groupsThatJustChangedZone.has(group.id));
      const alreadyInZone = groups.filter((group) => !groupsThatJustChangedZone.has(group.id));
      return [...justArrived, ...alreadyInZone];
    };

    const desiredUserGroupOrder = [
      ...sortNewlyArrivedFirst(greenZoneGroups),
      ...sortNewlyArrivedFirst(yellowZoneGroups),
      ...sortNewlyArrivedFirst(redZoneGroups),
    ];

    // Insert managed groups at zone boundaries
    const desiredFullOrder = [];
    const yellowManagedGroupId = windowEntry.specialGroups.yellow;
    const redManagedGroupId = windowEntry.specialGroups.red;
    let yellowManagedInserted = false;
    let redManagedInserted = false;

    for (const group of desiredUserGroupOrder) {
      const zone = groupStatusMap.get(group.id);
      if (!yellowManagedInserted && yellowManagedGroupId !== null && managedGroupIdsAfterMoves.has(yellowManagedGroupId)
          && ZONE_SORT_ORDER[zone] >= ZONE_SORT_ORDER.yellow) {
        desiredFullOrder.push({ id: yellowManagedGroupId, _special: true });
        yellowManagedInserted = true;
      }
      if (!redManagedInserted && redManagedGroupId !== null && managedGroupIdsAfterMoves.has(redManagedGroupId)
          && ZONE_SORT_ORDER[zone] >= ZONE_SORT_ORDER.red) {
        desiredFullOrder.push({ id: redManagedGroupId, _special: true });
        redManagedInserted = true;
      }
      desiredFullOrder.push(group);
    }
    if (!yellowManagedInserted && yellowManagedGroupId !== null && managedGroupIdsAfterMoves.has(yellowManagedGroupId)) {
      desiredFullOrder.push({ id: yellowManagedGroupId, _special: true });
    }
    if (!redManagedInserted && redManagedGroupId !== null && managedGroupIdsAfterMoves.has(redManagedGroupId)) {
      desiredFullOrder.push({ id: redManagedGroupId, _special: true });
    }

    // Compare current visual order to desired order
    const currentVisualOrder = groupsAfterMoves
      .filter((group) => groupStatusMap.has(group.id) || managedGroupIdsAfterMoves.has(group.id))
      .sort((groupA, groupB) => {
        const indexA = firstTabIndexByGroup.get(groupA.id);
        const indexB = firstTabIndexByGroup.get(groupB.id);
        if (indexA === undefined && indexB === undefined) return groupA.id - groupB.id;
        if (indexA === undefined) return 1;
        if (indexB === undefined) return -1;
        return indexA - indexB;
      });
    const currentGroupIds = currentVisualOrder.map((group) => group.id);
    const desiredGroupIds = desiredFullOrder.map((group) => group.id);

    logger.info('sortTabsAndGroups: group order comparison', {
      windowId,
      currentIds: currentGroupIds,
      desiredIds: desiredGroupIds,
      specialGroups: { yellow: windowEntry.specialGroups.yellow, red: windowEntry.specialGroups.red },
      specialAfter: [...managedGroupIdsAfterMoves],
      userGroupStatuses: Object.fromEntries(groupStatusMap),
      groupsAfterIds: groupsAfterMoves.map((group) => group.id),
      needsMove: currentGroupIds.join(',') !== desiredGroupIds.join(','),
    });

    if (isGroupSortingEnabled && currentGroupIds.join(',') !== desiredGroupIds.join(',')) {
      for (const group of desiredFullOrder) {
        try {
          await chrome.tabGroups.move(group.id, { index: -1 });
          sortingResults.groupsMoved++;
        } catch (error) {
          if (error?.message?.includes('cannot be edited')) {
            logger.warn('Group sorting blocked by drag lock, will retry next cycle', { windowId });
            break;
          }
          logger.warn('Failed to move group to zone', {
            groupId: group.id, zone: group._special ? 'special' : groupStatusMap.get(group.id),
            error: error.message, errorCode: ERROR_CODES.ERR_GROUP_MOVE,
          });
        }
      }
    }

    if (isGroupColoringEnabled) {
      for (const group of survivingUserGroups) {
        const lifecycleStage = groupStatusMap.get(group.id);
        if (lifecycleStage && group.color !== lifecycleStage) {
          await updateGroupColorToMatchStatus(group.id, lifecycleStage);
        }
      }
    }

    logger.debug('sortTabsAndGroups: complete', {
      windowId,
      tabsMoved: sortingResults.tabsMoved,
      groupsMoved: sortingResults.groupsMoved,
      goneTabsClosed: sortingResults.goneTabsClosed,
      goneGroupsClosed: sortingResults.goneGroupsClosed,
      desiredGroupOrder: desiredGroupIds,
    });
  } catch (error) {
    const level = error?.message?.includes('No current window') ? 'warn' : 'error';
    logger[level]('Failed to sort tabs and groups', {
      windowId,
      error: error.message,
      errorCode: ERROR_CODES.ERR_GROUP_MOVE,
    });
  }

  return sortingResults;
}

/**
 * Dissolves unnamed groups that contain only a single tab.
 * The remaining tab is ungrouped and its metadata is updated.
 * Only dissolves groups that were created by the extension, not by the user.
 */
export async function dissolveUnnamedGroupsWithOnlyOneTab(windowId, tabMeta, windowState) {
  let groupsDissolved = 0;
  try {
    const allGroups = await chrome.tabGroups.query({ windowId: Number(windowId) });

    for (const group of allGroups) {
      if (isManagedAgingGroup(group.id, windowId, windowState)) continue;
      if (!groupsCreatedByExtension.has(group.id)) continue;
      if (removeAgeSuffixFromTitle(group.title)) continue;

      const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
      if (tabsInGroup.length !== 1) continue;

      const loneTab = tabsInGroup[0];
      try {
        await chrome.tabs.ungroup(loneTab.id);
        const tabEntry = tabMeta[loneTab.id] || tabMeta[String(loneTab.id)];
        if (tabEntry) {
          tabEntry.groupId = null;
          tabEntry.isSpecialGroup = false;
        }
        groupsCreatedByExtension.delete(group.id);
        groupsDissolved++;
        logger.debug('Dissolved unnamed single-tab group', {
          groupId: group.id,
          tabId: loneTab.id,
          windowId,
        });
      } catch (error) {
        if (error.message && error.message.includes('cannot be edited')) {
          scheduleGroupDissolutionRetry(group.id, loneTab.id, windowId);
          logger.debug('Drag lock detected, scheduled dissolution retry', {
            groupId: group.id, tabId: loneTab.id,
          });
        } else {
          logger.warn('Failed to dissolve unnamed single-tab group', {
            groupId: group.id, tabId: loneTab.id, error: error.message,
          });
        }
      }
    }
  } catch (error) {
    const level = error?.message?.includes('No current window') ? 'warn' : 'error';
    logger[level]('Failed to query groups for dissolution', {
      windowId,
      error: error.message,
    });
  }
  return { dissolved: groupsDissolved };
}

// ─── Group Title Parsing & Age Display ────────────────────────────────────────

/** Pattern matching age suffixes like "(1m)", "(2h)", "(3d)". */
const AGE_SUFFIX_PATTERN = /\s?(\([0-9]+[mhd]\))$/;

/**
 * Separates a group title into its base name and age suffix.
 * "My Tabs (2h)" → { baseName: "My Tabs", ageSuffix: "(2h)" }
 */
export function separateGroupTitleFromAgeSuffix(title) {
  if (!title) {
    return { baseName: '', ageSuffix: '' };
  }

  const trimmedTitle = String(title).trim();
  const suffixMatch = trimmedTitle.match(AGE_SUFFIX_PATTERN);
  if (!suffixMatch) {
    return { baseName: trimmedTitle, ageSuffix: '' };
  }

  const ageSuffix = suffixMatch[1] || '';
  const baseName = trimmedTitle.slice(0, suffixMatch.index).trim();
  return { baseName, ageSuffix };
}

/**
 * Combines a base group name with an age suffix into a complete title.
 * ("My Tabs", "(2h)") → "My Tabs (2h)"
 */
export function combineGroupTitleWithAgeSuffix(baseName, ageSuffix) {
  const trimmedBase = (baseName || '').trim();
  const trimmedSuffix = (ageSuffix || '').trim();
  if (trimmedBase && trimmedSuffix) return `${trimmedBase} ${trimmedSuffix}`;
  return trimmedBase || trimmedSuffix;
}

/**
 * Returns true if the group has no user-given name (only an age suffix or empty).
 */
export function hasNoUserGivenName(title) {
  return separateGroupTitleFromAgeSuffix(title).baseName.length === 0;
}

/**
 * Removes the age suffix from a group title, returning just the base name.
 * "My Tabs (2h)" → "My Tabs"
 */
export function removeAgeSuffixFromTitle(title) {
  if (!title) return title;
  return separateGroupTitleFromAgeSuffix(title).baseName;
}

/**
 * Locks auto-naming for a group after the user manually edits its title.
 * Prevents the extension from immediately overwriting a user's rename.
 *
 * @param {number} windowId - The Chrome window ID
 * @param {object} group - The Chrome tabGroups object
 * @param {object} windowState - Per-window state
 * @param {number} lockDurationMs - How long to lock auto-naming (default 15 seconds)
 * @param {number} currentTime - Current timestamp (for testing)
 */
export function lockAutoNamingAfterUserEdit(windowId, group, windowState, lockDurationMs = 15_000, currentTime = Date.now()) {
  const windowEntry = ensureWindowStateEntryExists(windowId, windowState);
  const groupId = group?.id;
  if (groupId === null || groupId === undefined) {
    return { locked: false };
  }

  const { baseName } = separateGroupTitleFromAgeSuffix(group?.title || '');
  if (baseName.length > 0) {
    removeGroupNamingMetadata(windowEntry, groupId);
    return { locked: false, removed: true };
  }

  const now = asPositiveTimestampOrFallback(currentTime, Date.now());
  const effectiveLockDuration = Number.isFinite(lockDurationMs) && lockDurationMs > 0 ? lockDurationMs : 15_000;
  const existingMetadata = getGroupNamingMetadata(windowEntry, groupId);
  const normalizedMetadata = normalizeGroupNamingMetadata(existingMetadata, now);
  const lockExpiresAt = Math.max(normalizedMetadata.userEditLockUntil, now + effectiveLockDuration);

  setGroupNamingMetadata(windowEntry, groupId, {
    ...normalizedMetadata,
    userEditLockUntil: lockExpiresAt,
  });

  return { locked: true, userEditLockUntil: lockExpiresAt };
}

/**
 * Formats a duration in milliseconds as a short human-readable string.
 * 90000 → "1m", 7200000 → "2h", 172800000 → "2d"
 */
export function formatAgeAsShortString(durationMs) {
  const totalMinutes = Math.floor(durationMs / 60000);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/**
 * Calculates the age of a tab group (based on its freshest/youngest tab).
 */
export function calculateAgeOfFreshestTabInGroup(groupId, tabMeta, activeTimeMs, settings) {
  let freshestTabAge = null;
  for (const tabEntry of Object.values(tabMeta)) {
    if (tabEntry.groupId !== groupId) continue;
    if (tabEntry.pinned) continue;
    if (tabEntry.isSpecialGroup) continue;
    const tabAge = calculateTabAgeInMs(tabEntry, activeTimeMs, settings);
    if (freshestTabAge === null || tabAge < freshestTabAge) freshestTabAge = tabAge;
  }
  return freshestTabAge === null ? 0 : freshestTabAge;
}

/**
 * Automatically names unnamed tab groups that have been unnamed for longer
 * than the configured delay. Respects user-edit locks and checks group
 * state at every step to avoid overwriting user changes.
 */
export async function autoNameUnnamedGroupsWhenReady(windowId, tabMeta, windowState, config = {}) {
  const windowEntry = ensureWindowStateEntryExists(windowId, windowState);
  const now = asPositiveTimestampOrFallback(config.nowMs, Date.now());
  const isNamingEnabled = config.enabled !== undefined ? Boolean(config.enabled) : true;
  const namingDelayMinutes = Number.isInteger(config.delayMinutes) && config.delayMinutes > 0
    ? config.delayMinutes
    : DEFAULT_AUTO_NAMING_DELAY_MINUTES;
  const namingDelayMs = namingDelayMinutes * 60_000;

  const namingSummary = {
    named: 0,
    skipped: 0,
    attempted: 0,
  };

  let allGroups;
  try {
    allGroups = await chrome.tabGroups.query({ windowId: Number(windowId) });
  } catch (error) {
    logger.warn('Auto group naming skipped: failed to query groups', {
      windowId,
      error: error.message,
    });
    return namingSummary;
  }

  for (const group of allGroups) {
    if (isManagedAgingGroup(group.id, windowId, windowState)) continue;

    const { baseName } = separateGroupTitleFromAgeSuffix(group.title || '');
    if (baseName.length > 0) {
      removeGroupNamingMetadata(windowEntry, group.id);
      continue;
    }

    const existingMetadata = getGroupNamingMetadata(windowEntry, group.id);
    const normalizedMetadata = normalizeGroupNamingMetadata(existingMetadata, now);
    setGroupNamingMetadata(windowEntry, group.id, normalizedMetadata);

    if (!isNamingEnabled) {
      namingSummary.skipped++;
      logger.debug('Auto group naming skipped', {
        windowId,
        groupId: group.id,
        reason: 'disabled',
      });
      continue;
    }

    if (now < normalizedMetadata.userEditLockUntil) {
      namingSummary.skipped++;
      logger.debug('Auto group naming skipped', {
        windowId,
        groupId: group.id,
        reason: 'user-edit-lock',
        userEditLockUntil: normalizedMetadata.userEditLockUntil,
      });
      continue;
    }

    const timeSinceFirstSeenUnnamed = now - normalizedMetadata.firstUnnamedSeenAt;
    if (timeSinceFirstSeenUnnamed < namingDelayMs) {
      namingSummary.skipped++;
      logger.debug('Auto group naming skipped', {
        windowId,
        groupId: group.id,
        reason: 'below-delay-threshold',
        unnamedDurationMs: timeSinceFirstSeenUnnamed,
        delayMs: namingDelayMs,
      });
      continue;
    }

    namingSummary.attempted++;

    let tabsInGroup;
    try {
      tabsInGroup = await chrome.tabs.query({ groupId: group.id });
    } catch (error) {
      namingSummary.skipped++;
      logger.warn('Auto group naming skipped: failed to query tabs', {
        windowId,
        groupId: group.id,
        error: error.message,
      });
      continue;
    }

    const generatedName = generateBestGroupNameFromTabs(tabsInGroup.filter((tab) => !tab.pinned));
    const normalizedCandidateName = normalizeCandidateToOneOrTwoWords(generatedName?.name) || 'Tabs';

    let liveGroupState;
    try {
      liveGroupState = await chrome.tabGroups.get(group.id);
    } catch (error) {
      namingSummary.skipped++;
      removeGroupNamingMetadata(windowEntry, group.id);
      logger.debug('Auto group naming skipped: group no longer exists', {
        windowId,
        groupId: group.id,
        error: error.message,
      });
      continue;
    }

    const currentTitle = liveGroupState?.title || '';
    const { baseName: currentBaseName, ageSuffix } = separateGroupTitleFromAgeSuffix(currentTitle);
    if (currentBaseName.length > 0) {
      namingSummary.skipped++;
      removeGroupNamingMetadata(windowEntry, group.id);
      logger.info('Auto group naming decision', {
        windowId,
        groupId: group.id,
        action: 'skipped',
        reason: 'group-named-before-write',
      });
      continue;
    }

    const latestMetadata = normalizeGroupNamingMetadata(getGroupNamingMetadata(windowEntry, group.id), now);
    setGroupNamingMetadata(windowEntry, group.id, latestMetadata);
    if (now < latestMetadata.userEditLockUntil) {
      namingSummary.skipped++;
      logger.info('Auto group naming decision', {
        windowId,
        groupId: group.id,
        action: 'skipped',
        reason: 'user-edit-lock-before-write',
      });
      continue;
    }

    const proposedTitle = combineGroupTitleWithAgeSuffix(normalizedCandidateName, ageSuffix);
    if (!proposedTitle || proposedTitle === currentTitle) {
      namingSummary.skipped++;
      setGroupNamingMetadata(windowEntry, group.id, {
        ...latestMetadata,
        lastAutoNamedAt: now,
        lastCandidate: normalizedCandidateName,
        userEditLockUntil: now,
      });
      logger.info('Auto group naming decision', {
        windowId,
        groupId: group.id,
        action: 'skipped',
        reason: 'no-title-change',
      });
      continue;
    }

    try {
      recordPendingExtensionTitleChange(group.id, proposedTitle, now);
      await chrome.tabGroups.update(group.id, { title: proposedTitle });
      namingSummary.named++;
      setGroupNamingMetadata(windowEntry, group.id, {
        ...latestMetadata,
        lastAutoNamedAt: now,
        lastCandidate: normalizedCandidateName,
        userEditLockUntil: now,
      });
      logger.info('Auto group naming decision', {
        windowId,
        groupId: group.id,
        action: 'named',
        candidate: normalizedCandidateName,
        candidateReason: generatedName.reason,
      });
    } catch (error) {
      namingSummary.skipped++;
      logger.warn('Auto group naming failed', {
        windowId,
        groupId: group.id,
        candidate: normalizedCandidateName,
        error: error.message,
      });
    }
  }

  return namingSummary;
}

/**
 * Appends an age suffix (e.g. "(2h)") to all user group titles in a window.
 */
export async function appendAgeToAllGroupTitles(windowId, tabMeta, windowState, activeTimeMs, settings) {
  let groupsUpdated = 0;
  try {
    const allGroups = await chrome.tabGroups.query({ windowId: Number(windowId) });

    for (const group of allGroups) {
      if (isManagedAgingGroup(group.id, windowId, windowState)) continue;

      const groupAge = calculateAgeOfFreshestTabInGroup(group.id, tabMeta, activeTimeMs, settings);
      if (groupAge === 0) continue;

      const { baseName } = separateGroupTitleFromAgeSuffix(group.title);
      const ageSuffix = `(${formatAgeAsShortString(groupAge)})`;
      const titleWithAge = combineGroupTitleWithAgeSuffix(baseName, ageSuffix);

      if (titleWithAge !== group.title) {
        try {
          recordPendingExtensionTitleChange(group.id, titleWithAge);
          const updateResult = await chrome.tabGroups.update(group.id, { title: titleWithAge });
          groupsUpdated++;
          logger.debug('Updated group title with age', { groupId: group.id, newTitle: titleWithAge, resultTitle: updateResult?.title });
        } catch (error) {
          logger.warn('Failed to update group title with age', {
            groupId: group.id,
            newTitle: titleWithAge,
            error: error.message,
          });
        }
      }
    }
  } catch (error) {
    logger.error('Failed to update group titles with age', {
      windowId,
      error: error.message,
    });
  }
  return { updated: groupsUpdated };
}

/**
 * Removes the age suffix from all group titles in a window.
 * Called when the "show group age" setting is turned off.
 */
export async function removeAgeSuffixFromAllGroupTitles(windowId, windowState) {
  try {
    const allGroups = await chrome.tabGroups.query({ windowId: Number(windowId) });
    for (const group of allGroups) {
      if (isManagedAgingGroup(group.id, windowId, windowState)) continue;
      const titleWithoutAge = removeAgeSuffixFromTitle(group.title);
      if (titleWithoutAge !== group.title) {
        try {
          recordPendingExtensionTitleChange(group.id, titleWithoutAge);
          await chrome.tabGroups.update(group.id, { title: titleWithoutAge });
        } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}

/**
 * Removes a tab from whatever group it's in.
 * Returns true on success, false on failure.
 */
export async function removeTabFromItsGroup(tabId) {
  try {
    await chrome.tabs.ungroup(tabId);
    return true;
  } catch (error) {
    logger.warn('Failed to ungroup tab', { tabId, error: error.message });
    return false;
  }
}

/**
 * Dissolves managed aging groups in a window: ungroups all tabs and clears references.
 * Called when tabSortingEnabled is turned off. Tabs stay in place — only the group wrapper is removed.
 */
export async function dissolveManagedGroupsInWindow(windowId, windowState) {
  const windowEntry = windowState[windowId] || windowState[String(windowId)];
  if (!windowEntry) return { dissolved: 0 };

  let groupsDissolved = 0;

  for (const groupType of ['yellow', 'red']) {
    const groupId = windowEntry.specialGroups[groupType];
    if (groupId === null) continue;

    try {
      const tabsInGroup = await chrome.tabs.query({ groupId });
      let allTabsUngrouped = true;
      for (const tab of tabsInGroup) {
        const wasUngrouped = await removeTabFromItsGroup(tab.id);
        if (!wasUngrouped) allTabsUngrouped = false;
      }
      if (allTabsUngrouped) {
        windowEntry.specialGroups[groupType] = null;
        groupsDissolved++;
        logger.debug('Dissolved special group', { windowId, type: groupType, groupId, tabCount: tabsInGroup.length });
      } else {
        logger.warn('Partial dissolution, retaining special group reference', { windowId, type: groupType, groupId });
      }
    } catch (error) {
      logger.warn('Failed to dissolve special group', { windowId, type: groupType, groupId, error: error.message });
    }
  }

  return { dissolved: groupsDissolved };
}
