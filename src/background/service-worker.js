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
  determineFreshestStatusInGroup,
  updateGroupColorToMatchStatus,
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
const tabsCurrentlyBeingResetByNavigation = new Set();

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
  if (isEvaluationCycleInProgress || isSortUpdateInProgress) return;
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
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = storedState[STORAGE_KEYS.SETTINGS] || {};

    // Reconcile groupIds for this window before sorting
    try {
      const browserTabs = await chrome.tabs.query({ windowId: Number(windowId) });
      for (const browserTab of browserTabs) {
        const tabEntry = tabMeta[browserTab.id] || tabMeta[String(browserTab.id)];
        if (!tabEntry) continue;
        const actualGroupId = browserTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? browserTab.groupId : null;
        if (tabEntry.groupId !== actualGroupId) {
          tabEntry.groupId = actualGroupId;
          tabEntry.isSpecialGroup = actualGroupId !== null && isManagedAgingGroup(actualGroupId, Number(windowId), windowState);
        }
      }
    } catch (error) {
      logger.warn('Sort-update: failed to reconcile groupIds', { windowId, error: error.message }, correlationId);
    }

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
      const currentActiveTime = await getCurrentTotalActiveTimeMs();
      await appendAgeToAllGroupTitles(windowId, tabMeta, windowState, currentActiveTime, settings);
    } else {
      await removeAgeSuffixFromAllGroupTitles(windowId, windowState);
    }

    await writeMultipleStateEntries({
      [STORAGE_KEYS.TAB_META]: tabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: windowState,
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

  let isFalseInstall = false;
  let storedTabCount;
  try {
    if (details.reason === 'install') {
      const existingData = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
      const existingTabMeta = existingData[STORAGE_KEYS.TAB_META];
      storedTabCount = existingTabMeta ? Object.keys(existingTabMeta).length : 0;
      isFalseInstall = storedTabCount > 0;

      if (isFalseInstall) {
        activeStartupHandlerCount++; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
        logger.info('Existing tab data found on install — treating as reconciliation', {
          existingTabCount: storedTabCount,
        }, correlationId);
      } else {
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

    if (details.reason === 'install' && isFalseInstall) {
      await reconcileStoredStateWithBrowser(correlationId);
    } else if (details.reason === 'install') {
      await scanAndTrackAllExistingTabs(correlationId);
    } else {
      await reconcileStoredStateWithBrowser(correlationId);
    }

    await runTabAgingEvaluationCycle(correlationId);
  } catch (error) {
    logger.error('onInstalled handler failed', { error: error.message, errorCode: ERROR_CODES.ERR_ALARM_CREATE }, correlationId);
  } finally {
    if (isFalseInstall) {
      activeStartupHandlerCount--; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
      logger.info('Startup guard cleared (false install)', { refCount: activeStartupHandlerCount }, correlationId);
    }
  }
});

// ─── Browser Startup ─────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  activeStartupHandlerCount++; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
  const correlationId = logger.correlationId();
  logger.info('Browser startup detected', null, correlationId);

  try {
    await recoverActiveTimeAfterRestart();

    const existingAlarm = await chrome.alarms.get(EVALUATION_ALARM_NAME);
    if (!existingAlarm) {
      await chrome.alarms.create(EVALUATION_ALARM_NAME, { periodInMinutes: EVALUATION_INTERVAL_MINUTES });
      logger.info('Alarm recreated on startup', null, correlationId);
    }

    await reconcileStoredStateWithBrowser(correlationId);

    await runTabAgingEvaluationCycle(correlationId);
  } catch (error) {
    logger.error('onStartup handler failed', { error: error.message, errorCode: ERROR_CODES.ERR_RECOVERY }, correlationId);
  } finally {
    activeStartupHandlerCount--; isBrowserStartupInProgress = activeStartupHandlerCount > 0;
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
Object.defineProperty(self, '__evaluationCycleRunning', {
  get() { return isEvaluationCycleInProgress; },
});
Object.defineProperty(self, '__sortUpdateRunning', {
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
  await saveActiveTimeToStorage();

  const storedState = await readValidatedStateFromStorage([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TAB_META,
    STORAGE_KEYS.WINDOW_STATE,
  ]);

  const settings = storedState[STORAGE_KEYS.SETTINGS];
  if (!settings) {
    logger.error('Settings missing from storage, skipping evaluation cycle. Reinstall extension or check storage.', {}, correlationId);
    return;
  }
  const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
  const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
  const currentActiveTime = await getCurrentTotalActiveTimeMs();

  const isAgingEnabled = settings.agingEnabled !== false;
  if (!isAgingEnabled) {
    logger.debug('Aging disabled, skipping evaluation cycle', {
      tabCount: Object.keys(tabMeta).length,
    }, correlationId);
    return;
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

  // Reconcile groupIds: fix stale tabMeta.groupId values by querying Chrome
  let staleGroupIdFixCount = 0;
  try {
    const allBrowserTabs = await chrome.tabs.query({});
    for (const browserTab of allBrowserTabs) {
      const tabEntry = tabMeta[browserTab.id] || tabMeta[String(browserTab.id)];
      if (!tabEntry) continue;
      const actualGroupId = browserTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? browserTab.groupId : null;
      if (tabEntry.groupId !== actualGroupId) {
        tabEntry.groupId = actualGroupId;
        staleGroupIdFixCount++;
      }
      if (browserTab.url && browserTab.url !== tabEntry.url) tabEntry.url = browserTab.url;
    }
    if (staleGroupIdFixCount > 0) {
      logger.info('Reconciled stale groupIds in tabMeta', { fixes: staleGroupIdFixCount }, correlationId);
    }
  } catch (error) {
    logger.warn('Failed to reconcile groupIds', { error: error.message }, correlationId);
  }

  const tabsWithChangedStatus = findAllTabsNeedingStatusTransition(tabMeta, currentActiveTime, settings);
  const transitionCount = Object.keys(tabsWithChangedStatus).length;

  for (const [tabId, transition] of Object.entries(tabsWithChangedStatus)) {
    tabMeta[tabId].status = transition.newStatus;
  }

  // Build configuration for handling gone tabs (bookmarking before closing)
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

  // Per-window operations: dissolve, sort, auto-name, update titles
  const allWindowIds = new Set(Object.values(tabMeta).map((entry) => entry.windowId));
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

  await writeMultipleStateEntries({
    [STORAGE_KEYS.TAB_META]: tabMeta,
    [STORAGE_KEYS.WINDOW_STATE]: windowState,
  });

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
}

// ─── Tab Events ──────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener(async (tab) => {
  const correlationId = logger.correlationId();
  try {
    if (tab.pinned) {
      logger.debug('Skipping pinned tab creation', { tabId: tab.id }, correlationId);
      return;
    }

    if (isBrowserStartupInProgress) {
      const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      if (!tabMeta[tab.id] && !tabMeta[String(tab.id)]) {
        const currentActiveTime = await getCurrentTotalActiveTimeMs();
        tabMeta[tab.id] = createFreshTabMetadata(tab, currentActiveTime);
        await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
      }
      logger.debug('Startup in progress, skipping tab placement', { tabId: tab.id, windowId: tab.windowId }, correlationId);
      return;
    }

    const currentActiveTime = await getCurrentTotalActiveTimeMs();
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = storedState[STORAGE_KEYS.SETTINGS] || {};

    if (!tabMeta[tab.id] && !tabMeta[String(tab.id)]) {
      tabMeta[tab.id] = createFreshTabMetadata(tab, currentActiveTime);
    }

    isTabPlacementInProgress = true;
    try {
      await placeNewlyCreatedTabNearItsContext(tab, tab.windowId, tabMeta, windowState, settings);
      await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
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
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const removedTabMetadata = tabMeta[tabId] || tabMeta[String(tabId)] || null;
    delete tabMeta[tabId];
    delete tabMeta[String(tabId)];
    await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });

    const windowStateData = await readValidatedStateFromStorage([STORAGE_KEYS.WINDOW_STATE]);
    const windowState = windowStateData[STORAGE_KEYS.WINDOW_STATE] || {};
    if (removedTabMetadata && removedTabMetadata.isSpecialGroup && removedTabMetadata.groupId !== null) {
      const managedGroupType = getManagedGroupType(removedTabMetadata.groupId, removeInfo.windowId, windowState);
      if (managedGroupType) {
        await removeManagedGroupIfEmpty(removeInfo.windowId, managedGroupType, windowState);
        await writeMultipleStateEntries({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
      }
    }

    await dissolveUnnamedGroupsWithOnlyOneTab(removeInfo.windowId, tabMeta, windowState);
    await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });

    logger.debug('Tab removed', { tabId, windowId: removeInfo.windowId }, correlationId);
    scheduleDebouncedSortAndUpdate(removeInfo.windowId);
  } catch (error) {
    logger.error('onRemoved handler failed', { tabId, error: error.message }, correlationId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const correlationId = logger.correlationId();

  if (changeInfo.discarded === false) {
    tabRestoredFromDiscardTimestamp.set(tabId, Date.now());
    logger.debug('Tab restored from discarded state', { tabId, windowId: tab.windowId }, correlationId);
  }

  if (changeInfo.groupId !== undefined
      && !isEvaluationCycleInProgress
      && !isTabPlacementInProgress
      && !isSortUpdateInProgress
      && !tabsCurrentlyBeingResetByNavigation.has(tabId)) {
    try {
      const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
      const tabEntry = tabMeta[tabId] || tabMeta[String(tabId)];
      const newGroupId = changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? changeInfo.groupId : null;
      if (tabEntry) {
        const previousGroupId = tabEntry.groupId;
        tabEntry.groupId = newGroupId;
        tabEntry.isSpecialGroup = newGroupId !== null && isManagedAgingGroup(newGroupId, tab.windowId, windowState);
        logger.debug('Tab group changed', { tabId, oldGroupId: previousGroupId, newGroupId, windowId: tab.windowId }, correlationId);
      }
      await dissolveUnnamedGroupsWithOnlyOneTab(tab.windowId, tabMeta, windowState);
      await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
      scheduleDebouncedSortAndUpdate(tab.windowId);
    } catch (error) {
      logger.error('onUpdated groupId handler failed', { tabId, error: error.message }, correlationId);
    }
  }
  if (changeInfo.pinned !== undefined) {
    try {
      const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
      const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
      if (changeInfo.pinned) {
        delete tabMeta[tabId];
        delete tabMeta[String(tabId)];
        logger.debug('Tab pinned, removed from tracking', { tabId }, correlationId);
      } else {
        const currentActiveTime = await getCurrentTotalActiveTimeMs();
        tabMeta[tabId] = createFreshTabMetadata(tab, currentActiveTime);
        logger.debug('Tab unpinned, added as fresh green', { tabId }, correlationId);
      }
      await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
    } catch (error) {
      logger.error('onUpdated pinned handler failed', { tabId, error: error.message }, correlationId);
    }
  }
});

// ─── Tab Moved (backup dissolution trigger) ─────────────────────────────────

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  if (isEvaluationCycleInProgress || isSortUpdateInProgress) return;
  const correlationId = logger.correlationId();
  try {
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
    const { dissolved } = await dissolveUnnamedGroupsWithOnlyOneTab(moveInfo.windowId, tabMeta, windowState);
    if (dissolved > 0) {
      await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
      logger.debug('Dissolved groups after tab move', { tabId, windowId: moveInfo.windowId, dissolved }, correlationId);
    }
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

  if (isBrowserStartupInProgress) return;

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
      if (tab.pinned) return;
    } catch { return; }

    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = storedState[STORAGE_KEYS.SETTINGS] || {};
    const existingEntry = tabMeta[tabId] || tabMeta[String(tabId)];
    if (!existingEntry) return;

    const currentActiveTime = await getCurrentTotalActiveTimeMs();
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
      }
    }

    if (isInManagedGroup) {
      await removeTabFromItsGroup(tabId);
      refreshedEntry.groupId = null;
      refreshedEntry.isSpecialGroup = false;
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
    const userGroupId = refreshedEntry.groupId;
    if (isAgingEnabled && userGroupId !== null && !refreshedEntry.isSpecialGroup
        && !isManagedAgingGroup(userGroupId, existingEntry.windowId, windowState)) {
      if (settings.tabgroupColoringEnabled !== false) {
        const groupStatus = determineFreshestStatusInGroup(userGroupId, tabMeta);
        if (groupStatus) {
          await updateGroupColorToMatchStatus(userGroupId, groupStatus);
        }
      }
    }
    if (isAgingEnabled) {
      await sortTabsAndGroupsByLifecycleZone(existingEntry.windowId, tabMeta, windowState, undefined, settings);
    }

    await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: windowState });
    logger.debug('Focus-based age refresh applied', { tabId, windowId }, correlationId);
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
async function resetTabAgeOnUserNavigation(tabId, eventSource) {
  if (isBrowserStartupInProgress) {
    return;
  }

  const now = Date.now();
  const lastHandledAt = lastNavigationTimestampByTab.get(tabId) || 0;
  if (now - lastHandledAt < NAVIGATION_DEBOUNCE_DELAY_MS) {
    logger.debug('Navigation debounced', { tabId, source: eventSource, sinceLast: now - lastHandledAt });
    return;
  }
  lastNavigationTimestampByTab.set(tabId, now);

  const correlationId = logger.correlationId();
  tabsCurrentlyBeingResetByNavigation.add(tabId);
  try {
    if (checkAndClearDiscardRestoreMarker(tabId, now)) {
      logger.debug('Ignoring navigation immediately after discarded-tab restore', { tabId, source: eventSource }, correlationId);
      return;
    }

    let navigatedToUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded || tab.status === 'unloaded') {
        logger.debug('Ignoring navigation for discarded/suspended tab', { tabId, source: eventSource }, correlationId);
        return;
      }
      navigatedToUrl = tab.url || '';
    } catch { /* tab gone */ }

    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = storedState[STORAGE_KEYS.SETTINGS] || {};
    const existingEntry = tabMeta[tabId] || tabMeta[String(tabId)];
    if (!existingEntry) {
      logger.debug('Navigation for untracked tab, skipping', { tabId, source: eventSource }, correlationId);
      return;
    }

    // Suppress session-restore "navigations" where URL matches what we already stored
    if (navigatedToUrl && existingEntry.url && navigatedToUrl === existingEntry.url) {
      logger.debug('Navigation URL matches stored URL, suppressing age reset', { tabId, source: eventSource, url: navigatedToUrl }, correlationId);
      return;
    }

    const currentActiveTime = await getCurrentTotalActiveTimeMs();
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
        }
      } catch { /* tab may have been removed */ }
    }

    if (isInManagedGroup) {
      await removeTabFromItsGroup(tabId);
      refreshedEntry.groupId = null;
      refreshedEntry.isSpecialGroup = false;
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
    const userGroupId = refreshedEntry.groupId;
    if (isAgingEnabled && userGroupId !== null && !refreshedEntry.isSpecialGroup
        && !isManagedAgingGroup(userGroupId, existingEntry.windowId, windowState)) {
      if (settings.tabgroupColoringEnabled !== false) {
        const groupStatus = determineFreshestStatusInGroup(userGroupId, tabMeta);
        if (groupStatus) {
          await updateGroupColorToMatchStatus(userGroupId, groupStatus);
        }
      }
    }
    if (isAgingEnabled) {
      await sortTabsAndGroupsByLifecycleZone(existingEntry.windowId, tabMeta, windowState, undefined, settings);
    }

    await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: windowState });
    logger.debug('Navigation handled, refresh time reset', { tabId, source: eventSource }, correlationId);
  } catch (error) {
    logger.error('Navigation handler failed', { tabId, source: eventSource, error: error.message }, correlationId);
  } finally {
    tabsCurrentlyBeingResetByNavigation.delete(tabId);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await resetTabAgeOnUserNavigation(details.tabId, 'onCommitted');
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await resetTabAgeOnUserNavigation(details.tabId, 'onHistoryStateUpdated');
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

// ─── Window Removed ──────────────────────────────────────────────────────────

chrome.windows.onRemoved.addListener(async (windowId) => {
  const correlationId = logger.correlationId();
  try {
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const windowState = storedState[STORAGE_KEYS.WINDOW_STATE] || {};

    for (const [tabId, tabEntry] of Object.entries(tabMeta)) {
      if (tabEntry.windowId === windowId || tabEntry.windowId === Number(windowId)) {
        delete tabMeta[tabId];
      }
    }

    delete windowState[windowId];
    delete windowState[String(windowId)];

    await writeMultipleStateEntries({
      [STORAGE_KEYS.TAB_META]: tabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: windowState,
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
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
    const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
    const tabEntry = tabMeta[tabId] || tabMeta[String(tabId)];
    if (tabEntry) {
      tabEntry.windowId = attachInfo.newWindowId;
      tabEntry.groupId = null;
      tabEntry.isSpecialGroup = false;
      await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
      logger.debug('Tab attached to new window, meta updated', {
        tabId,
        newWindowId: attachInfo.newWindowId,
      }, correlationId);
      scheduleDebouncedSortAndUpdate(attachInfo.newWindowId);
    }
  } catch (error) {
    logger.error('onAttached handler failed', { tabId, error: error.message }, correlationId);
  }
});

// ─── Tab Group Events ────────────────────────────────────────────────────────

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const correlationId = logger.correlationId();
  try {
    const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.WINDOW_STATE]);
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
    if (stateChanged) {
      await writeMultipleStateEntries({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
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

    if (group.title !== undefined) {
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
        const storedState = await readValidatedStateFromStorage([STORAGE_KEYS.TAB_META]);
        const tabMeta = storedState[STORAGE_KEYS.TAB_META] || {};
        const now = Date.now();
        const currentActiveTime = await getCurrentTotalActiveTimeMs();
        const redToGoneThreshold = newSettings.thresholds?.redToGone || DEFAULT_AGING_THRESHOLDS.RED_TO_GONE;
        const ageCap = redToGoneThreshold + 60_000;
        const wallClockCapTimestamp = now - ageCap;
        const activeTimeCapTimestamp = currentActiveTime - ageCap;
        let tabsCapped = 0;

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

        if (tabsCapped > 0) {
          await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
          logger.info('Age cap applied on aging re-enable', {
            cappedCount: tabsCapped,
            tabCount: Object.keys(tabMeta).length,
            capWindowMs: ageCap,
          }, correlationId);
        } else {
          logger.debug('Age cap check: no tabs needed capping', {
            tabCount: Object.keys(tabMeta).length,
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

/**
 * Scans all currently open browser tabs and creates fresh metadata entries for each.
 * Called on first extension install (when there's no existing stored state).
 */
async function scanAndTrackAllExistingTabs(correlationId) {
  try {
    const allBrowserTabs = await chrome.tabs.query({});
    const currentActiveTime = await getCurrentTotalActiveTimeMs();
    const now = Date.now();
    const tabMeta = {};

    for (const tab of allBrowserTabs) {
      if (tab.pinned) continue;
      tabMeta[tab.id] = {
        tabId: tab.id,
        windowId: tab.windowId,
        refreshActiveTime: currentActiveTime,
        refreshWallTime: now,
        status: TAB_LIFECYCLE_STAGE.GREEN,
        groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null,
        isSpecialGroup: false,
        pinned: false,
        url: tab.url || '',
      };
    }

    await writeMultipleStateEntries({ [STORAGE_KEYS.TAB_META]: tabMeta });
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
    await pendingReconciliationPromise;
    return;
  }
  pendingReconciliationPromise = performReconciliation(correlationId);
  try {
    await pendingReconciliationPromise;
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

    let allBrowserTabs, allBrowserWindows;
    if (storedMatchableUrlCount > 0) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        [allBrowserTabs, allBrowserWindows] = await Promise.all([
          chrome.tabs.query({}),
          chrome.windows.getAll(),
        ]);
        const browserTabsWithRealUrls = allBrowserTabs.filter(
          (tab) => !tab.pinned && isMatchableUrl(tab.url),
        ).length;
        if (browserTabsWithRealUrls >= storedMatchableUrlCount) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } else {
      [allBrowserTabs, allBrowserWindows] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getAll(),
      ]);
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
        matchedEntry.url = browserTab.url || matchedEntry.url || '';
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

        // Re-apply colors to managed groups — Chrome may reset them to grey on restart
        for (const groupType of ['yellow', 'red']) {
          const groupId = remappedSpecialGroups[groupType];
          if (groupId === null) continue;
          try {
            await chrome.tabGroups.update(groupId, { color: groupType });
          } catch (error) {
            logger.warn('Failed to restore managed group color after restart', {
              groupType, groupId, error: error.message,
            });
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
          groupZones: storedGroupZones,
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

    await writeMultipleStateEntries({
      [STORAGE_KEYS.TAB_META]: reconciledTabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: reconciledWindowState,
    });

    logger.info('State reconciled', {
      tabsInChrome: allBrowserTabs.length,
      tabsReconciled: Object.keys(reconciledTabMeta).length,
      urlMatches: urlMatchCount,
      windowsReconciled: Object.keys(reconciledWindowState).length,
      chromeWindowCount: allBrowserWindows.length,
      chromeWindowTypes: allBrowserWindows.map((w) => ({ id: w.id, type: w.type })),
      storedWindowCount: Object.keys(storedWindowState).length,
    }, correlationId);
  } catch (error) {
    logger.error('State reconciliation failed', { error: error.message, errorCode: ERROR_CODES.ERR_RECOVERY }, correlationId);
  }
}
