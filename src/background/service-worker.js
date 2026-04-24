/**
 * TabCycle Service Worker — the orchestrator.
 *
 * This is the main entry point for the Chrome extension. It:
 *   - Registers event listeners for all Chrome tab, window, group, and alarm events
 *   - Runs the periodic evaluation cycle (every 30 seconds) that ages tabs
 *   - Coordinates tab placement, group sorting, auto-naming, and bookmarking
 *   - Reconciles state after browser restarts (URL-based tab matching)
 *   - Responds to settings changes reactively (dissolution, age caps, renames)
 *
 * State guards prevent race conditions between concurrent event handlers:
 *   - isEvaluationCycleInProgress: only one evaluation cycle at a time
 *   - isTabPlacementInProgress: suppresses onUpdated during placeNewTab
 *   - isSortUpdateInProgress: suppresses reactive handlers during debounced sort
 *   - isBrowserStartupInProgress: suppresses placement during session restore
 */

import { STORAGE_KEYS, EVALUATION_ALARM_NAME, EVALUATION_INTERVAL_MINUTES, DEFAULT_AGING_THRESHOLDS, DEFAULT_BOOKMARK_SETTINGS, DEFAULT_AUTO_NAMING_SETTINGS, DEFAULT_SHOW_AGE_IN_GROUP_TITLES, DEFAULT_AGING_FEATURE_TOGGLES, DEFAULT_STATUS_TRANSITION_TOGGLES, DEFAULT_MANAGED_GROUP_NAMES, DEFAULT_AUTO_GROUPING_SETTINGS, AGE_CALCULATION_MODE, TAB_LIFECYCLE_STAGE, ERROR_CODES, MANAGED_GROUP_TYPES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { readValidatedStateFromStorage, writeMultipleStateEntries } from './state-persistence.js';
import { createFreshTabMetadata, resetTabAgeAfterNavigation } from './tab-tracker.js';
import { findAllTabsNeedingStatusTransition } from './status-evaluator.js';
import {
  isManagedAgingGroup,
  getManagedGroupType,
  removeManagedGroupIfEmpty,
  removeTabFromItsGroup,
  sortTabsAndGroupsByLifecycleZone,
  dissolveUnnamedGroupsWithOnlyOneTab,
  dissolveManagedGroupsInWindow,
  autoNameUnnamedGroupsWhenReady,
  lockAutoNamingAfterUserEdit,
  acknowledgeExtensionTitleChangeIfExpected,
  acknowledgeExtensionColorChangeIfExpected,
  appendAgeToAllGroupTitles,
  removeAgeSuffixFromAllGroupTitles,
} from './group-manager.js';
import { placeNewlyCreatedTabNearItsContext } from './tab-placer.js';
import { findOrCreateBookmarkFolderForClosedTabs, isUrlWorthBookmarking, createBookmarkForSingleTab, createBookmarkSubfolderForTabGroup } from './bookmark-manager.js';
import {
  initializeActiveTimeInStorage,
  recoverActiveTimeAfterRestart,
  updateActiveTimeOnWindowFocusChange,
  saveActiveTimeToStorage,
  getCurrentTotalActiveTimeMs,
  getActiveTimeSnapshot,
} from './time-accumulator.js';

const logger = createLogger('background');
const USER_EDIT_LOCK_DURATION_MS = 15_000;

// ─── State Guards ─────────────────────────────────────────────────────────────

let isEvaluationCycleInProgress = false;
let evaluationCycleStartTimestamp = 0;
const EVALUATION_CYCLE_GUARD_TIMEOUT_MS = 60_000;

let isTabPlacementInProgress = false;

// Reference-counted guard for browser startup. Both onInstalled and onStartup
// may fire concurrently; the flag stays true until ALL startup handlers complete.
let activeStartupHandlerCount = 0;
let isBrowserStartupInProgress = false;
let pendingReconciliationPromise = null;
let startupReconciliationPending = false;
let startupReconciliationRetryTimer = null;
const tabsCurrentlyBeingResetByNavigation = new Set();

// Cache of each group's last-seen title and color, used by the onGroupUpdated
// handler to detect collapse/expand events (where only `collapsed` changed)
// and skip unnecessary sort scheduling.
const lastKnownGroupState = new Map();

// Cache of normal (browser) window IDs.  Tabs in non-normal windows (DevTools,
// popups, app windows) are excluded from all tracking so they never enter
// tabMeta.  Updated by windows.onCreated / onRemoved and seeded on startup.
const normalWindowIds = new Set();
const deferredStartupTabMetaById = new Map();
const STARTUP_RECONCILIATION_RETRY_DELAY_MS = 500;
let trackedStateMutationTail = Promise.resolve();

function isStartupStatePending() {
  return isBrowserStartupInProgress || startupReconciliationPending;
}

function scheduleStartupReconciliationRetry(trigger) {
  if (!startupReconciliationPending) return;
  if (startupReconciliationRetryTimer) clearTimeout(startupReconciliationRetryTimer);
  startupReconciliationRetryTimer = setTimeout(() => {
    startupReconciliationRetryTimer = null;
    void retryPendingStartupReconciliation(trigger);
  }, STARTUP_RECONCILIATION_RETRY_DELAY_MS);
}

function ensureRuntimeWindowStateEntry(windowId, windowState) {
  const normalizedWindowId = Number(windowId);
  if (!windowState[normalizedWindowId] || typeof windowState[normalizedWindowId] !== 'object') {
    windowState[normalizedWindowId] = {
      specialGroups: { yellow: null, red: null },
      groupZones: {},
      groupNaming: {},
    };
  }
  if (!windowState[normalizedWindowId].specialGroups || typeof windowState[normalizedWindowId].specialGroups !== 'object') {
    windowState[normalizedWindowId].specialGroups = { yellow: null, red: null };
  }
  if (windowState[normalizedWindowId].specialGroups.yellow === undefined) {
    windowState[normalizedWindowId].specialGroups.yellow = null;
  }
  if (windowState[normalizedWindowId].specialGroups.red === undefined) {
    windowState[normalizedWindowId].specialGroups.red = null;
  }
  if (!windowState[normalizedWindowId].groupZones || typeof windowState[normalizedWindowId].groupZones !== 'object') {
    windowState[normalizedWindowId].groupZones = {};
  }
  if (!windowState[normalizedWindowId].groupNaming || typeof windowState[normalizedWindowId].groupNaming !== 'object') {
    windowState[normalizedWindowId].groupNaming = {};
  }
  return windowState[normalizedWindowId];
}

function pickFresherTrackedEntry(candidate, currentBest) {
  if (!candidate) return currentBest;
  if (!currentBest) return candidate;
  if (candidate.refreshActiveTime > currentBest.refreshActiveTime) return candidate;
  if (candidate.refreshActiveTime < currentBest.refreshActiveTime) return currentBest;
  if (candidate.refreshWallTime > currentBest.refreshWallTime) return candidate;
  return currentBest;
}

function inferTrackedStatusFromGroup(windowId, groupId, windowState) {
  if (groupId === null || groupId === undefined) return null;
  const windowEntry = windowState[windowId] || windowState[String(windowId)];
  if (!windowEntry) return null;
  if (windowEntry.specialGroups?.yellow === groupId) return TAB_LIFECYCLE_STAGE.YELLOW;
  if (windowEntry.specialGroups?.red === groupId) return TAB_LIFECYCLE_STAGE.RED;
  const inferredStatus = windowEntry.groupZones?.[groupId] ?? windowEntry.groupZones?.[String(groupId)] ?? null;
  if (inferredStatus === TAB_LIFECYCLE_STAGE.GREEN
    || inferredStatus === TAB_LIFECYCLE_STAGE.YELLOW
    || inferredStatus === TAB_LIFECYCLE_STAGE.RED
    || inferredStatus === TAB_LIFECYCLE_STAGE.GONE) {
    return inferredStatus;
  }
  return null;
}

function createRecoveredTabMetadata(liveTab, tabMeta, windowState, currentActiveTime, settings) {
  const recoveredEntry = createFreshTabMetadata(liveTab, currentActiveTime);
  const actualGroupId = liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? liveTab.groupId : null;
  recoveredEntry.groupId = actualGroupId;
  recoveredEntry.url = liveTab.url || recoveredEntry.url || '';

  let freshestPeer = null;
  if (actualGroupId !== null) {
    for (const peerEntry of Object.values(tabMeta)) {
      if (!peerEntry || peerEntry.pinned) continue;
      if (Number(peerEntry.windowId) !== Number(liveTab.windowId)) continue;
      if (peerEntry.groupId !== actualGroupId) continue;
      freshestPeer = pickFresherTrackedEntry(peerEntry, freshestPeer);
    }
  }

  if (freshestPeer) {
    recoveredEntry.refreshActiveTime = freshestPeer.refreshActiveTime;
    recoveredEntry.refreshWallTime = freshestPeer.refreshWallTime;
    recoveredEntry.status = freshestPeer.status;
    recoveredEntry.isSpecialGroup = freshestPeer.isSpecialGroup === true;
    recoveredEntry.managedGroupType = freshestPeer.managedGroupType ?? null;
  } else {
    const inferredStatus = inferTrackedStatusFromGroup(liveTab.windowId, actualGroupId, windowState);
    if (inferredStatus === TAB_LIFECYCLE_STAGE.YELLOW
      || inferredStatus === TAB_LIFECYCLE_STAGE.RED
      || inferredStatus === TAB_LIFECYCLE_STAGE.GONE) {
      const thresholdMs = inferredStatus === TAB_LIFECYCLE_STAGE.YELLOW
        ? settings?.thresholds?.greenToYellow ?? DEFAULT_AGING_THRESHOLDS.GREEN_TO_YELLOW
        : inferredStatus === TAB_LIFECYCLE_STAGE.RED
          ? settings?.thresholds?.yellowToRed ?? DEFAULT_AGING_THRESHOLDS.YELLOW_TO_RED
          : settings?.thresholds?.redToGone ?? DEFAULT_AGING_THRESHOLDS.RED_TO_GONE;
      recoveredEntry.refreshActiveTime = Math.max(0, currentActiveTime - thresholdMs);
      recoveredEntry.refreshWallTime = Math.max(0, Date.now() - thresholdMs);
      recoveredEntry.status = inferredStatus;
    }
  }

  const windowEntry = windowState[liveTab.windowId] || windowState[String(liveTab.windowId)];
  if (actualGroupId !== null && windowEntry?.specialGroups) {
    if (windowEntry.specialGroups.yellow === actualGroupId) {
      recoveredEntry.isSpecialGroup = true;
      recoveredEntry.managedGroupType = MANAGED_GROUP_TYPES.YELLOW;
      if (recoveredEntry.status === TAB_LIFECYCLE_STAGE.GREEN) {
        recoveredEntry.status = TAB_LIFECYCLE_STAGE.YELLOW;
      }
    }
    if (windowEntry.specialGroups.red === actualGroupId) {
      recoveredEntry.isSpecialGroup = true;
      recoveredEntry.managedGroupType = MANAGED_GROUP_TYPES.RED;
      if (recoveredEntry.status === TAB_LIFECYCLE_STAGE.GREEN || recoveredEntry.status === TAB_LIFECYCLE_STAGE.YELLOW) {
        recoveredEntry.status = TAB_LIFECYCLE_STAGE.RED;
      }
    }
  }

  return recoveredEntry;
}

function chooseManagedGroupId(existingGroupId, candidateCounts, liveGroupIds) {
  if (existingGroupId !== null && existingGroupId !== undefined && liveGroupIds.has(existingGroupId)) {
    return existingGroupId;
  }
  let chosenGroupId = null;
  let chosenCount = -1;
  for (const [groupId, count] of candidateCounts.entries()) {
    if (!liveGroupIds.has(groupId)) continue;
    if (count > chosenCount) {
      chosenGroupId = groupId;
      chosenCount = count;
    }
  }
  return chosenGroupId;
}

async function mutateTrackedState(storageKeys, mutator) {
  const mutationPromise = trackedStateMutationTail.catch(() => undefined).then(async () => {
    const storedState = await readValidatedStateFromStorage(storageKeys);
    const writes = await mutator(storedState);
    if (writes && Object.keys(writes).length > 0) {
      await writeMultipleStateEntries(writes);
    }
    return writes;
  });
  trackedStateMutationTail = mutationPromise.then(() => undefined, () => undefined);
  return mutationPromise;
}

async function synchronizeTrackedStateWithBrowser(tabMeta, windowState, currentActiveTime, correlationId, targetWindowId = null, pruneMissingTabs = targetWindowId === null, settings = {}) {
  try {
    const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const liveNormalWindowIds = new Set(normalWindows.map((window) => window.id));
    const normalizedTargetWindowId = targetWindowId !== null ? Number(targetWindowId) : null;
    const scopedWindowIds = normalizedTargetWindowId !== null
      ? new Set(liveNormalWindowIds.has(normalizedTargetWindowId) ? [normalizedTargetWindowId] : [])
      : liveNormalWindowIds;

    if (scopedWindowIds.size === 0) {
      return { adoptedTabs: 0, prunedTabs: 0, repairedSpecialGroups: 0 };
    }

    let liveBrowserTabs = [];
    let liveBrowserGroups = [];
    if (normalizedTargetWindowId !== null) {
      [liveBrowserTabs, liveBrowserGroups] = await Promise.all([
        chrome.tabs.query({ windowId: normalizedTargetWindowId }),
        chrome.tabGroups.query({ windowId: normalizedTargetWindowId }),
      ]);
    } else {
      [liveBrowserTabs, liveBrowserGroups] = await Promise.all([
        chrome.tabs.query({}),
        chrome.tabGroups.query({}),
      ]);
      liveBrowserTabs = liveBrowserTabs.filter((tab) => liveNormalWindowIds.has(tab.windowId));
      liveBrowserGroups = liveBrowserGroups.filter((group) => liveNormalWindowIds.has(group.windowId));
    }

    const liveTrackableTabs = liveBrowserTabs.filter((tab) => scopedWindowIds.has(tab.windowId) && !tab.pinned);
    const liveTabIds = new Set(liveTrackableTabs.map((tab) => tab.id));
    const liveGroupIdsByWindow = new Map();
    for (const group of liveBrowserGroups) {
      if (!scopedWindowIds.has(group.windowId)) continue;
      const existingSet = liveGroupIdsByWindow.get(group.windowId) || new Set();
      existingSet.add(group.id);
      liveGroupIdsByWindow.set(group.windowId, existingSet);
    }

    let prunedTabs = 0;
    if (pruneMissingTabs) {
      for (const [tabIdKey, tabEntry] of Object.entries(tabMeta)) {
        const entryWindowId = Number(tabEntry.windowId);
        if (!scopedWindowIds.has(entryWindowId)) continue;
        const numericTabId = Number(tabIdKey);
        if (!liveTabIds.has(numericTabId)) {
          delete tabMeta[tabIdKey];
          prunedTabs++;
        }
      }
    }

    let adoptedTabs = 0;
    for (const liveTab of liveTrackableTabs) {
      const actualGroupId = liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? liveTab.groupId : null;
      let tabEntry = tabMeta[liveTab.id] || tabMeta[String(liveTab.id)];
      if (!tabEntry) {
        tabEntry = createRecoveredTabMetadata(liveTab, tabMeta, windowState, currentActiveTime, settings);
        tabMeta[liveTab.id] = tabEntry;
        adoptedTabs++;
      }
      tabEntry.tabId = liveTab.id;
      tabEntry.windowId = liveTab.windowId;
      tabEntry.groupId = actualGroupId;
      tabEntry.pinned = false;
      tabEntry.url = liveTab.url || tabEntry.url || '';
      if (tabEntry.managedGroupType !== MANAGED_GROUP_TYPES.YELLOW && tabEntry.managedGroupType !== MANAGED_GROUP_TYPES.RED) {
        tabEntry.managedGroupType = null;
      }
      if (actualGroupId === null) {
        tabEntry.isSpecialGroup = false;
        tabEntry.managedGroupType = null;
      }
    }

    if (normalizedTargetWindowId === null) {
      for (const windowIdKey of Object.keys(windowState)) {
        if (!liveNormalWindowIds.has(Number(windowIdKey))) {
          delete windowState[windowIdKey];
        }
      }
    }

    let repairedSpecialGroups = 0;
    for (const windowId of scopedWindowIds) {
      const windowEntry = ensureRuntimeWindowStateEntry(windowId, windowState);
      const liveGroupIds = liveGroupIdsByWindow.get(windowId) || new Set();
      const candidateCounts = {
        yellow: new Map(),
        red: new Map(),
      };

      for (const liveTab of liveTrackableTabs) {
        if (liveTab.windowId !== windowId) continue;
        const actualGroupId = liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? liveTab.groupId : null;
        if (actualGroupId === null) continue;
        const tabEntry = tabMeta[liveTab.id] || tabMeta[String(liveTab.id)];
        if (!tabEntry) continue;
        const managedGroupType = tabEntry.managedGroupType
          || (windowEntry.specialGroups.yellow === actualGroupId ? MANAGED_GROUP_TYPES.YELLOW : null)
          || (windowEntry.specialGroups.red === actualGroupId ? MANAGED_GROUP_TYPES.RED : null);
        if (!managedGroupType) continue;
        const existingCount = candidateCounts[managedGroupType].get(actualGroupId) || 0;
        candidateCounts[managedGroupType].set(actualGroupId, existingCount + 1);
      }

      for (const groupType of [MANAGED_GROUP_TYPES.YELLOW, MANAGED_GROUP_TYPES.RED]) {
        const previousGroupId = windowEntry.specialGroups[groupType];
        const nextGroupId = chooseManagedGroupId(previousGroupId, candidateCounts[groupType], liveGroupIds);
        if (previousGroupId !== nextGroupId) repairedSpecialGroups++;
        windowEntry.specialGroups[groupType] = nextGroupId;
      }

      for (const groupIdKey of Object.keys(windowEntry.groupZones)) {
        if (!liveGroupIds.has(Number(groupIdKey))) {
          delete windowEntry.groupZones[groupIdKey];
        }
      }
      for (const groupIdKey of Object.keys(windowEntry.groupNaming)) {
        if (!liveGroupIds.has(Number(groupIdKey))) {
          delete windowEntry.groupNaming[groupIdKey];
        }
      }
    }

    for (const liveTab of liveTrackableTabs) {
      const tabEntry = tabMeta[liveTab.id] || tabMeta[String(liveTab.id)];
      if (!tabEntry) continue;
      const liveGroupId = liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? liveTab.groupId : null;
      if (liveGroupId === null) {
        tabEntry.isSpecialGroup = false;
        tabEntry.managedGroupType = null;
        continue;
      }
      const windowEntry = ensureRuntimeWindowStateEntry(liveTab.windowId, windowState);
      const isYellowSpecialGroup = windowEntry.specialGroups.yellow === liveGroupId;
      const isRedSpecialGroup = windowEntry.specialGroups.red === liveGroupId;
      tabEntry.isSpecialGroup = isYellowSpecialGroup || isRedSpecialGroup;
      tabEntry.managedGroupType = isYellowSpecialGroup
        ? MANAGED_GROUP_TYPES.YELLOW
        : isRedSpecialGroup
          ? MANAGED_GROUP_TYPES.RED
          : null;
    }

    if (adoptedTabs > 0 || prunedTabs > 0 || repairedSpecialGroups > 0) {
      logger.info('Synchronized tracked state with live browser state', {
        windowId: normalizedTargetWindowId,
        adoptedTabs,
        prunedTabs,
        repairedSpecialGroups,
      }, correlationId);
    }

    return { adoptedTabs, prunedTabs, repairedSpecialGroups };
  } catch (error) {
    logger.warn('Failed to synchronize tracked state with browser', {
      windowId: targetWindowId,
      error: error.message,
    }, correlationId);
    return { adoptedTabs: 0, prunedTabs: 0, repairedSpecialGroups: 0 };
  }
}

/** Returns true if `windowId` belongs to a normal browser window.
 *  If the cache has not been seeded yet, defaults to true to avoid
 *  dropping tabs before startup completes. */
function isNormalWindow(windowId) {
  if (normalWindowIds.size === 0) return true;
  return normalWindowIds.has(windowId);
}

/** Seed the cache from Chrome's current window list. */
async function seedNormalWindowCache() {
  try {
    const allWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    normalWindowIds.clear();
    for (const w of allWindows) normalWindowIds.add(w.id);
  } catch (error) {
    logger.warn('Failed to seed normal window cache', { error: error.message });
  }
}

// ─── Debounced Sort & Title Update ───────────────────────────────────────────
// Reactive handlers (tab move, group change, etc.) schedule a debounced sort
// instead of immediately re-sorting, reducing lag and overlapping operations.

const SORT_DEBOUNCE_DELAY_MS = 300;
const pendingSortTimersByWindow = new Map();
let isSortUpdateInProgress = false;

function resolveAutoNamingConfiguration(settings) {
  const isEnabled = typeof settings?.autoGroupNamingEnabled === 'boolean'
    ? settings.autoGroupNamingEnabled
    : DEFAULT_AUTO_NAMING_SETTINGS.ENABLED;
  const delayMinutes = Number.isInteger(settings?.autoGroupNamingDelayMinutes)
    && settings.autoGroupNamingDelayMinutes > 0
    ? settings.autoGroupNamingDelayMinutes
    : DEFAULT_AUTO_NAMING_SETTINGS.DELAY_MINUTES;
  return { enabled: isEnabled, delayMinutes };
}

function scheduleDebouncedSortAndUpdate(windowId) {
  if (isEvaluationCycleInProgress || isSortUpdateInProgress || startupReconciliationPending) return;
  const existingTimer = pendingSortTimersByWindow.get(windowId);
  if (existingTimer) clearTimeout(existingTimer);
  pendingSortTimersByWindow.set(windowId, setTimeout(() => {
    pendingSortTimersByWindow.delete(windowId);
    executeSortAndUpdateForWindow(windowId);
  }, SORT_DEBOUNCE_DELAY_MS));
}

async function executeSortAndUpdateForWindow(windowId) {
  if (isEvaluationCycleInProgress || isSortUpdateInProgress) return;
  isSortUpdateInProgress = true;
  const correlationId = logger.correlationId();
  try {
    await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const settings = storedState[STORAGE_KEYS.SETTINGS] || {};
      const currentActiveTime = await getCurrentTotalActiveTimeMs();

      await synchronizeTrackedStateWithBrowser(tabMeta, windowState, currentActiveTime, correlationId, Number(windowId), true, settings);
      await dissolveUnnamedGroupsWithOnlyOneTab(windowId, tabMeta, windowState);

      const isAgingEnabled = settings.agingEnabled !== false;
      if (isAgingEnabled) {
        await sortTabsAndGroupsByLifecycleZone(windowId, tabMeta, windowState, undefined, settings);
      }

      const autoNamingConfig = resolveAutoNamingConfiguration(settings);
      await autoNameUnnamedGroupsWhenReady(windowId, tabMeta, windowState, autoNamingConfig);

      const shouldShowGroupAge = isAgingEnabled && (typeof settings.showGroupAge === 'boolean'
        ? settings.showGroupAge
        : DEFAULT_SHOW_AGE_IN_GROUP_TITLES);
      if (shouldShowGroupAge) {
        await appendAgeToAllGroupTitles(windowId, tabMeta, windowState, currentActiveTime, settings);
      } else {
        await removeAgeSuffixFromAllGroupTitles(windowId, windowState);
      }

      return {
        [STORAGE_KEYS.TAB_META]: tabMeta,
        [STORAGE_KEYS.WINDOW_STATE]: windowState,
      };
    });
    logger.debug('Debounced sort+update complete', { windowId }, correlationId);
  } catch (error) {
    logger.warn('Debounced sort+update failed', { windowId, error: error.message }, correlationId);
  } finally {
    isSortUpdateInProgress = false;
  }
}

// ─── Installation ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  const correlationId = logger.correlationId();
  logger.info('Extension installed/updated', { reason: details.reason }, correlationId);

  // Suppress navigation/focus handlers during install/update reconciliation to
  // prevent Chrome events (session restore navigations, tab loads) from racing
  // with reconciliation and resetting preserved tab ages.
  const needsStartupGuard = details.reason === 'update' || details.reason === 'install';
  if (needsStartupGuard) {
    activeStartupHandlerCount++; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
  }

  await seedNormalWindowCache();

  let isFreshInstall = false;
  let storedTabCount;
  try {
    if (details.reason === 'install') {
      const existingData = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
      const existingTabMeta = existingData[STORAGE_KEYS.TAB_META];
      storedTabCount = existingTabMeta ? Object.keys(existingTabMeta).length : 0;

      if (storedTabCount > 0) {
        logger.info('Existing tab data found on install — treating as reconciliation', {
          existingTabCount: storedTabCount,
        }, correlationId);
      } else {
        isFreshInstall = true;
        const defaultSettings = {
          timeMode: AGE_CALCULATION_MODE.ACTIVE,
          thresholds: {
            greenToYellow: DEFAULT_AGING_THRESHOLDS.GREEN_TO_YELLOW,
            yellowToRed: DEFAULT_AGING_THRESHOLDS.YELLOW_TO_RED,
            redToGone: DEFAULT_AGING_THRESHOLDS.RED_TO_GONE,
          },
          agingEnabled: DEFAULT_AGING_FEATURE_TOGGLES.AGING_ENABLED,
          tabSortingEnabled: DEFAULT_AGING_FEATURE_TOGGLES.TAB_SORTING_ENABLED,
          tabgroupSortingEnabled: DEFAULT_AGING_FEATURE_TOGGLES.TABGROUP_SORTING_ENABLED,
          tabgroupColoringEnabled: DEFAULT_AGING_FEATURE_TOGGLES.TABGROUP_COLORING_ENABLED,
          showGroupAge: DEFAULT_SHOW_AGE_IN_GROUP_TITLES,
          greenToYellowEnabled: DEFAULT_STATUS_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED,
          yellowToRedEnabled: DEFAULT_STATUS_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED,
          redToGoneEnabled: DEFAULT_STATUS_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED,
          yellowGroupName: DEFAULT_MANAGED_GROUP_NAMES.YELLOW_GROUP_NAME,
          redGroupName: DEFAULT_MANAGED_GROUP_NAMES.RED_GROUP_NAME,
          bookmarkEnabled: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED,
          bookmarkFolderName: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME,
          autoGroupEnabled: DEFAULT_AUTO_GROUPING_SETTINGS.ENABLED,
          autoGroupNamingEnabled: DEFAULT_AUTO_NAMING_SETTINGS.ENABLED,
          autoGroupNamingDelayMinutes: DEFAULT_AUTO_NAMING_SETTINGS.DELAY_MINUTES,
        };

        await writeMultipleStateEntries({
          [STORAGE_KEYS.SCHEMA_VERSION]: 2,
          [STORAGE_KEYS.SETTINGS]: defaultSettings,
          [STORAGE_KEYS.TAB_META]: {},
          [STORAGE_KEYS.WINDOW_STATE]: {},
          [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: null },
        });

        await initializeActiveTimeInStorage();
        logger.info('Storage initialized with defaults', null, correlationId);
      }
    }

    // Schema migration: v1 → v2
    if (details.reason === 'update') {
      const migrationState = await readValidatedStateFromStorage([STORAGE_KEYS.SCHEMA_VERSION, STORAGE_KEYS.SETTINGS]);
      const schemaVersion = migrationState[STORAGE_KEYS.SCHEMA_VERSION];
      if (schemaVersion === 1) {
        const existingSettings = migrationState[STORAGE_KEYS.SETTINGS] || {};
        const migratedSettings = {
          ...existingSettings,
          agingEnabled: existingSettings.agingEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.AGING_ENABLED,
          tabSortingEnabled: existingSettings.tabSortingEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.TAB_SORTING_ENABLED,
          tabgroupSortingEnabled: existingSettings.tabgroupSortingEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.TABGROUP_SORTING_ENABLED,
          tabgroupColoringEnabled: existingSettings.tabgroupColoringEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.TABGROUP_COLORING_ENABLED,
          greenToYellowEnabled: existingSettings.greenToYellowEnabled ?? DEFAULT_STATUS_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED,
          yellowToRedEnabled: existingSettings.yellowToRedEnabled ?? DEFAULT_STATUS_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED,
          redToGoneEnabled: existingSettings.redToGoneEnabled ?? DEFAULT_STATUS_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED,
          yellowGroupName: existingSettings.yellowGroupName ?? DEFAULT_MANAGED_GROUP_NAMES.YELLOW_GROUP_NAME,
          redGroupName: existingSettings.redGroupName ?? DEFAULT_MANAGED_GROUP_NAMES.RED_GROUP_NAME,
          autoGroupEnabled: existingSettings.autoGroupEnabled ?? DEFAULT_AUTO_GROUPING_SETTINGS.ENABLED,
        };
        await writeMultipleStateEntries({
          [STORAGE_KEYS.SCHEMA_VERSION]: 2,
          [STORAGE_KEYS.SETTINGS]: migratedSettings,
        });
        logger.info('Migrated settings from schema v1 to v2', { fieldsAdded: 10 }, correlationId);
      }
    }

    await chrome.alarms.create(EVALUATION_ALARM_NAME, { periodInMinutes: EVALUATION_INTERVAL_MINUTES });
    logger.info('Alarm created', { name: EVALUATION_ALARM_NAME, periodMinutes: EVALUATION_INTERVAL_MINUTES }, correlationId);

    if (isFreshInstall) {
      await scanAndTrackAllExistingTabs(correlationId);
    } else {
      const reconciliationResult = await reconcileStoredStateWithBrowser(correlationId);
      startupReconciliationPending = !reconciliationResult.completed;
      if (startupReconciliationPending) {
        scheduleStartupReconciliationRetry('onInstalled');
      }
    }

    if (!startupReconciliationPending) {
      await runTabAgingEvaluationCycle(correlationId);
      await probeAndSyncCurrentFocusState(correlationId);
    }
  } catch (error) {
    logger.error('onInstalled handler failed', { error: error.message, errorCode: ERROR_CODES.ERR_ALARM_CREATE }, correlationId);
  } finally {
    if (needsStartupGuard) {
      activeStartupHandlerCount--; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
      if (!isStartupStatePending()) {
        try {
          await flushDeferredStartupCreatedTabsIntoStorage(correlationId);
        } catch (flushError) {
          logger.warn('Failed to flush deferred startup tabs', { error: flushError.message }, correlationId);
        }
      }
      logger.info('Startup guard cleared (onInstalled)', { reason: details.reason, refCount: activeStartupHandlerCount }, correlationId);
    }
  }
});

/**
 * Probes Chrome for the currently focused window and syncs the active time
 * stopwatch.  After startup or extension reload, Chrome may not fire
 * windows.onFocusChanged, leaving focusStartTime null and active time frozen.
 */
async function probeAndSyncCurrentFocusState(correlationId) {
  try {
    const focusedWindow = await chrome.windows.getLastFocused();
    if (focusedWindow && focusedWindow.id !== chrome.windows.WINDOW_ID_NONE && focusedWindow.focused) {
      await updateActiveTimeOnWindowFocusChange(focusedWindow.id);
      await saveActiveTimeToStorage();
      logger.info('Probed focus state and started active time stopwatch', {
        windowId: focusedWindow.id,
      }, correlationId);
    }
  } catch (error) {
    logger.warn('Failed to probe focus state', { error: error.message }, correlationId);
  }
}

// ─── Browser Startup ─────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  activeStartupHandlerCount++; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
  startupReconciliationPending = true;
  const correlationId = logger.correlationId();
  logger.info('Browser startup detected', null, correlationId);

  await seedNormalWindowCache();

  try {
    await recoverActiveTimeAfterRestart();

    const existingAlarm = await chrome.alarms.get(EVALUATION_ALARM_NAME);
    if (!existingAlarm) {
      await chrome.alarms.create(EVALUATION_ALARM_NAME, { periodInMinutes: EVALUATION_INTERVAL_MINUTES });
      logger.info('Alarm recreated on startup', null, correlationId);
    }

    const reconciliationResult = await reconcileStoredStateWithBrowser(correlationId);
    startupReconciliationPending = !reconciliationResult.completed;

    if (startupReconciliationPending) {
      scheduleStartupReconciliationRetry('onStartup');
    } else {
      await runTabAgingEvaluationCycle(correlationId);

      // Probe Chrome for the currently focused window so the active time stopwatch
      // starts immediately.  On browser startup (and extension reload) Chrome may
      // not fire windows.onFocusChanged, leaving focusStartTime null and active
      // time frozen until the user manually switches windows.
      await probeAndSyncCurrentFocusState(correlationId);
    }
  } catch (error) {
    logger.error('onStartup handler failed', { error: error.message, errorCode: ERROR_CODES.ERR_RECOVERY }, correlationId);
  } finally {
    activeStartupHandlerCount--; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
    if (!isStartupStatePending()) {
      try {
        await flushDeferredStartupCreatedTabsIntoStorage(correlationId);
      } catch (flushError) {
        logger.warn('Failed to flush deferred startup tabs', { error: flushError.message }, correlationId);
      }
    }
    logger.info('Startup guard cleared', { refCount: activeStartupHandlerCount }, correlationId);
  }
});

// ─── Alarm (Evaluation Cycle) ────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== EVALUATION_ALARM_NAME) return;

  const correlationId = logger.correlationId();
  logger.debug('Alarm fired', { name: alarm.name }, correlationId);
  try {
    await runTabAgingEvaluationCycle(correlationId);
  } catch (error) {
    logger.error('Evaluation cycle failed', { error: error.message, stack: error.stack }, correlationId);
  }
});

// Exposed on globalThis for E2E test harness (CDP) to call directly.
self.__runEvaluationCycle = runTabAgingEvaluationCycle;
self.__resetTabAgeOnUserNavigation = resetTabAgeOnUserNavigation;
 self.__resetServiceWorkerDebugState = () => {
  isEvaluationCycleInProgress = false;
  evaluationCycleStartTimestamp = 0;
  isSortUpdateInProgress = false;
  isTabPlacementInProgress = false;
  isBrowserStartupInProgress = false;
  activeStartupHandlerCount = 0;
  startupReconciliationPending = false;
  pendingReconciliationPromise = null;
  trackedStateMutationTail = Promise.resolve();
  deferredStartupTabMetaById.clear();
  tabsCurrentlyBeingResetByNavigation.clear();
  lastNavigationTimestampByTab.clear();
  tabRestoredFromDiscardTimestamp.clear();
  lastKnownGroupState.clear();
  normalWindowIds.clear();
  if (startupReconciliationRetryTimer) {
    clearTimeout(startupReconciliationRetryTimer);
    startupReconciliationRetryTimer = null;
  }
  for (const timer of pendingSortTimersByWindow.values()) {
    clearTimeout(timer);
  }
  pendingSortTimersByWindow.clear();
  if (pendingFocusRefreshTimer !== null) {
    clearTimeout(pendingFocusRefreshTimer);
    pendingFocusRefreshTimer = null;
  }
 };
Object.defineProperty(self, '__evaluationCycleRunning', {
  configurable: true,
  get() { return isEvaluationCycleInProgress; },
});
Object.defineProperty(self, '__sortUpdateRunning', {
  configurable: true,
  get() { return isSortUpdateInProgress; },
});

/**
 * Runs the tab aging evaluation cycle with a guard to prevent concurrent execution.
 * If a cycle is already running and hasn't timed out (60s), the new call is skipped.
 */
async function runTabAgingEvaluationCycle(correlationId) {
  if (isEvaluationCycleInProgress) {
    const elapsedMs = Date.now() - evaluationCycleStartTimestamp;
    if (elapsedMs < EVALUATION_CYCLE_GUARD_TIMEOUT_MS) {
      logger.debug('Evaluation cycle already running, skipping', { elapsedMs }, correlationId);
      return;
    }
    logger.warn('Evaluation cycle guard timed out, resetting', { elapsedMs }, correlationId);
  }
  isEvaluationCycleInProgress = true;
  evaluationCycleStartTimestamp = Date.now();
  try {
    await executeTabAgingEvaluation(correlationId);
  } finally {
    isEvaluationCycleInProgress = false;
  }
}

 /**
  * The inner evaluation cycle logic. Evaluates all tab ages, applies status
  * transitions, sorts tabs/groups, handles gone tabs, and updates titles.
  */
 async function executeTabAgingEvaluation(correlationId) {
  if (startupReconciliationPending) {
    logger.info('Startup reconciliation pending, skipping evaluation cycle', null, correlationId);
    return;
  }

  await saveActiveTimeToStorage();

  await mutateTrackedState([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TAB_META,
    STORAGE_KEYS.WINDOW_STATE,
  ], async (storedState) => {
    const settings = storedState[STORAGE_KEYS.SETTINGS];
    if (!settings) {
      logger.error('Settings missing from storage, skipping evaluation cycle. Reinstall extension or check storage.', {}, correlationId);
      return {};
    }

    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
    const currentActiveTime = await getCurrentTotalActiveTimeMs();

    const isAgingEnabled = settings.agingEnabled !== false;
    if (!isAgingEnabled) {
      logger.debug('Aging disabled, skipping evaluation cycle', {
        tabCount: Object.keys(tabMeta).length,
      }, correlationId);
      return {};
    }

    const activeTimeState = await getActiveTimeSnapshot();
    logger.info('Evaluation cycle start', {
      timeMode: settings.timeMode,
      currentActiveTimeMs: currentActiveTime,
      accumulatedMs: activeTimeState.accumulatedMs,
      focusStartTime: activeTimeState.focusStartTime,
      thresholds: settings.thresholds,
      tabCount: Object.keys(tabMeta).length,
    }, correlationId);

    for (const [tabId, tabEntry] of Object.entries(tabMeta)) {
      if (!isNormalWindow(tabEntry.windowId)) {
        delete tabMeta[tabId];
      }
    }

    await synchronizeTrackedStateWithBrowser(tabMeta, windowState, currentActiveTime, correlationId, null, true, settings);

    const tabsWithChangedStatus = findAllTabsNeedingStatusTransition(tabMeta, currentActiveTime, settings);
    const transitionCount = Object.keys(tabsWithChangedStatus).length;

    for (const [tabId, transition] of Object.entries(tabsWithChangedStatus)) {
      if (tabsCurrentlyBeingResetByNavigation.has(Number(tabId))) continue;
      tabMeta[tabId].status = transition.newStatus;
    }

    const isBookmarkEnabled = typeof settings.bookmarkEnabled === 'boolean'
      ? settings.bookmarkEnabled
      : DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED;
    let bookmarkFolderId = null;

    const hasAnyGoneTabs = Object.values(tabMeta).some((entry) => entry.status === TAB_LIFECYCLE_STAGE.GONE);
    if (isBookmarkEnabled && hasAnyGoneTabs) {
      bookmarkFolderId = await findOrCreateBookmarkFolderForClosedTabs(settings);
      logger.debug('Bookmark folder resolved for gone handling', { bookmarkFolderId, bookmarkEnabled: isBookmarkEnabled }, correlationId);
    }

    const goneHandlingConfig = {
      bookmarkEnabled: isBookmarkEnabled,
      bookmarkFolderId,
      bookmarkTab: createBookmarkForSingleTab,
      bookmarkGroupTabs: createBookmarkSubfolderForTabGroup,
      isBookmarkableUrl: isUrlWorthBookmarking,
    };

    let liveNormalWindowIds;
    try {
      const liveWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      liveNormalWindowIds = new Set(liveWindows.map((w) => w.id));
    } catch (error) {
      logger.warn('Failed to query live windows, falling back to tabMeta window IDs', { error: error.message }, correlationId);
      liveNormalWindowIds = new Set(Object.values(tabMeta).map((entry) => entry.windowId));
    }
    const allWindowIds = liveNormalWindowIds;
    const autoNamingConfig = resolveAutoNamingConfiguration(settings);

    for (const windowId of allWindowIds) {
      await dissolveUnnamedGroupsWithOnlyOneTab(windowId, tabMeta, windowState);
      await sortTabsAndGroupsByLifecycleZone(windowId, tabMeta, windowState, goneHandlingConfig, settings);
      await autoNameUnnamedGroupsWhenReady(windowId, tabMeta, windowState, autoNamingConfig);

      const shouldShowGroupAge = typeof settings.showGroupAge === 'boolean'
        ? settings.showGroupAge
        : DEFAULT_SHOW_AGE_IN_GROUP_TITLES;
      logger.debug('showGroupAge resolved', { showGroupAge: shouldShowGroupAge, settingsValue: settings.showGroupAge, default: DEFAULT_SHOW_AGE_IN_GROUP_TITLES });
      if (shouldShowGroupAge) {
        await appendAgeToAllGroupTitles(windowId, tabMeta, windowState, currentActiveTime, settings);
      } else {
        await removeAgeSuffixFromAllGroupTitles(windowId, windowState);
      }
    }

    if (transitionCount > 0) {
      logger.info('Evaluation cycle complete with transitions', {
        tabCount: Object.keys(tabMeta).length,
        transitions: transitionCount,
        currentActiveTimeMs: currentActiveTime,
      }, correlationId);
    } else {
      logger.debug('Evaluation cycle complete, no transitions', {
        tabCount: Object.keys(tabMeta).length,
        currentActiveTimeMs: currentActiveTime,
      }, correlationId);
    }

    return {
      [STORAGE_KEYS.TAB_META]: tabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: windowState,
    };
  });
 }

// ─── Tab Events ──────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener(async (tab) => {
  const correlationId = logger.correlationId();
  try {
    if (tab.pinned || !isNormalWindow(tab.windowId)) {
      return;
    }

    if (isStartupStatePending()) {
      if (!deferredStartupTabMetaById.has(tab.id)) {
        const currentActiveTime = await getCurrentTotalActiveTimeMs();
        deferredStartupTabMetaById.set(tab.id, createFreshTabMetadata(tab, currentActiveTime));
      }
      scheduleStartupReconciliationRetry('tab-created-during-startup');
      logger.debug('Startup in progress, skipping tab placement', { tabId: tab.id, windowId: tab.windowId }, correlationId);
      return;
    }

    const currentActiveTime = await getCurrentTotalActiveTimeMs();
    isTabPlacementInProgress = true;
    try {
      await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS], async (storedState) => {
        const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
        const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
        const settings = storedState[STORAGE_KEYS.SETTINGS] || {};

        if (!tabMeta[tab.id] && !tabMeta[String(tab.id)]) {
          tabMeta[tab.id] = createFreshTabMetadata(tab, currentActiveTime);
        }

        await placeNewlyCreatedTabNearItsContext(tab, tab.windowId, tabMeta, windowState, settings);
        return { [STORAGE_KEYS.TAB_META]: tabMeta };
      });
    } finally {
      isTabPlacementInProgress = false;
    }
    logger.debug('Tab created', { tabId: tab.id, windowId: tab.windowId }, correlationId);
    scheduleDebouncedSortAndUpdate(tab.windowId);
  } catch (error) {
    logger.error('onCreated handler failed', { tabId: tab.id, error: error.message }, correlationId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (isEvaluationCycleInProgress || isSortUpdateInProgress) return;
  const correlationId = logger.correlationId();
  try {
    lastNavigationTimestampByTab.delete(tabId);
    tabRestoredFromDiscardTimestamp.delete(tabId);
    if (removeInfo.isWindowClosing) {
      logger.debug('Tab removed due to window closing, skipping', { tabId }, correlationId);
      return;
    }
    await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const removedTabMetadata = tabMeta[tabId] || tabMeta[String(tabId)] || null;

      delete tabMeta[tabId];
      delete tabMeta[String(tabId)];

      if (removedTabMetadata && removedTabMetadata.isSpecialGroup && removedTabMetadata.groupId !== null) {
        const managedGroupType = getManagedGroupType(removedTabMetadata.groupId, removeInfo.windowId, windowState);
        if (managedGroupType) {
          await removeManagedGroupIfEmpty(removeInfo.windowId, managedGroupType, windowState);
        }
      }

      await dissolveUnnamedGroupsWithOnlyOneTab(removeInfo.windowId, tabMeta, windowState);

      return {
        [STORAGE_KEYS.TAB_META]: tabMeta,
        [STORAGE_KEYS.WINDOW_STATE]: windowState,
      };
    });

    logger.debug('Tab removed', { tabId, windowId: removeInfo.windowId }, correlationId);
    scheduleDebouncedSortAndUpdate(removeInfo.windowId);
  } catch (error) {
    logger.error('onRemoved handler failed', { tabId, error: error.message }, correlationId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (startupReconciliationPending) {
    if (changeInfo.url !== undefined || changeInfo.groupId !== undefined || changeInfo.status === 'complete') {
      scheduleStartupReconciliationRetry('tab-updated-during-startup');
    }
    return;
  }

  const correlationId = logger.correlationId();

  if (changeInfo.discarded === false) {
    tabRestoredFromDiscardTimestamp.set(tabId, Date.now());
    logger.debug('Tab restored from discarded state', { tabId, windowId: tab.windowId }, correlationId);
  }

  if (changeInfo.groupId !== undefined && !isEvaluationCycleInProgress && !isTabPlacementInProgress && !isSortUpdateInProgress && !tabsCurrentlyBeingResetByNavigation.has(tabId)) {
    try {
      await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE], async (storedState) => {
        const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
        const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
        let tabEntry = tabMeta[tabId] || tabMeta[String(tabId)];
        if (!tabEntry && tab && !tab.pinned && isNormalWindow(tab.windowId)) {
          const currentActiveTime = await getCurrentTotalActiveTimeMs();
          tabEntry = createFreshTabMetadata(tab, currentActiveTime);
          tabMeta[tabId] = tabEntry;
        }
        const newGroupId = changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? changeInfo.groupId : null;
        if (tabEntry) {
          const previousGroupId = tabEntry.groupId;
          tabEntry.groupId = newGroupId;
          tabEntry.isSpecialGroup = newGroupId !== null && isManagedAgingGroup(newGroupId, tab.windowId, windowState);
          tabEntry.managedGroupType = tabEntry.isSpecialGroup
            ? getManagedGroupType(newGroupId, tab.windowId, windowState)
            : null;
          logger.debug('Tab group changed', { tabId, oldGroupId: previousGroupId, newGroupId, windowId: tab.windowId }, correlationId);
        }
        await dissolveUnnamedGroupsWithOnlyOneTab(tab.windowId, tabMeta, windowState);
        return { [STORAGE_KEYS.TAB_META]: tabMeta };
      });
      scheduleDebouncedSortAndUpdate(tab.windowId);
    } catch (error) {
      logger.error('onUpdated groupId handler failed', { tabId, error: error.message }, correlationId);
    }
  }
  if (changeInfo.pinned !== undefined) {
    try {
      await mutateTrackedState([STORAGE_KEYS.TAB_META], async (storedState) => {
        const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
        if (changeInfo.pinned) {
          delete tabMeta[tabId];
          delete tabMeta[String(tabId)];
          logger.debug('Tab pinned, removed from tracking', { tabId }, correlationId);
        } else if (isNormalWindow(tab.windowId)) {
          const currentActiveTime = await getCurrentTotalActiveTimeMs();
          tabMeta[tabId] = createFreshTabMetadata(tab, currentActiveTime);
          logger.debug('Tab unpinned, added as fresh green', { tabId }, correlationId);
        }
        return { [STORAGE_KEYS.TAB_META]: tabMeta };
      });
    } catch (error) {
      logger.error('onUpdated pinned handler failed', { tabId, error: error.message }, correlationId);
    }
  }
});

// ─── Tab Moved (backup dissolution trigger) ─────────────────────────────────

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  if (isEvaluationCycleInProgress || isSortUpdateInProgress) return;
  if (tabsCurrentlyBeingResetByNavigation.has(tabId)) return;
  const correlationId = logger.correlationId();
  try {
    await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const { dissolved } = await dissolveUnnamedGroupsWithOnlyOneTab(moveInfo.windowId, tabMeta, windowState);
      if (dissolved > 0) {
        logger.debug('Dissolved groups after tab move', { tabId, windowId: moveInfo.windowId, dissolved }, correlationId);
        return { [STORAGE_KEYS.TAB_META]: tabMeta };
      }
      return {};
    });
    scheduleDebouncedSortAndUpdate(moveInfo.windowId);
  } catch (error) {
    logger.warn('onMoved dissolution check failed', { tabId, error: error.message }, correlationId);
  }
});

// ─── Tab Activation (Focus-Based Refresh) ────────────────────────────────────
// When a tab stays focused for 15+ seconds, reset its age to green.
// This treats sustained viewing as active user engagement with the tab.

const SUSTAINED_FOCUS_REFRESH_DELAY_MS = 15_000;
let pendingFocusRefreshTimer = null;

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (pendingFocusRefreshTimer !== null) {
    clearTimeout(pendingFocusRefreshTimer);
    pendingFocusRefreshTimer = null;
  }

  if (isStartupStatePending()) return;

  const { tabId, windowId } = activeInfo;
  pendingFocusRefreshTimer = setTimeout(() => {
    pendingFocusRefreshTimer = null;
    refreshTabAgeAfterSustainedFocus(tabId, windowId);
  }, SUSTAINED_FOCUS_REFRESH_DELAY_MS);
});

/**
 * Refreshes a tab's age to green after 15 seconds of sustained focus.
 * If the tab was in a managed aging group, it's ungrouped and moved to the green zone.
 */
async function refreshTabAgeAfterSustainedFocus(tabId, windowId) {
  const correlationId = logger.correlationId();
  tabsCurrentlyBeingResetByNavigation.add(tabId);
  try {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
      if (tab.pinned || !isNormalWindow(tab.windowId)) return;
    } catch { return; }

    await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const settings = storedState[STORAGE_KEYS.SETTINGS] || {};
      const currentActiveTime = await getCurrentTotalActiveTimeMs();

      await synchronizeTrackedStateWithBrowser(tabMeta, windowState, currentActiveTime, correlationId, tab.windowId, false, settings);
      const existingEntry = tabMeta[tabId] || tabMeta[String(tabId)];
      if (!existingEntry) return {};

      const refreshedEntry = resetTabAgeAfterNavigation(existingEntry, currentActiveTime, existingEntry.url);
      tabMeta[tabId] = refreshedEntry;

      let isInManagedGroup = existingEntry.isSpecialGroup && existingEntry.groupId !== null;
      let managedGroupId = isInManagedGroup ? existingEntry.groupId : null;

      if (!isInManagedGroup) {
        const liveGroupId = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
          ? tab.groupId : null;
        if (liveGroupId !== null && isManagedAgingGroup(liveGroupId, tab.windowId, windowState)) {
          isInManagedGroup = true;
          managedGroupId = liveGroupId;
          refreshedEntry.groupId = liveGroupId;
          refreshedEntry.isSpecialGroup = true;
          refreshedEntry.managedGroupType = getManagedGroupType(liveGroupId, tab.windowId, windowState);
        }
      }

      if (isInManagedGroup) {
        await removeTabFromItsGroup(tabId);
        refreshedEntry.groupId = null;
        refreshedEntry.isSpecialGroup = false;
        refreshedEntry.managedGroupType = null;
        tabMeta[tabId] = refreshedEntry;

        try {
          await chrome.tabs.move(tabId, { index: 0 });
        } catch (moveError) {
          logger.warn('Failed to move ungrouped tab to green zone', {
            tabId,
            error: moveError.message,
          }, correlationId);
        }

        const groupType = getManagedGroupType(managedGroupId, existingEntry.windowId, windowState);
        if (groupType) {
          await removeManagedGroupIfEmpty(existingEntry.windowId, groupType, windowState);
        }

        logger.debug('Focus refresh: tab removed from special group', {
          tabId, specialGroupId: managedGroupId, windowId: existingEntry.windowId,
        }, correlationId);
      }

      const isAgingEnabled = settings.agingEnabled !== false;
      if (isAgingEnabled) {
        await sortTabsAndGroupsByLifecycleZone(existingEntry.windowId, tabMeta, windowState, undefined, settings);
      }

      logger.debug('Focus-based age refresh applied', { tabId, windowId }, correlationId);
      return { [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: windowState };
    });
  } catch (error) {
    logger.error('Focus refresh handler failed', { tabId, error: error.message }, correlationId);
  } finally {
    tabsCurrentlyBeingResetByNavigation.delete(tabId);
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────

const NAVIGATION_DEBOUNCE_DELAY_MS = 1000;
const lastNavigationTimestampByTab = new Map();
const DISCARD_RESTORE_SUPPRESSION_WINDOW_MS = 5000;
const tabRestoredFromDiscardTimestamp = new Map();

/**
 * Checks if a tab was just restored from a discarded state.
 * If so, consumes the marker and returns true (meaning we should suppress
 * the navigation event, since it's Chrome lazily loading the tab, not user action).
 */
function checkAndClearDiscardRestoreMarker(tabId, currentTime) {
  const restoredAt = tabRestoredFromDiscardTimestamp.get(tabId);
  if (!restoredAt) return false;
  if (currentTime - restoredAt > DISCARD_RESTORE_SUPPRESSION_WINDOW_MS) {
    tabRestoredFromDiscardTimestamp.delete(tabId);
    return false;
  }
  tabRestoredFromDiscardTimestamp.delete(tabId);
  return true;
}

/**
 * Resets a tab's age when the user navigates to a new page.
 * Suppresses non-user navigations (session restore, discarded tab reload, same-URL reload).
 * If the tab was in a managed group, it's ungrouped and moved to the green zone.
 */
async function resetTabAgeOnUserNavigation(tabId, eventSource, eventUrl = '') {
  if (isStartupStatePending()) {
    self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'startup-pending' };
    return self.__lastNavigationResetDebug;
  }

  const now = Date.now();
  const lastHandledAt = lastNavigationTimestampByTab.get(tabId) || 0;
  if (now - lastHandledAt < NAVIGATION_DEBOUNCE_DELAY_MS) {
    logger.debug('Navigation debounced', { tabId, source: eventSource, sinceLast: now - lastHandledAt });
    self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'debounced', sinceLast: now - lastHandledAt };
    return self.__lastNavigationResetDebug;
  }
  lastNavigationTimestampByTab.set(tabId, now);

  const correlationId = logger.correlationId();
  tabsCurrentlyBeingResetByNavigation.add(tabId);
  try {
    if (checkAndClearDiscardRestoreMarker(tabId, now)) {
      logger.debug('Ignoring navigation immediately after discarded-tab restore', { tabId, source: eventSource }, correlationId);
      self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'discard-restore-suppressed' };
      return self.__lastNavigationResetDebug;
    }

    let navigatedToUrl = eventUrl || '';
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
      if (tab.discarded || tab.status === 'unloaded') {
        logger.debug('Ignoring navigation for discarded/suspended tab', { tabId, source: eventSource }, correlationId);
        self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'discarded-or-unloaded' };
        return self.__lastNavigationResetDebug;
      }
      if (!isNormalWindow(tab.windowId)) {
        self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'non-normal-window', windowId: tab.windowId };
        return self.__lastNavigationResetDebug;
      }
      if (!navigatedToUrl) {
        navigatedToUrl = tab.url || '';
      }
    } catch {
      self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'tab-gone-before-read' };
      return self.__lastNavigationResetDebug;
    }

    const result = await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const settings = storedState[STORAGE_KEYS.SETTINGS] || {};
      const currentActiveTime = await getCurrentTotalActiveTimeMs();
      const preSyncEntry = tabMeta[tabId] || tabMeta[String(tabId)] || null;
      const preSyncUrl = preSyncEntry?.url || '';

      await synchronizeTrackedStateWithBrowser(tabMeta, windowState, currentActiveTime, correlationId, tab.windowId, false, settings);
      const existingEntry = tabMeta[tabId] || tabMeta[String(tabId)];
      if (!existingEntry) {
        logger.debug('Navigation for untracked tab, skipping', { tabId, source: eventSource }, correlationId);
        self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'untracked-tab', windowId: tab.windowId };
        return {};
      }

      if (navigatedToUrl && preSyncUrl && navigatedToUrl === preSyncUrl) {
        logger.debug('Navigation URL matches stored URL, suppressing age reset', { tabId, source: eventSource, url: navigatedToUrl }, correlationId);
        self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'same-url', url: navigatedToUrl };
        return {};
      }

      const refreshedEntry = resetTabAgeAfterNavigation(existingEntry, currentActiveTime, navigatedToUrl);
      tabMeta[tabId] = refreshedEntry;

      let isInManagedGroup = existingEntry.isSpecialGroup && existingEntry.groupId !== null;
      let managedGroupId = isInManagedGroup ? existingEntry.groupId : null;

      if (!isInManagedGroup) {
        try {
          const liveTab = await chrome.tabs.get(tabId);
          const liveGroupId = liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
            ? liveTab.groupId : null;
          if (liveGroupId !== null && isManagedAgingGroup(liveGroupId, liveTab.windowId, windowState)) {
            isInManagedGroup = true;
            managedGroupId = liveGroupId;
            refreshedEntry.groupId = liveGroupId;
            refreshedEntry.isSpecialGroup = true;
            refreshedEntry.managedGroupType = getManagedGroupType(liveGroupId, liveTab.windowId, windowState);
          }
        } catch { }
      }

      if (isInManagedGroup) {
        await removeTabFromItsGroup(tabId);
        refreshedEntry.groupId = null;
        refreshedEntry.isSpecialGroup = false;
        refreshedEntry.managedGroupType = null;
        tabMeta[tabId] = refreshedEntry;

        try {
          await chrome.tabs.move(tabId, { index: 0 });
        } catch (moveError) {
          logger.warn('Failed to move ungrouped tab to green zone', {
            tabId,
            error: moveError.message,
          }, correlationId);
        }

        const groupType = getManagedGroupType(managedGroupId, existingEntry.windowId, windowState);
        if (groupType) {
          await removeManagedGroupIfEmpty(existingEntry.windowId, groupType, windowState);
        }

        logger.debug('Tab navigated out of special group', {
          tabId, specialGroupId: managedGroupId, windowId: existingEntry.windowId,
        }, correlationId);
      }

      const isAgingEnabled = settings.agingEnabled !== false;
      if (isAgingEnabled) {
        await sortTabsAndGroupsByLifecycleZone(existingEntry.windowId, tabMeta, windowState, undefined, settings);
      }

      self.__lastNavigationResetDebug = {
        tabId,
        source: eventSource,
        outcome: 'handled',
        windowId: existingEntry.windowId,
        navigatedToUrl,
        status: refreshedEntry.status,
        groupId: refreshedEntry.groupId,
        isSpecialGroup: refreshedEntry.isSpecialGroup,
      };

      return { [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: windowState };
    });

    if (!result || Object.keys(result).length === 0) {
      return self.__lastNavigationResetDebug;
    }

    logger.debug('Navigation handled, refresh time reset', { tabId, source: eventSource }, correlationId);
    return self.__lastNavigationResetDebug;
  } catch (error) {
    logger.error('Navigation handler failed', { tabId, source: eventSource, error: error.message }, correlationId);
    self.__lastNavigationResetDebug = { tabId, source: eventSource, outcome: 'error', error: error.message };
    return self.__lastNavigationResetDebug;
  } finally {
    tabsCurrentlyBeingResetByNavigation.delete(tabId);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await resetTabAgeOnUserNavigation(details.tabId, 'onCommitted', details.url || '');
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await resetTabAgeOnUserNavigation(details.tabId, 'onHistoryStateUpdated', details.url || '');
});

// ─── Window Focus ────────────────────────────────────────────────────────────

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const correlationId = logger.correlationId();
  try {
    const updatedState = await updateActiveTimeOnWindowFocusChange(windowId);
    if (updatedState) {
      await saveActiveTimeToStorage();
    }
    logger.debug('Window focus changed', { windowId }, correlationId);
  } catch (error) {
    logger.error('onFocusChanged handler failed', { windowId, error: error.message }, correlationId);
  }
});

// ─── Window Created / Removed ────────────────────────────────────────────────

chrome.windows.onCreated.addListener((window) => {
  if (window.type === 'normal') normalWindowIds.add(window.id);
  if (window.type === 'normal' && startupReconciliationPending) {
    scheduleStartupReconciliationRetry('window-created-during-startup');
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  normalWindowIds.delete(windowId);
  const correlationId = logger.correlationId();
  try {
    await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};

      for (const [tabId, tabEntry] of Object.entries(tabMeta)) {
        if (tabEntry.windowId === windowId || tabEntry.windowId === Number(windowId)) {
          delete tabMeta[tabId];
        }
      }

      delete windowState[windowId];
      delete windowState[String(windowId)];

      return {
        [STORAGE_KEYS.TAB_META]: tabMeta,
        [STORAGE_KEYS.WINDOW_STATE]: windowState,
      };
    });
    logger.info('Window removed, state cleaned up', { windowId }, correlationId);
  } catch (error) {
    logger.error('onWindowRemoved handler failed', { windowId, error: error.message }, correlationId);
  }
});

// ─── Tab Detach/Attach (Cross-Window Moves) ──────────────────────────────────

chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
  const correlationId = logger.correlationId();
  logger.debug('Tab detached', { tabId, oldWindowId: detachInfo.oldWindowId }, correlationId);
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const correlationId = logger.correlationId();
  try {
    await mutateTrackedState([STORAGE_KEYS.TAB_META], async (storedState) => {
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const tabEntry = tabMeta[tabId] || tabMeta[String(tabId)];
      if (!tabEntry) return {};
      tabEntry.windowId = attachInfo.newWindowId;
      tabEntry.groupId = null;
      tabEntry.isSpecialGroup = false;
      tabEntry.managedGroupType = null;
      return { [STORAGE_KEYS.TAB_META]: tabMeta };
    });
    logger.debug('Tab attached to new window, meta updated', {
      tabId,
      newWindowId: attachInfo.newWindowId,
    }, correlationId);
    scheduleDebouncedSortAndUpdate(attachInfo.newWindowId);
  } catch (error) {
    logger.error('onAttached handler failed', { tabId, error: error.message }, correlationId);
  }
});

// ─── Tab Group Events ────────────────────────────────────────────────────────

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const correlationId = logger.correlationId();
  try {
    const writes = await mutateTrackedState([STORAGE_KEYS.WINDOW_STATE], async (storedState) => {
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const windowEntry = windowState[group.windowId] || windowState[String(group.windowId)];
      let stateChanged = false;
      if (windowEntry && windowEntry.specialGroups) {
        if (windowEntry.specialGroups.yellow === group.id) {
          windowEntry.specialGroups.yellow = null;
          stateChanged = true;
        }
        if (windowEntry.specialGroups.red === group.id) {
          windowEntry.specialGroups.red = null;
          stateChanged = true;
        }
      }
      if (windowEntry && windowEntry.groupZones) {
        delete windowEntry.groupZones[group.id];
        delete windowEntry.groupZones[String(group.id)];
        stateChanged = true;
      }
      if (windowEntry && windowEntry.groupNaming) {
        delete windowEntry.groupNaming[group.id];
        delete windowEntry.groupNaming[String(group.id)];
        stateChanged = true;
      }
      return stateChanged ? { [STORAGE_KEYS.WINDOW_STATE]: windowState } : {};
    });
    if (writes && Object.keys(writes).length > 0) {
      logger.info('Group removed externally, cleaned metadata', { groupId: group.id, windowId: group.windowId }, correlationId);
    }
    logger.debug('Tab group removed', { groupId: group.id, windowId: group.windowId }, correlationId);
    scheduleDebouncedSortAndUpdate(group.windowId);
  } catch (error) {
    logger.error('onGroupRemoved handler failed', { groupId: group.id, error: error.message }, correlationId);
  }
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  const correlationId = logger.correlationId();
  try {
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.WINDOW_STATE]);
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};

    // Handle user renames of managed (special) groups
    if (isManagedAgingGroup(group.id, group.windowId, windowState)) {
      const wasExtensionTitleWrite = typeof group.title === 'string'
        && acknowledgeExtensionTitleChangeIfExpected(group.id, group.title);
      if (typeof group.color === 'string') {
        acknowledgeExtensionColorChangeIfExpected(group.id, group.color);
      }

      if (!wasExtensionTitleWrite && typeof group.title === 'string') {
        const managedGroupType = getManagedGroupType(group.id, group.windowId, windowState);
        if (managedGroupType) {
          const settingsKey = managedGroupType === MANAGED_GROUP_TYPES.YELLOW ? 'yellowGroupName' : 'redGroupName';
          const settingsState = await readValidatedStateFromStorage([STORAGE_KEYS.SETTINGS]);
          const currentSettings = settingsState[STORAGE_KEYS.SETTINGS] || {};
          if (currentSettings[settingsKey] !== group.title) {
            currentSettings[settingsKey] = group.title;
            await writeMultipleStateEntries({ [STORAGE_KEYS.SETTINGS]: currentSettings });
            logger.info('User renamed special group, persisted to settings', {
              groupId: group.id, type: managedGroupType, newTitle: group.title,
            }, correlationId);
          }
        }
      }
      return;
    }

    // Snapshot previous state and update cache so we can detect what changed.
    // Chrome's tabGroups.onUpdated does not provide a changeInfo — it fires for
    // title, color, AND collapsed changes with the full group object.
    const previousState = lastKnownGroupState.get(group.id);
    lastKnownGroupState.set(group.id, { title: group.title, color: group.color });

    const wasExtensionTitleWrite = typeof group.title === 'string'
      && acknowledgeExtensionTitleChangeIfExpected(group.id, group.title);
    const wasExtensionColorWrite = typeof group.color === 'string'
      && acknowledgeExtensionColorChangeIfExpected(group.id, group.color);
    if (wasExtensionTitleWrite || wasExtensionColorWrite) {
      logger.debug('Tab group update acknowledged as extension write', {
        groupId: group.id,
        windowId: group.windowId,
        extensionTitleWrite: wasExtensionTitleWrite,
        extensionColorWrite: wasExtensionColorWrite,
      }, correlationId);
      return;
    }

    // If title and color are unchanged from the cached state, the event is a
    // collapse/expand — no sorting or naming lock is needed.
    const titleChanged = !previousState || previousState.title !== group.title;
    const colorChanged = !previousState || previousState.color !== group.color;
    if (!titleChanged && !colorChanged) {
      logger.debug('Tab group collapsed/expanded, skipping sort', { groupId: group.id, windowId: group.windowId }, correlationId);
      return;
    }

    if (titleChanged && group.title !== undefined) {
      const lockResult = lockAutoNamingAfterUserEdit(group.windowId, group, windowState, USER_EDIT_LOCK_DURATION_MS);
      await writeMultipleStateEntries({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
      logger.debug('Recorded user group title edit lock', {
        groupId: group.id,
        windowId: group.windowId,
        lockResult,
      }, correlationId);
    }

    logger.debug('Tab group updated by user', { groupId: group.id, title: group.title, color: group.color }, correlationId);
    scheduleDebouncedSortAndUpdate(group.windowId);
  } catch (error) {
    logger.error('onGroupUpdated handler failed', { groupId: group.id, error: error.message }, correlationId);
  }
});

// ─── Storage Changes ─────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;

  const correlationId = logger.correlationId();
  if (changes[STORAGE_KEYS.SETTINGS]) {
    const oldSettings = changes[STORAGE_KEYS.SETTINGS].oldValue || {};
    const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue || {};

    // Age cap: when aging transitions from disabled → enabled
    if (oldSettings.agingEnabled === false && newSettings.agingEnabled !== false) {
      try {
        const now = Date.now();
        const currentActiveTime = await getCurrentTotalActiveTimeMs();
        const redToGoneThreshold = newSettings.thresholds?.redToGone || DEFAULT_AGING_THRESHOLDS.RED_TO_GONE;
        const ageCap = redToGoneThreshold + 60_000;
        const wallClockCapTimestamp = now - ageCap;
        const activeTimeCapTimestamp = currentActiveTime - ageCap;
        let tabsCapped = 0;

        await mutateTrackedState([STORAGE_KEYS.TAB_META], async (storedState) => {
          const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};

          for (const tabEntry of Object.values(tabMeta)) {
            let wasCapped = false;
            if (tabEntry.refreshWallTime < wallClockCapTimestamp) {
              tabEntry.refreshWallTime = wallClockCapTimestamp;
              wasCapped = true;
            }
            if (tabEntry.refreshActiveTime < activeTimeCapTimestamp) {
              tabEntry.refreshActiveTime = activeTimeCapTimestamp;
              wasCapped = true;
            }
            if (wasCapped) tabsCapped++;
          }

          if (tabsCapped === 0) return {};
          return { [STORAGE_KEYS.TAB_META]: tabMeta };
        });

        if (tabsCapped > 0) {
          logger.info('Age cap applied on aging re-enable', {
            cappedCount: tabsCapped,
            tabCount: Object.keys((await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]))[STORAGE_KEYS.TAB_META] || {}).length,
            capWindowMs: ageCap,
          }, correlationId);
        } else {
          logger.debug('Age cap check: no tabs needed capping', {
            tabCount: Object.keys((await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]))[STORAGE_KEYS.TAB_META] || {}).length,
          }, correlationId);
        }
      } catch (error) {
        logger.error('Failed to apply age cap', { error: error.message }, correlationId);
      }
    }

    // Dissolution: when tab sorting transitions from enabled → disabled
    if (oldSettings.tabSortingEnabled !== false && newSettings.tabSortingEnabled === false) {
      try {
        await dissolveAllManagedGroupsInAllWindows(correlationId);
      } catch (error) {
        logger.error('Failed to dissolve special groups', { error: error.message }, correlationId);
      }
    }

    // Reactive rename: when managed group names change
    if (oldSettings.yellowGroupName !== newSettings.yellowGroupName
        || oldSettings.redGroupName !== newSettings.redGroupName) {
      try {
        await updateManagedGroupTitlesFromSettings(newSettings, correlationId);
      } catch (error) {
        logger.error('Failed to update special group names', { error: error.message }, correlationId);
      }
    }

    logger.info('Settings changed, triggering re-evaluation', null, correlationId);
    try {
      await runTabAgingEvaluationCycle(correlationId);
    } catch (error) {
      logger.error('Re-evaluation after settings change failed', { error: error.message }, correlationId);
    }
  }
});

// ─── Reactive Settings Helpers ────────────────────────────────────────────────

/**
 * Dissolves managed aging groups in all windows.
 * Called when tabSortingEnabled is turned off.
 */
async function dissolveAllManagedGroupsInAllWindows(correlationId) {
  const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.WINDOW_STATE]);
  const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
  let totalDissolved = 0;
  const windowIds = Object.keys(windowState).map(Number);

  for (const windowId of windowIds) {
    const { dissolved } = await dissolveManagedGroupsInWindow(windowId, windowState);
    totalDissolved += dissolved;
  }

  if (totalDissolved > 0) {
    await writeMultipleStateEntries({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
    logger.info('Dissolved special groups on tabSortingEnabled=false', {
      windowIds,
      windowCount: windowIds.length,
      totalDissolved,
    }, correlationId);
  } else {
    logger.debug('No special groups to dissolve', { windowIds }, correlationId);
  }
}

/**
 * Updates the titles of managed aging groups when the user changes group name settings.
 */
async function updateManagedGroupTitlesFromSettings(settings, correlationId) {
  const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.WINDOW_STATE]);
  const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
  let groupsRenamed = 0;

  for (const [windowId, windowEntry] of Object.entries(windowState)) {
    for (const groupType of ['yellow', 'red']) {
      const groupId = windowEntry.specialGroups?.[groupType];
      if (groupId === null || groupId === undefined) continue;
      const settingsKey = groupType === 'yellow' ? 'yellowGroupName' : 'redGroupName';
      const newTitle = settings[settingsKey] ?? '';
      try {
        await chrome.tabGroups.update(groupId, { title: newTitle });
        groupsRenamed++;
        logger.debug('Updated special group name', { windowId, type: groupType, groupId, newTitle }, correlationId);
      } catch (error) {
        logger.warn('Failed to update special group name', { windowId, type: groupType, groupId, error: error.message }, correlationId);
      }
    }
  }

  if (groupsRenamed > 0) {
    logger.info('Reactive group name update complete', { updated: groupsRenamed }, correlationId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function flushDeferredStartupCreatedTabsIntoStorage(correlationId) {
  if (deferredStartupTabMetaById.size === 0) return 0;

  let addedCount = 0;
  await mutateTrackedState([STORAGE_KEYS.TAB_META], async (storedState) => {
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};

    for (const [tabId, deferredEntry] of deferredStartupTabMetaById) {
      if (tabMeta[tabId] || tabMeta[String(tabId)]) {
        deferredStartupTabMetaById.delete(tabId);
        continue;
      }

      try {
        const liveTab = await chrome.tabs.get(Number(tabId));
        if (liveTab.pinned || !isNormalWindow(liveTab.windowId)) {
          deferredStartupTabMetaById.delete(tabId);
          continue;
        }

        tabMeta[tabId] = {
          ...deferredEntry,
          tabId: liveTab.id,
          windowId: liveTab.windowId,
          groupId: liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? liveTab.groupId : null,
          managedGroupType: deferredEntry.managedGroupType ?? null,
          pinned: liveTab.pinned || false,
          url: liveTab.url || deferredEntry.url || '',
        };
        addedCount++;
      } catch {
      }

      deferredStartupTabMetaById.delete(tabId);
    }

    return addedCount === 0 ? {} : { [STORAGE_KEYS.TAB_META]: tabMeta };
  });

  if (addedCount > 0) {
    logger.info('Flushed deferred startup tabs into storage', { addedCount }, correlationId);
  }

  return addedCount;
}

async function retryPendingStartupReconciliation(trigger) {
  if (!startupReconciliationPending) return false;

  const correlationId = logger.correlationId();
  const reconciliationResult = await reconcileStoredStateWithBrowser(correlationId);
  if (!reconciliationResult.completed) {
    logger.info('Startup reconciliation still pending', {
      trigger,
      reason: reconciliationResult.reason,
    }, correlationId);
    return false;
  }

  startupReconciliationPending = false;
  await runTabAgingEvaluationCycle(correlationId);
  await probeAndSyncCurrentFocusState(correlationId);
  await flushDeferredStartupCreatedTabsIntoStorage(correlationId);
  logger.info('Startup reconciliation completed after retry', { trigger }, correlationId);
  return true;
}

/**
 * Scans all currently open browser tabs and creates fresh metadata entries for each.
 * Called on first extension install (when there's no existing stored state).
 */
async function scanAndTrackAllExistingTabs(correlationId) {
  try {
    const allBrowserTabs = await chrome.tabs.query({});
    const currentActiveTime = await getCurrentTotalActiveTimeMs();
    const tabMeta = {};

    for (const tab of allBrowserTabs) {
      if (tab.pinned || !isNormalWindow(tab.windowId)) continue;
      tabMeta[tab.id] = createFreshTabMetadata(tab, currentActiveTime);
    }

    await mutateTrackedState([STORAGE_KEYS.TAB_META], async () => ({ [STORAGE_KEYS.TAB_META]: tabMeta }));
    logger.info('Scanned existing tabs', { count: Object.keys(tabMeta).length }, correlationId);
  } catch (error) {
    logger.error('Failed to scan existing tabs', { error: error.message }, correlationId);
  }
}

/**
 * Reconciles stored tab metadata with the actual browser state after a restart.
 *
 * Chrome assigns new tab IDs on restart, so stored metadata is matched to live
 * tabs by URL. This preserves tab ages across browser restarts. Group IDs and
 * window IDs are also remapped using voting (most common mapping wins).
 */
async function reconcileStoredStateWithBrowser(correlationId) {
  if (pendingReconciliationPromise) {
    logger.info('reconcileState already running, waiting for existing call', null, correlationId);
    return await pendingReconciliationPromise;
  }
  pendingReconciliationPromise = performReconciliation(correlationId);
  try {
    return await pendingReconciliationPromise;
  } finally {
    pendingReconciliationPromise = null;
  }
}

async function performReconciliation(correlationId) {
  try {
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const storedTabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const storedWindowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};

    const isMatchableUrl = (url) => url && url !== '' && url !== 'about:blank' && url !== 'chrome://newtab/';
    const storedMatchableUrlCount = Object.values(storedTabMeta)
      .filter((entry) => isMatchableUrl(entry.url)).length;

    // Only reconcile tabs in normal browser windows — DevTools, popups, and app
    // windows are excluded from all tracking.
    let allBrowserTabs, allBrowserWindows;
    let browserTabsWithRealUrls = 0;
    const hasStoredTrackedState = Object.keys(storedTabMeta).length > 0 || Object.keys(storedWindowState).length > 0;
    if (storedMatchableUrlCount > 0) {
      [allBrowserTabs, allBrowserWindows] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getAll({ windowTypes: ['normal'] }),
      ]);
      let normalWinIds = new Set(allBrowserWindows.map((w) => w.id));
      allBrowserTabs = allBrowserTabs.filter((tab) => normalWinIds.has(tab.windowId));
      browserTabsWithRealUrls = allBrowserTabs.filter(
        (tab) => !tab.pinned && isMatchableUrl(tab.url),
      ).length;

      if (!hasStoredTrackedState || allBrowserWindows.length > 0 || allBrowserTabs.length > 0) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && browserTabsWithRealUrls < storedMatchableUrlCount) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          [allBrowserTabs, allBrowserWindows] = await Promise.all([
            chrome.tabs.query({}),
            chrome.windows.getAll({ windowTypes: ['normal'] }),
          ]);
          normalWinIds = new Set(allBrowserWindows.map((w) => w.id));
          allBrowserTabs = allBrowserTabs.filter((tab) => normalWinIds.has(tab.windowId));
          browserTabsWithRealUrls = allBrowserTabs.filter(
            (tab) => !tab.pinned && isMatchableUrl(tab.url),
          ).length;
        }
      }
    } else {
      [allBrowserTabs, allBrowserWindows] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getAll({ windowTypes: ['normal'] }),
      ]);
      const normalWinIds = new Set(allBrowserWindows.map((w) => w.id));
      allBrowserTabs = allBrowserTabs.filter((tab) => normalWinIds.has(tab.windowId));
      browserTabsWithRealUrls = allBrowserTabs.filter(
        (tab) => !tab.pinned && isMatchableUrl(tab.url),
      ).length;
    }

    const hasLiveBrowserState = allBrowserWindows.length > 0 || allBrowserTabs.length > 0;
    if (hasStoredTrackedState && !hasLiveBrowserState) {
      logger.info('Deferring reconciliation until live browser state is available', {
        storedTabCount: Object.keys(storedTabMeta).length,
        storedWindowCount: Object.keys(storedWindowState).length,
      }, correlationId);
      return { completed: false, reason: 'no_live_browser_state' };
    }
    if (storedMatchableUrlCount > 0 && browserTabsWithRealUrls === 0 && allBrowserTabs.length > 0) {
      logger.info('Deferring reconciliation until restored tabs have real URLs', {
        storedMatchableUrlCount,
        tabsInChrome: allBrowserTabs.length,
      }, correlationId);
      return { completed: false, reason: 'no_matchable_live_urls' };
    }

    const currentActiveTime = await getCurrentTotalActiveTimeMs();
    const now = Date.now();

    const liveWindowIds = new Set(allBrowserWindows.map((window) => window.id));
    const reconciledTabMeta = {};
    const liveGroupIdsByWindow = new Map();

    // Build URL → stored metadata lookup for age preservation across restarts
    const storedMetadataByUrl = new Map();
    for (const storedEntry of Object.values(storedTabMeta)) {
      if (storedEntry.url && storedEntry.url !== 'chrome://newtab/' && storedEntry.url !== '') {
        const existingBucket = storedMetadataByUrl.get(storedEntry.url) || [];
        existingBucket.push(storedEntry);
        storedMetadataByUrl.set(storedEntry.url, existingBucket);
      }
    }
    const alreadyMatchedEntries = new Set();
    const oldToNewGroupIdVotes = new Map();
    let urlMatchCount = 0;

    for (const browserTab of allBrowserTabs) {
      if (browserTab.pinned) continue;
      const tabIdAsString = String(browserTab.id);
      const liveGroupId = browserTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? browserTab.groupId : null;
      if (liveGroupId !== null) {
        const groupSet = liveGroupIdsByWindow.get(browserTab.windowId) || new Set();
        groupSet.add(liveGroupId);
        liveGroupIdsByWindow.set(browserTab.windowId, groupSet);
      }
      if (storedTabMeta[tabIdAsString] || storedTabMeta[browserTab.id]) {
        const matchedEntry = storedTabMeta[tabIdAsString] || storedTabMeta[browserTab.id];
        matchedEntry.windowId = browserTab.windowId;
        matchedEntry.groupId = liveGroupId;
        matchedEntry.pinned = browserTab.pinned;
        // Reset isSpecialGroup — managed-group membership will be re-established
        // by the first sorting cycle.  Preserving a stale `true` from the previous
        // session causes determineFreshestStatusInGroup to skip this tab, which can
        // leave its group unsorted and break zone ordering after restart.
        matchedEntry.isSpecialGroup = false;
        // Prefer the browser's URL, but don't overwrite a meaningful stored URL
        // with a generic placeholder — during session restore, Chrome may report
        // chrome://newtab/ for tabs that haven't loaded their real URL yet.
        const browserUrl = browserTab.url || '';
        const isGenericUrl = !browserUrl || browserUrl === 'chrome://newtab/' || browserUrl === 'about:blank';
        matchedEntry.url = isGenericUrl && matchedEntry.url ? matchedEntry.url : (browserUrl || matchedEntry.url || '');
        reconciledTabMeta[browserTab.id] = matchedEntry;
        alreadyMatchedEntries.add(matchedEntry);
      } else {
        let urlMatchedEntry = null;
        if (browserTab.url && browserTab.url !== 'chrome://newtab/') {
          const candidates = storedMetadataByUrl.get(browserTab.url);
          if (candidates) {
            for (let i = 0; i < candidates.length; i++) {
              if (!alreadyMatchedEntries.has(candidates[i])) {
                urlMatchedEntry = candidates[i];
                alreadyMatchedEntries.add(urlMatchedEntry);
                candidates.splice(i, 1);
                urlMatchCount++;
                break;
              }
            }
          }
        }

        if (urlMatchedEntry) {
          if (urlMatchedEntry.groupId !== null && liveGroupId !== null) {
            const votes = oldToNewGroupIdVotes.get(urlMatchedEntry.groupId) || new Map();
            votes.set(liveGroupId, (votes.get(liveGroupId) || 0) + 1);
            oldToNewGroupIdVotes.set(urlMatchedEntry.groupId, votes);
          }
          reconciledTabMeta[browserTab.id] = {
            tabId: browserTab.id,
            windowId: browserTab.windowId,
            refreshActiveTime: urlMatchedEntry.refreshActiveTime,
            refreshWallTime: urlMatchedEntry.refreshWallTime,
            status: urlMatchedEntry.status,
            groupId: liveGroupId,
            isSpecialGroup: false,
            pinned: false,
            url: browserTab.url || '',
          };
        } else {
          reconciledTabMeta[browserTab.id] = {
            tabId: browserTab.id,
            windowId: browserTab.windowId,
            refreshActiveTime: currentActiveTime,
            refreshWallTime: now,
            status: TAB_LIFECYCLE_STAGE.GREEN,
            groupId: liveGroupId,
            isSpecialGroup: false,
            pinned: false,
            url: browserTab.url || '',
          };
        }
      }
    }

    // Resolve old→new group ID mapping (the new group with the most tab matches wins)
    const resolvedGroupIdMap = new Map();
    for (const [oldGroupId, newGroupIdCounts] of oldToNewGroupIdVotes) {
      let bestNewGroupId = null;
      let bestMatchCount = 0;
      for (const [newGroupId, matchCount] of newGroupIdCounts) {
        if (matchCount > bestMatchCount) {
          bestMatchCount = matchCount;
          bestNewGroupId = newGroupId;
        }
      }
      if (bestNewGroupId !== null) resolvedGroupIdMap.set(oldGroupId, bestNewGroupId);
    }

    if (urlMatchCount > 0) {
      logger.info('URL-based tab matching preserved ages across restart', {
        urlMatches: urlMatchCount,
        groupMappings: resolvedGroupIdMap.size,
      }, correlationId);
    }

    // Build old→new window ID mapping from tab metadata
    const windowIdVotes = new Map();
    for (const reconciledEntry of Object.values(reconciledTabMeta)) {
      const storedWindowId = Object.values(storedTabMeta).find(
        (entry) => entry.url && entry.url === reconciledEntry.url && entry.url !== 'about:blank',
      )?.windowId;
      if (storedWindowId !== undefined && storedWindowId !== reconciledEntry.windowId) {
        const votes = windowIdVotes.get(storedWindowId) || new Map();
        votes.set(reconciledEntry.windowId, (votes.get(reconciledEntry.windowId) || 0) + 1);
        windowIdVotes.set(storedWindowId, votes);
      }
    }
    const resolvedWindowIdMap = new Map();
    for (const [oldWindowId, newWindowIdCounts] of windowIdVotes) {
      let bestNewWindowId = null;
      let bestMatchCount = 0;
      for (const [newWindowId, matchCount] of newWindowIdCounts) {
        if (matchCount > bestMatchCount) { bestMatchCount = matchCount; bestNewWindowId = newWindowId; }
      }
      if (bestNewWindowId !== null) resolvedWindowIdMap.set(oldWindowId, bestNewWindowId);
    }

    const reconciledWindowState = {};
    for (const [storedWindowId, storedWindowEntry] of Object.entries(storedWindowState)) {
      const numericWindowId = Number(storedWindowId);
      const resolvedWindowId = liveWindowIds.has(numericWindowId)
        ? numericWindowId
        : (resolvedWindowIdMap.get(numericWindowId) ?? null);
      if (resolvedWindowId !== null && liveWindowIds.has(resolvedWindowId)) {
        const liveGroupIds = liveGroupIdsByWindow.get(resolvedWindowId) || new Set();
        const currentEntry = storedWindowEntry && typeof storedWindowEntry === 'object' ? storedWindowEntry : {};
        const storedSpecialGroups = currentEntry.specialGroups && typeof currentEntry.specialGroups === 'object'
          ? currentEntry.specialGroups
          : { yellow: null, red: null };
        const storedGroupZones = currentEntry.groupZones && typeof currentEntry.groupZones === 'object'
          ? currentEntry.groupZones
          : {};
        const storedGroupNaming = currentEntry.groupNaming && typeof currentEntry.groupNaming === 'object'
          ? currentEntry.groupNaming
          : {};

        const remappedSpecialGroups = { yellow: null, red: null };
        for (const groupType of ['yellow', 'red']) {
          const oldId = storedSpecialGroups[groupType];
          if (oldId === null) continue;
          const newId = resolvedGroupIdMap.get(oldId);
          if (newId !== undefined && liveGroupIds.has(newId)) {
            remappedSpecialGroups[groupType] = newId;
          } else if (liveGroupIds.has(oldId)) {
            remappedSpecialGroups[groupType] = oldId;
          }
        }

        const remappedGroupZones = {};
        for (const [storedGroupId, zone] of Object.entries(storedGroupZones)) {
          const numericGroupId = Number(storedGroupId);
          const resolvedGroupId = liveGroupIds.has(numericGroupId) ? numericGroupId : (resolvedGroupIdMap.get(numericGroupId) ?? null);
          if (resolvedGroupId !== null && liveGroupIds.has(resolvedGroupId)) {
            remappedGroupZones[resolvedGroupId] = zone;
          }
        }

        const remappedGroupNaming = {};
        for (const [storedGroupId, namingMetadata] of Object.entries(storedGroupNaming)) {
          const numericGroupId = Number(storedGroupId);
          const resolvedGroupId = liveGroupIds.has(numericGroupId) ? numericGroupId : (resolvedGroupIdMap.get(numericGroupId) ?? null);
          if (resolvedGroupId !== null && liveGroupIds.has(resolvedGroupId)) {
            const nowForNaming = Date.now();
            const firstUnnamedSeenAt = Number.isFinite(namingMetadata?.firstUnnamedSeenAt) && namingMetadata.firstUnnamedSeenAt > 0
              ? namingMetadata.firstUnnamedSeenAt
              : nowForNaming;
            const lastAutoNamedAt = Number.isFinite(namingMetadata?.lastAutoNamedAt) && namingMetadata.lastAutoNamedAt > 0
              ? namingMetadata.lastAutoNamedAt
              : null;
            const lastCandidate = typeof namingMetadata?.lastCandidate === 'string' && namingMetadata.lastCandidate.trim()
              ? namingMetadata.lastCandidate.trim().split(/\s+/).slice(0, 2).join(' ')
              : null;
            const userEditLockUntil = Number.isFinite(namingMetadata?.userEditLockUntil) && namingMetadata.userEditLockUntil > 0
              ? namingMetadata.userEditLockUntil
              : nowForNaming;
            remappedGroupNaming[resolvedGroupId] = {
              firstUnnamedSeenAt,
              lastAutoNamedAt,
              lastCandidate,
              userEditLockUntil,
            };
          }
        }

        reconciledWindowState[resolvedWindowId] = {
          specialGroups: remappedSpecialGroups,
          groupZones: remappedGroupZones,
          groupNaming: remappedGroupNaming,
        };
      }
    }

    for (const windowId of liveWindowIds) {
      if (!reconciledWindowState[windowId] && !reconciledWindowState[String(windowId)]) {
        reconciledWindowState[windowId] = {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {},
        };
      }
    }

    // Persist reconciled state BEFORE recoloring managed groups, so that any
    // onUpdated handlers triggered by chrome.tabGroups.update read the correct
    // remapped special group IDs rather than stale pre-restart values.
    await mutateTrackedState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE], async () => ({
      [STORAGE_KEYS.TAB_META]: reconciledTabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: reconciledWindowState,
    }));

    // Re-apply colors to managed groups — Chrome may reset them to grey on restart.
    for (const [, windowEntry] of Object.entries(reconciledWindowState)) {
      const specialGroups = windowEntry?.specialGroups;
      if (!specialGroups) continue;
      for (const groupType of ['yellow', 'red']) {
        const groupId = specialGroups[groupType];
        if (groupId === null) continue;
        try {
          await chrome.tabGroups.update(groupId, { color: groupType });
        } catch (error) {
          const msg = error?.message || '';
          // If the group no longer exists, clear the stale reference to avoid
          // persisting a dangling special group ID.
          if (msg.includes('No group with id') || msg.includes('No tab group with id')) {
            specialGroups[groupType] = null;
          }
          logger.warn('Failed to restore managed group color after restart', {
            correlationId, groupType, groupId, error: msg,
          });
        }
      }
    }

    // Re-persist if any stale special group references were cleared during recoloring.
    await mutateTrackedState([STORAGE_KEYS.WINDOW_STATE], async () => ({
      [STORAGE_KEYS.WINDOW_STATE]: reconciledWindowState,
    }));

    // Seed the group state cache so the first tabGroups.onUpdated (e.g. a
    // collapse) can be correctly identified as a no-op instead of triggering
    // an unnecessary sort.
    try {
      const allBrowserGroups = await chrome.tabGroups.query({});
      for (const group of allBrowserGroups) {
        lastKnownGroupState.set(group.id, { title: group.title, color: group.color });
      }
      logger.debug('Seeded group state cache', { groupCount: allBrowserGroups.length }, correlationId);
    } catch (error) {
      logger.warn('Failed to seed group state cache', { error: error.message }, correlationId);
    }

    logger.info('State reconciled', {
      tabsInChrome: allBrowserTabs.length,
      tabsReconciled: Object.keys(reconciledTabMeta).length,
      urlMatches: urlMatchCount,
      windowsReconciled: Object.keys(reconciledWindowState).length,
      chromeWindowCount: allBrowserWindows.length,
      chromeWindowTypes: allBrowserWindows.map((w) => ({ id: w.id, type: w.type })),
      storedWindowCount: Object.keys(storedWindowState).length,
    }, correlationId);
    return { completed: true };
  } catch (error) {
    logger.error('State reconciliation failed', { error: error.message, errorCode: ERROR_CODES.ERR_RECOVERY }, correlationId);
    return { completed: false, reason: 'error' };
  }
}
