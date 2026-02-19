import { STORAGE_KEYS, ALARM_NAME, ALARM_PERIOD_MINUTES, DEFAULT_THRESHOLDS, DEFAULT_BOOKMARK_SETTINGS, DEFAULT_AUTO_GROUP_NAMING, DEFAULT_SHOW_GROUP_AGE, DEFAULT_AGING_TOGGLES, DEFAULT_TRANSITION_TOGGLES, DEFAULT_GROUP_NAMES, DEFAULT_AUTO_GROUP, TIME_MODE, STATUS, ERROR_CODES, SPECIAL_GROUP_TYPES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { readState, batchWrite } from './state-persistence.js';
import { createTabEntry, handleNavigation } from './tab-tracker.js';
import { evaluateAllTabs } from './status-evaluator.js';
import {
  isSpecialGroup,
  getSpecialGroupType,
  removeSpecialGroupIfEmpty,
  ungroupTab,
  computeGroupStatus,
  updateGroupColor,
  sortTabsAndGroups,
  dissolveUnnamedSingleTabGroups,
  dissolveSpecialGroups,
  autoNameEligibleGroups,
  applyUserEditLock,
  consumeExpectedExtensionTitleUpdate,
  consumeExpectedExtensionColorUpdate,
  updateGroupTitlesWithAge,
  removeAgeSuffixFromAllGroups,
} from './group-manager.js';
import { placeNewTab } from './tab-placer.js';
import { resolveBookmarkFolder, isBookmarkableUrl, bookmarkTab, bookmarkGroupTabs } from './bookmark-manager.js';
import {
  initActiveTime,
  recoverActiveTime,
  handleFocusChange,
  persistActiveTime,
  getCurrentActiveTime,
  getCachedActiveTimeState,
} from './time-accumulator.js';

const logger = createLogger('background');
const USER_EDIT_LOCK_MS = 15_000;

// Guard: suppress reactive event handlers while the evaluation cycle owns state
let evaluationCycleRunning = false;
let evaluationCycleStartedAt = 0;
const EVALUATION_CYCLE_TIMEOUT_MS = 60_000; // auto-reset guard after 60s

// Guard: suppress onUpdated groupId handler while placeNewTab is running
let tabPlacementRunning = false;

// Guard: suppress placeNewTab and navigation events during browser startup
// to avoid interfering with Chrome's session-restore group assignments.
// Chrome fires onCreated for restored tabs before groupId is set,
// so auto-placement would see them as ungrouped and disrupt groups.
// Uses a counter because both onInstalled and onStartup may run concurrently;
// the flag stays true until ALL startup handlers have completed.
let _startupRefCount = 0;
let startupInProgress = false;
let reconcilePromise = null; // mutex: only one reconcileState at a time
const navigationMutationTabs = new Set(); // tabIds being mutated by navigation reset flow

// ─── Debounced Sort & Title Update ───────────────────────────────────────────
// Called from reactive event handlers (tab move, group change, etc.) to keep
// the tab bar sorted and group titles/colors up to date without waiting for
// the next 30-second evaluation cycle.
const SORT_DEBOUNCE_MS = 300;
const _sortTimers = new Map(); // windowId → timeoutId
let sortUpdateRunning = false; // suppress reactive handlers during sort

function resolveAutoGroupNamingSettings(settings) {
  const enabled = typeof settings?.autoGroupNamingEnabled === 'boolean'
    ? settings.autoGroupNamingEnabled
    : DEFAULT_AUTO_GROUP_NAMING.ENABLED;
  const delayMinutes = Number.isInteger(settings?.autoGroupNamingDelayMinutes)
    && settings.autoGroupNamingDelayMinutes > 0
    ? settings.autoGroupNamingDelayMinutes
    : DEFAULT_AUTO_GROUP_NAMING.DELAY_MINUTES;
  return { enabled, delayMinutes };
}

function _scheduleSortAndUpdate(windowId) {
  if (evaluationCycleRunning || sortUpdateRunning) return;
  const existing = _sortTimers.get(windowId);
  if (existing) clearTimeout(existing);
  _sortTimers.set(windowId, setTimeout(() => {
    _sortTimers.delete(windowId);
    _runSortAndUpdate(windowId);
  }, SORT_DEBOUNCE_MS));
}

async function _runSortAndUpdate(windowId) {
  if (evaluationCycleRunning || sortUpdateRunning) return;
  sortUpdateRunning = true;
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = state[STORAGE_KEYS.SETTINGS] || {};

    // Reconcile groupIds for this window before sorting
    try {
      const chromeTabs = await chrome.tabs.query({ windowId: Number(windowId) });
      for (const ct of chromeTabs) {
        const meta = tabMeta[ct.id] || tabMeta[String(ct.id)];
        if (!meta) continue;
        const actualGroupId = ct.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? ct.groupId : null;
        if (meta.groupId !== actualGroupId) {
          meta.groupId = actualGroupId;
          meta.isSpecialGroup = actualGroupId !== null && isSpecialGroup(actualGroupId, Number(windowId), windowState);
        }
      }
    } catch (err) {
      logger.warn('Sort-update: failed to reconcile groupIds', { windowId, error: err.message }, cid);
    }

    await dissolveUnnamedSingleTabGroups(windowId, tabMeta, windowState);

    // Only sort tabs/groups based on aging status when the master toggle is on.
    // When aging is disabled, stale statuses must not drive tab placement or group reordering.
    const agingOn = settings.agingEnabled !== false;
    if (agingOn) {
      await sortTabsAndGroups(windowId, tabMeta, windowState, undefined, settings);
    }

    const autoNaming = resolveAutoGroupNamingSettings(settings);
    await autoNameEligibleGroups(windowId, tabMeta, windowState, autoNaming);

    // Update group titles with age if enabled (gated on agingEnabled in T009)
    const showGroupAge = agingOn && (typeof settings.showGroupAge === 'boolean'
      ? settings.showGroupAge
      : DEFAULT_SHOW_GROUP_AGE);
    if (showGroupAge) {
      const currentActiveTime = await getCurrentActiveTime();
      await updateGroupTitlesWithAge(windowId, tabMeta, windowState, currentActiveTime, settings);
    } else {
      await removeAgeSuffixFromAllGroups(windowId, windowState);
    }

    await batchWrite({
      [STORAGE_KEYS.TAB_META]: tabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: windowState,
    });
    logger.debug('Debounced sort+update complete', { windowId }, cid);
  } catch (err) {
    logger.warn('Debounced sort+update failed', { windowId, error: err.message }, cid);
  } finally {
    sortUpdateRunning = false;
  }
}

// ─── Installation ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  const cid = logger.correlationId();
  logger.info('Extension installed/updated', { reason: details.reason }, cid);

  // Check if storage already has tab data — used to detect false "install"
  // events (unpacked extension reload on an existing profile).
  let isFalseInstall = false;
  let storedTabCount;
  try {
    if (details.reason === 'install') {
      const existing = await readState([STORAGE_KEYS.TAB_META]);
      const existingMeta = existing[STORAGE_KEYS.TAB_META];
      storedTabCount = existingMeta ? Object.keys(existingMeta).length : 0;
      isFalseInstall = storedTabCount > 0;

      if (isFalseInstall) {
        _startupRefCount++; startupInProgress = _startupRefCount > 0;
        logger.info('Existing tab data found on install — treating as reconciliation', {
          existingTabCount: storedTabCount,
        }, cid);
      } else {
        const defaultSettings = {
          timeMode: TIME_MODE.ACTIVE,
          thresholds: {
            greenToYellow: DEFAULT_THRESHOLDS.GREEN_TO_YELLOW,
            yellowToRed: DEFAULT_THRESHOLDS.YELLOW_TO_RED,
            redToGone: DEFAULT_THRESHOLDS.RED_TO_GONE,
          },
          // v2 aging toggles
          agingEnabled: DEFAULT_AGING_TOGGLES.AGING_ENABLED,
          tabSortingEnabled: DEFAULT_AGING_TOGGLES.TAB_SORTING_ENABLED,
          tabgroupSortingEnabled: DEFAULT_AGING_TOGGLES.TABGROUP_SORTING_ENABLED,
          tabgroupColoringEnabled: DEFAULT_AGING_TOGGLES.TABGROUP_COLORING_ENABLED,
          showGroupAge: DEFAULT_SHOW_GROUP_AGE,
          // v2 transition toggles
          greenToYellowEnabled: DEFAULT_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED,
          yellowToRedEnabled: DEFAULT_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED,
          redToGoneEnabled: DEFAULT_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED,
          // v2 group names
          yellowGroupName: DEFAULT_GROUP_NAMES.YELLOW_GROUP_NAME,
          redGroupName: DEFAULT_GROUP_NAMES.RED_GROUP_NAME,
          // Bookmark settings
          bookmarkEnabled: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED,
          bookmarkFolderName: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME,
          // Auto-group settings (independent of aging)
          autoGroupEnabled: DEFAULT_AUTO_GROUP.ENABLED,
          autoGroupNamingEnabled: DEFAULT_AUTO_GROUP_NAMING.ENABLED,
          autoGroupNamingDelayMinutes: DEFAULT_AUTO_GROUP_NAMING.DELAY_MINUTES,
        };

        await batchWrite({
          [STORAGE_KEYS.SCHEMA_VERSION]: 2,
          [STORAGE_KEYS.SETTINGS]: defaultSettings,
          [STORAGE_KEYS.TAB_META]: {},
          [STORAGE_KEYS.WINDOW_STATE]: {},
          [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: null },
        });

        await initActiveTime();
        logger.info('Storage initialized with defaults', null, cid);
      }
    }

    // v1 → v2 migration: add new fields with defaults, preserve existing fields
    if (details.reason === 'update') {
      const state = await readState([STORAGE_KEYS.SCHEMA_VERSION, STORAGE_KEYS.SETTINGS]);
      const schemaVersion = state[STORAGE_KEYS.SCHEMA_VERSION];
      if (schemaVersion === 1) {
        const existing = state[STORAGE_KEYS.SETTINGS] || {};
        const migrated = {
          ...existing,
          agingEnabled: existing.agingEnabled ?? DEFAULT_AGING_TOGGLES.AGING_ENABLED,
          tabSortingEnabled: existing.tabSortingEnabled ?? DEFAULT_AGING_TOGGLES.TAB_SORTING_ENABLED,
          tabgroupSortingEnabled: existing.tabgroupSortingEnabled ?? DEFAULT_AGING_TOGGLES.TABGROUP_SORTING_ENABLED,
          tabgroupColoringEnabled: existing.tabgroupColoringEnabled ?? DEFAULT_AGING_TOGGLES.TABGROUP_COLORING_ENABLED,
          greenToYellowEnabled: existing.greenToYellowEnabled ?? DEFAULT_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED,
          yellowToRedEnabled: existing.yellowToRedEnabled ?? DEFAULT_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED,
          redToGoneEnabled: existing.redToGoneEnabled ?? DEFAULT_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED,
          yellowGroupName: existing.yellowGroupName ?? DEFAULT_GROUP_NAMES.YELLOW_GROUP_NAME,
          redGroupName: existing.redGroupName ?? DEFAULT_GROUP_NAMES.RED_GROUP_NAME,
          autoGroupEnabled: existing.autoGroupEnabled ?? DEFAULT_AUTO_GROUP.ENABLED,
        };
        await batchWrite({
          [STORAGE_KEYS.SCHEMA_VERSION]: 2,
          [STORAGE_KEYS.SETTINGS]: migrated,
        });
        logger.info('Migrated settings from schema v1 to v2', { fieldsAdded: 10 }, cid);
      }
    }

    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
    logger.info('Alarm created', { name: ALARM_NAME, periodMinutes: ALARM_PERIOD_MINUTES }, cid);

    if (details.reason === 'install' && isFalseInstall) {
      // False "install" — unpacked extension reloaded on an existing profile.
      // reconcileState now handles waiting for tab URLs internally.
      await reconcileState(cid);
    } else if (details.reason === 'install') {
      await scanExistingTabs(cid);
    } else {
      await reconcileState(cid);
    }

    await runEvaluationCycle(cid);
  } catch (err) {
    logger.error('onInstalled handler failed', { error: err.message, errorCode: ERROR_CODES.ERR_ALARM_CREATE }, cid);
  } finally {
    if (isFalseInstall) {
      _startupRefCount--; startupInProgress = _startupRefCount > 0;
      logger.info('Startup guard cleared (false install)', { refCount: _startupRefCount }, cid);
    }
  }
});

// ─── Browser Startup ─────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  _startupRefCount++; startupInProgress = _startupRefCount > 0;
  const cid = logger.correlationId();
  logger.info('Browser startup detected', null, cid);

  try {
    await recoverActiveTime();

    const alarm = await chrome.alarms.get(ALARM_NAME);
    if (!alarm) {
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
      logger.info('Alarm recreated on startup', null, cid);
    }

    await reconcileState(cid);

    await runEvaluationCycle(cid);
  } catch (err) {
    logger.error('onStartup handler failed', { error: err.message, errorCode: ERROR_CODES.ERR_RECOVERY }, cid);
  } finally {
    _startupRefCount--; startupInProgress = _startupRefCount > 0;
    logger.info('Startup guard cleared', { refCount: _startupRefCount }, cid);
  }
});

// ─── Alarm (Evaluation Cycle) ────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const cid = logger.correlationId();
  logger.debug('Alarm fired', { name: alarm.name }, cid);
  try {
    await runEvaluationCycle(cid);
  } catch (err) {
    logger.error('Evaluation cycle failed', { error: err.message, stack: err.stack }, cid);
  }
});

// Exposed on globalThis for E2E test harness (CDP) to call directly.
self.__runEvaluationCycle = runEvaluationCycle;
Object.defineProperty(self, '__evaluationCycleRunning', {
  get() { return evaluationCycleRunning; },
});
Object.defineProperty(self, '__sortUpdateRunning', {
  get() { return sortUpdateRunning; },
});

async function runEvaluationCycle(cid) {
  if (evaluationCycleRunning) {
    const elapsed = Date.now() - evaluationCycleStartedAt;
    if (elapsed < EVALUATION_CYCLE_TIMEOUT_MS) {
      logger.debug('Evaluation cycle already running, skipping', { elapsedMs: elapsed }, cid);
      return;
    }
    logger.warn('Evaluation cycle guard timed out, resetting', { elapsedMs: elapsed }, cid);
  }
  evaluationCycleRunning = true;
  evaluationCycleStartedAt = Date.now();
  try {
    await _runEvaluationCycleInner(cid);
  } finally {
    evaluationCycleRunning = false;
  }
}

async function _runEvaluationCycleInner(cid) {
  await persistActiveTime();

  const state = await readState([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TAB_META,
    STORAGE_KEYS.WINDOW_STATE,
  ]);

  const settings = state[STORAGE_KEYS.SETTINGS];
  if (!settings) {
    logger.error('Settings missing from storage, skipping evaluation cycle. Reinstall extension or check storage.', {}, cid);
    return;
  }
  const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
  const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
  const currentActiveTime = await getCurrentActiveTime();

  // When aging is disabled, skip the entire status evaluation and per-window operations.
  // The alarm still fires and active time still accumulates, but tabs freeze in their current state.
  const agingEnabled = settings.agingEnabled !== false; // default true for legacy settings
  if (!agingEnabled) {
    logger.debug('Aging disabled, skipping evaluation cycle', {
      tabCount: Object.keys(tabMeta).length,
    }, cid);
    return;
  }

  // Diagnostic: log active time state and settings for debugging age calculations
  const activeTimeState = await getCachedActiveTimeState();
  logger.info('Evaluation cycle start', {
    timeMode: settings.timeMode,
    currentActiveTimeMs: currentActiveTime,
    accumulatedMs: activeTimeState.accumulatedMs,
    focusStartTime: activeTimeState.focusStartTime,
    thresholds: settings.thresholds,
    tabCount: Object.keys(tabMeta).length,
  }, cid);

  // Reconcile groupId: fix stale tabMeta.groupId values by querying Chrome
  let groupIdFixes = 0;
  try {
    const chromeTabs = await chrome.tabs.query({});
    for (const ct of chromeTabs) {
      const meta = tabMeta[ct.id] || tabMeta[String(ct.id)];
      if (!meta) continue;
      const actualGroupId = ct.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? ct.groupId : null;
      if (meta.groupId !== actualGroupId) {
        meta.groupId = actualGroupId;
        groupIdFixes++;
      }
      // Keep URL in sync for cross-restart matching
      if (ct.url && ct.url !== meta.url) meta.url = ct.url;
    }
    if (groupIdFixes > 0) {
      logger.info('Reconciled stale groupIds in tabMeta', { fixes: groupIdFixes }, cid);
    }
  } catch (err) {
    logger.warn('Failed to reconcile groupIds', { error: err.message }, cid);
  }

  const transitions = evaluateAllTabs(tabMeta, currentActiveTime, settings);
  const transitionCount = Object.keys(transitions).length;

  // Apply ALL transitions to tabMeta (including gone — sortTabsAndGroups handles closing)
  for (const [tabId, t] of Object.entries(transitions)) {
    tabMeta[tabId].status = t.newStatus;
  }

  // ── Build goneConfig for sortTabsAndGroups ─────────────────────────
  const bookmarkEnabled = typeof settings.bookmarkEnabled === 'boolean'
    ? settings.bookmarkEnabled
    : DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED;
  let bookmarkFolderId = null;

  // Check if any tab has gone status — resolve bookmark folder once
  const hasGoneTabs = Object.values(tabMeta).some((m) => m.status === STATUS.GONE);
  if (bookmarkEnabled && hasGoneTabs) {
    bookmarkFolderId = await resolveBookmarkFolder(settings);
    logger.debug('Bookmark folder resolved for gone handling', { bookmarkFolderId, bookmarkEnabled }, cid);
  }

  const goneConfig = {
    bookmarkEnabled,
    bookmarkFolderId,
    bookmarkTab,
    bookmarkGroupTabs,
    isBookmarkableUrl,
  };

  // ── Per-window: dissolve, sort (incl. gone handling), update titles ─
  const allWindows = new Set(Object.values(tabMeta).map((m) => m.windowId));
  const autoNaming = resolveAutoGroupNamingSettings(settings);

  for (const wid of allWindows) {
    // Dissolve unnamed single-tab groups
    await dissolveUnnamedSingleTabGroups(wid, tabMeta, windowState);

    // Unified sort: reads browser state, moves ungrouped tabs to special
    // groups as needed, closes gone tabs/groups, then sorts remaining
    // groups into zone order
    await sortTabsAndGroups(wid, tabMeta, windowState, goneConfig, settings);

    await autoNameEligibleGroups(wid, tabMeta, windowState, autoNaming);

    // Update group titles with age if enabled
    const showGroupAge = typeof settings.showGroupAge === 'boolean'
      ? settings.showGroupAge
      : DEFAULT_SHOW_GROUP_AGE;
    logger.debug('showGroupAge resolved', { showGroupAge, settingsValue: settings.showGroupAge, default: DEFAULT_SHOW_GROUP_AGE });
    if (showGroupAge) {
      await updateGroupTitlesWithAge(wid, tabMeta, windowState, currentActiveTime, settings);
    } else {
      await removeAgeSuffixFromAllGroups(wid, windowState);
    }
  }

  await batchWrite({
    [STORAGE_KEYS.TAB_META]: tabMeta,
    [STORAGE_KEYS.WINDOW_STATE]: windowState,
  });

  if (transitionCount > 0) {
    logger.info('Evaluation cycle complete with transitions', {
      tabCount: Object.keys(tabMeta).length,
      transitions: transitionCount,
      currentActiveTimeMs: currentActiveTime,
    }, cid);
  } else {
    logger.debug('Evaluation cycle complete, no transitions', {
      tabCount: Object.keys(tabMeta).length,
      currentActiveTimeMs: currentActiveTime,
    }, cid);
  }
}

// ─── Tab Events ──────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener(async (tab) => {
  const cid = logger.correlationId();
  try {
    if (tab.pinned) {
      logger.debug('Skipping pinned tab creation', { tabId: tab.id }, cid);
      return;
    }

    // During browser startup, Chrome restores the previous session and fires
    // onCreated for each restored tab.  At that point groupId is not yet set,
    // so placeNewTab would see ungrouped tabs and disrupt group restoration.
    // Also, reconcileState may have already matched this tab by URL and
    // preserved its age — we must NOT overwrite that entry with a fresh one.
    if (startupInProgress) {
      const state = await readState([STORAGE_KEYS.TAB_META]);
      const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
      if (!tabMeta[tab.id] && !tabMeta[String(tab.id)]) {
        const currentActiveTime = await getCurrentActiveTime();
        tabMeta[tab.id] = createTabEntry(tab, currentActiveTime);
        await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
      }
      logger.debug('Startup in progress, skipping tab placement', { tabId: tab.id, windowId: tab.windowId }, cid);
      return;
    }

    // Track the new tab in meta
    const currentActiveTime = await getCurrentActiveTime();
    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = state[STORAGE_KEYS.SETTINGS] || {};

    // Only create a fresh entry if this tab isn't already tracked.
    // After a restart, reconcileState may have already matched this tab
    // by URL and preserved its age — we must not overwrite that entry.
    if (!tabMeta[tab.id] && !tabMeta[String(tab.id)]) {
      tabMeta[tab.id] = createTabEntry(tab, currentActiveTime);
    }

    // Context-aware placement for non-command-created tabs (e.g., middle-click, link open)
    // Guard covers both placement and persist so onUpdated events triggered by
    // chrome.tabs.group() inside placeNewTab cannot race with our batchWrite.
    tabPlacementRunning = true;
    try {
      await placeNewTab(tab, tab.windowId, tabMeta, windowState, settings);
      // Persist all meta changes (includes group updates from placeNewTab)
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    } finally {
      tabPlacementRunning = false;
    }
    logger.debug('Tab created', { tabId: tab.id, windowId: tab.windowId }, cid);
    _scheduleSortAndUpdate(tab.windowId);
  } catch (err) {
    logger.error('onCreated handler failed', { tabId: tab.id, error: err.message }, cid);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (evaluationCycleRunning || sortUpdateRunning) return;
  const cid = logger.correlationId();
  try {
    _lastNavHandled.delete(tabId);
    _restoredFromDiscardAt.delete(tabId);
    if (removeInfo.isWindowClosing) {
      logger.debug('Tab removed due to window closing, skipping', { tabId }, cid);
      return;
    }
    const state = await readState([STORAGE_KEYS.TAB_META]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const removedMeta = tabMeta[tabId] || tabMeta[String(tabId)] || null;
    delete tabMeta[tabId];
    delete tabMeta[String(tabId)];
    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    // Check if removed tab was in a special group and clean up if empty
    const wsState = await readState([STORAGE_KEYS.WINDOW_STATE]);
    const wState = wsState[STORAGE_KEYS.WINDOW_STATE] || {};
    if (removedMeta && removedMeta.isSpecialGroup && removedMeta.groupId !== null) {
      const groupType = getSpecialGroupType(removedMeta.groupId, removeInfo.windowId, wState);
      if (groupType) {
        await removeSpecialGroupIfEmpty(removeInfo.windowId, groupType, wState);
        await batchWrite({ [STORAGE_KEYS.WINDOW_STATE]: wState });
      }
    }
    // Dissolve unnamed groups that now have only one tab
    await dissolveUnnamedSingleTabGroups(removeInfo.windowId, tabMeta, wState);
    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });

    logger.debug('Tab removed', { tabId, windowId: removeInfo.windowId }, cid);
    _scheduleSortAndUpdate(removeInfo.windowId);
  } catch (err) {
    logger.error('onRemoved handler failed', { tabId, error: err.message }, cid);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const cid = logger.correlationId();

  if (changeInfo.discarded === false) {
    _restoredFromDiscardAt.set(tabId, Date.now());
    logger.debug('Tab restored from discarded state', { tabId, windowId: tab.windowId }, cid);
  }

  // T041: Handle user manually moving tab to a different group
  // Skip if the evaluation cycle is running — it owns state and will persist it.
  if (changeInfo.groupId !== undefined
      && !evaluationCycleRunning
      && !tabPlacementRunning
      && !sortUpdateRunning
      && !navigationMutationTabs.has(tabId)) {
    try {
      const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
      const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
      const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
      const meta = tabMeta[tabId] || tabMeta[String(tabId)];
      const newGroupId = changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? changeInfo.groupId : null;
      if (meta) {
        const oldGroupId = meta.groupId;
        meta.groupId = newGroupId;
        meta.isSpecialGroup = newGroupId !== null && isSpecialGroup(newGroupId, tab.windowId, windowState);
        logger.debug('Tab group changed', { tabId, oldGroupId, newGroupId, windowId: tab.windowId }, cid);
      }
      // Dissolve any extension-created unnamed groups now left with a single tab
      await dissolveUnnamedSingleTabGroups(tab.windowId, tabMeta, windowState);
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
      _scheduleSortAndUpdate(tab.windowId);
    } catch (err) {
      logger.error('onUpdated groupId handler failed', { tabId, error: err.message }, cid);
    }
  }
  if (changeInfo.pinned !== undefined) {
    try {
      const state = await readState([STORAGE_KEYS.TAB_META]);
      const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
      if (changeInfo.pinned) {
        delete tabMeta[tabId];
        delete tabMeta[String(tabId)];
        logger.debug('Tab pinned, removed from tracking', { tabId }, cid);
      } else {
        const currentActiveTime = await getCurrentActiveTime();
        tabMeta[tabId] = createTabEntry(tab, currentActiveTime);
        logger.debug('Tab unpinned, added as fresh green', { tabId }, cid);
      }
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    } catch (err) {
      logger.error('onUpdated pinned handler failed', { tabId, error: err.message }, cid);
    }
  }
});

// ─── Tab Moved (backup dissolution trigger) ─────────────────────────────────

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  if (evaluationCycleRunning || sortUpdateRunning) return;
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const { dissolved } = await dissolveUnnamedSingleTabGroups(moveInfo.windowId, tabMeta, windowState);
    if (dissolved > 0) {
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
      logger.debug('Dissolved groups after tab move', { tabId, windowId: moveInfo.windowId, dissolved }, cid);
    }
    _scheduleSortAndUpdate(moveInfo.windowId);
  } catch (err) {
    logger.warn('onMoved dissolution check failed', { tabId, error: err.message }, cid);
  }
});

// ─── Navigation ──────────────────────────────────────────────────────────────

// Per-tab debounce: avoid double-processing when both onCommitted and
// onHistoryStateUpdated fire for the same tab within a short window.
const NAV_DEBOUNCE_MS = 1000;
const _lastNavHandled = new Map();
const RESTORE_NAV_SUPPRESSION_MS = 5000;
const _restoredFromDiscardAt = new Map();

function _consumeDiscardRestoreMarker(tabId, now) {
  const markedAt = _restoredFromDiscardAt.get(tabId);
  if (!markedAt) return false;
  if (now - markedAt > RESTORE_NAV_SUPPRESSION_MS) {
    _restoredFromDiscardAt.delete(tabId);
    return false;
  }
  _restoredFromDiscardAt.delete(tabId);
  return true;
}

async function _handleNavigationEvent(tabId, source) {
  // During startup, session-restored tabs "navigate" to their saved URLs.
  // These are not user-initiated navigations and must not reset tab ages.
  if (startupInProgress) {
    return;
  }

  const now = Date.now();
  const last = _lastNavHandled.get(tabId) || 0;
  if (now - last < NAV_DEBOUNCE_MS) {
    logger.debug('Navigation debounced', { tabId, source, sinceLast: now - last });
    return;
  }
  _lastNavHandled.set(tabId, now);

  const cid = logger.correlationId();
  navigationMutationTabs.add(tabId);
  try {
    if (_consumeDiscardRestoreMarker(tabId, now)) {
      logger.debug('Ignoring navigation immediately after discarded-tab restore', { tabId, source }, cid);
      return;
    }
    // Skip navigations caused by Chrome restoring a suspended/discarded tab.
    // The tab was not actively navigated by the user — its age should not reset.
    let navUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded || tab.status === 'unloaded') {
        logger.debug('Ignoring navigation for discarded/suspended tab', { tabId, source }, cid);
        return;
      }
      navUrl = tab.url || '';
    } catch { /* tab gone — will be caught below */ }

    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE, STORAGE_KEYS.SETTINGS]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const settings = state[STORAGE_KEYS.SETTINGS] || {};
    const existing = tabMeta[tabId] || tabMeta[String(tabId)];
    if (!existing) {
      logger.debug('Navigation for untracked tab, skipping', { tabId, source }, cid);
      return;
    }

    // Suppress session-restore "navigations": when Chrome lazily loads a
    // previously frozen tab the URL matches what we already have stored.
    // This is not a user-initiated navigation and must not reset the age.
    if (navUrl && existing.url && navUrl === existing.url) {
      logger.debug('Navigation URL matches stored URL, suppressing age reset', { tabId, source, url: navUrl }, cid);
      return;
    }

    const currentActiveTime = await getCurrentActiveTime();
    const updated = handleNavigation(existing, currentActiveTime, navUrl);
    tabMeta[tabId] = updated;

    // Determine if the tab is in a special group.  Check both stored meta
    // AND the live Chrome group (the stored flag can be stale).
    let inSpecialGroup = existing.isSpecialGroup && existing.groupId !== null;
    let specialGroupId = inSpecialGroup ? existing.groupId : null;

    if (!inSpecialGroup) {
      // Fallback: query the live Chrome tab to get its current groupId
      try {
        const liveTab = await chrome.tabs.get(tabId);
        const liveGroupId = liveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
          ? liveTab.groupId : null;
        if (liveGroupId !== null && isSpecialGroup(liveGroupId, liveTab.windowId, windowState)) {
          inSpecialGroup = true;
          specialGroupId = liveGroupId;
          // Fix the stale meta
          updated.groupId = liveGroupId;
          updated.isSpecialGroup = true;
        }
      } catch { /* tab may have been removed */ }
    }

    // FR-024: If tab was in a special group, ungroup it (navigating resets to green)
    if (inSpecialGroup) {
      await ungroupTab(tabId);
      updated.groupId = null;
      updated.isSpecialGroup = false;
      tabMeta[tabId] = updated;

      // Move ungrouped tab to the green zone (leftmost position)
      try {
        await chrome.tabs.move(tabId, { index: 0 });
      } catch (moveErr) {
        logger.warn('Failed to move ungrouped tab to green zone', {
          tabId,
          error: moveErr.message,
        }, cid);
      }

      // Clean up empty special group (FR-015)
      const groupType = getSpecialGroupType(specialGroupId, existing.windowId, windowState);
      if (groupType) {
        await removeSpecialGroupIfEmpty(existing.windowId, groupType, windowState);
      }

      logger.debug('Tab navigated out of special group', {
        tabId, specialGroupId, windowId: existing.windowId,
      }, cid);
    }

    // For tabs in user groups: update group color and re-sort immediately.
    // All aging-driven visual updates (color, sorting) are suppressed when the
    // master agingEnabled toggle is off, so stale statuses cannot move tabs.
    const agingOn = settings.agingEnabled !== false;
    const groupId = updated.groupId;
    if (agingOn && groupId !== null && !updated.isSpecialGroup
        && !isSpecialGroup(groupId, existing.windowId, windowState)) {
      if (settings.tabgroupColoringEnabled !== false) {
        const groupStatus = computeGroupStatus(groupId, tabMeta);
        if (groupStatus) {
          await updateGroupColor(groupId, groupStatus);
        }
      }
    }
    if (agingOn) {
      await sortTabsAndGroups(existing.windowId, tabMeta, windowState, undefined, settings);
    }

    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: windowState });
    logger.debug('Navigation handled, refresh time reset', { tabId, source }, cid);
  } catch (err) {
    logger.error('Navigation handler failed', { tabId, source, error: err.message }, cid);
  } finally {
    navigationMutationTabs.delete(tabId);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await _handleNavigationEvent(details.tabId, 'onCommitted');
});

// Catch SPA navigations (pushState / replaceState) that don't trigger onCommitted.
// Sites like Reddit, YouTube, Twitter, etc. use the History API for in-page navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await _handleNavigationEvent(details.tabId, 'onHistoryStateUpdated');
});

// ─── Window Focus ────────────────────────────────────────────────────────────

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const cid = logger.correlationId();
  try {
    const updatedState = await handleFocusChange(windowId);
    if (updatedState) {
      await persistActiveTime();
    }
    logger.debug('Window focus changed', { windowId }, cid);
  } catch (err) {
    logger.error('onFocusChanged handler failed', { windowId, error: err.message }, cid);
  }
});

// ─── Window Removed ──────────────────────────────────────────────────────────

chrome.windows.onRemoved.addListener(async (windowId) => {
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};

    // Remove all tab entries for this window
    for (const [tabId, meta] of Object.entries(tabMeta)) {
      if (meta.windowId === windowId || meta.windowId === Number(windowId)) {
        delete tabMeta[tabId];
      }
    }

    // Remove window state
    delete windowState[windowId];
    delete windowState[String(windowId)];

    await batchWrite({
      [STORAGE_KEYS.TAB_META]: tabMeta,
      [STORAGE_KEYS.WINDOW_STATE]: windowState,
    });
    logger.info('Window removed, state cleaned up', { windowId }, cid);
  } catch (err) {
    logger.error('onWindowRemoved handler failed', { windowId, error: err.message }, cid);
  }
});

// ─── Tab Detach/Attach (Cross-Window Moves) ──────────────────────────────────

chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
  const cid = logger.correlationId();
  logger.debug('Tab detached', { tabId, oldWindowId: detachInfo.oldWindowId }, cid);
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.TAB_META]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const meta = tabMeta[tabId] || tabMeta[String(tabId)];
    if (meta) {
      // Retain refresh times (FR-007), update windowId and clear group
      meta.windowId = attachInfo.newWindowId;
      meta.groupId = null;
      meta.isSpecialGroup = false;
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
      logger.debug('Tab attached to new window, meta updated', {
        tabId,
        newWindowId: attachInfo.newWindowId,
      }, cid);
      _scheduleSortAndUpdate(attachInfo.newWindowId);
    }
  } catch (err) {
    logger.error('onAttached handler failed', { tabId, error: err.message }, cid);
  }
});

// ─── Tab Group Events ────────────────────────────────────────────────────────

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.WINDOW_STATE]);
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const ws = windowState[group.windowId] || windowState[String(group.windowId)];
    let changed = false;
    if (ws && ws.specialGroups) {
      if (ws.specialGroups.yellow === group.id) {
        ws.specialGroups.yellow = null;
        changed = true;
      }
      if (ws.specialGroups.red === group.id) {
        ws.specialGroups.red = null;
        changed = true;
      }
    }
    if (ws && ws.groupZones) {
      delete ws.groupZones[group.id];
      delete ws.groupZones[String(group.id)];
      changed = true;
    }
    if (ws && ws.groupNaming) {
      delete ws.groupNaming[group.id];
      delete ws.groupNaming[String(group.id)];
      changed = true;
    }
    if (changed) {
      await batchWrite({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
      logger.info('Group removed externally, cleaned metadata', { groupId: group.id, windowId: group.windowId }, cid);
    }
    logger.debug('Tab group removed', { groupId: group.id, windowId: group.windowId }, cid);
    _scheduleSortAndUpdate(group.windowId);
  } catch (err) {
    logger.error('onGroupRemoved handler failed', { groupId: group.id, error: err.message }, cid);
  }
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.WINDOW_STATE]);
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    // T017: Detect user-initiated renames of special groups and persist to settings
    if (isSpecialGroup(group.id, group.windowId, windowState)) {
      // Check if this title change was initiated by the extension (guard flag)
      const extensionTitleWrite = typeof group.title === 'string'
        && consumeExpectedExtensionTitleUpdate(group.id, group.title);
      if (typeof group.color === 'string') {
        consumeExpectedExtensionColorUpdate(group.id, group.color);
      }

      if (!extensionTitleWrite && typeof group.title === 'string') {
        // User renamed the special group — persist to settings
        const sgType = getSpecialGroupType(group.id, group.windowId, windowState);
        if (sgType) {
          const nameKey = sgType === SPECIAL_GROUP_TYPES.YELLOW ? 'yellowGroupName' : 'redGroupName';
          const settingsState = await readState([STORAGE_KEYS.SETTINGS]);
          const currentSettings = settingsState[STORAGE_KEYS.SETTINGS] || {};
          if (currentSettings[nameKey] !== group.title) {
            currentSettings[nameKey] = group.title;
            await batchWrite({ [STORAGE_KEYS.SETTINGS]: currentSettings });
            logger.info('User renamed special group, persisted to settings', {
              groupId: group.id, type: sgType, newTitle: group.title,
            }, cid);
          }
        }
      }
      // Ignore color changes on special groups (color is identity-based)
      return;
    }

    const extensionTitleWrite = typeof group.title === 'string'
      && consumeExpectedExtensionTitleUpdate(group.id, group.title);
    const extensionColorWrite = typeof group.color === 'string'
      && consumeExpectedExtensionColorUpdate(group.id, group.color);
    if (extensionTitleWrite || extensionColorWrite) {
      logger.debug('Tab group update acknowledged as extension write', {
        groupId: group.id,
        windowId: group.windowId,
        extensionTitleWrite,
        extensionColorWrite,
      }, cid);
      return;
    }

    if (group.title !== undefined) {
      const lockResult = applyUserEditLock(group.windowId, group, windowState, USER_EDIT_LOCK_MS);
      await batchWrite({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
      logger.debug('Recorded user group title edit lock', {
        groupId: group.id,
        windowId: group.windowId,
        lockResult,
      }, cid);
    }

    logger.debug('Tab group updated by user', { groupId: group.id, title: group.title, color: group.color }, cid);
    _scheduleSortAndUpdate(group.windowId);
  } catch (err) {
    logger.error('onGroupUpdated handler failed', { groupId: group.id, error: err.message }, cid);
  }
});

// ─── Storage Changes ─────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;

  const cid = logger.correlationId();
  if (changes[STORAGE_KEYS.SETTINGS]) {
    const oldSettings = changes[STORAGE_KEYS.SETTINGS].oldValue || {};
    const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue || {};

    // T010: Age cap — when agingEnabled transitions from false → true
    if (oldSettings.agingEnabled === false && newSettings.agingEnabled !== false) {
      try {
        const state = await readState([STORAGE_KEYS.TAB_META]);
        const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
        const now = Date.now();
        const currentActiveTime = await getCurrentActiveTime();
        const redToGone = newSettings.thresholds?.redToGone || DEFAULT_THRESHOLDS.RED_TO_GONE;
        const capWindow = redToGone + 60_000; // redToGone + 1 minute
        const wallCapTimestamp = now - capWindow;
        const activeCapTimestamp = currentActiveTime - capWindow;
        let cappedCount = 0;

        for (const meta of Object.values(tabMeta)) {
          let changed = false;
          if (meta.refreshWallTime < wallCapTimestamp) {
            meta.refreshWallTime = wallCapTimestamp;
            changed = true;
          }
          if (meta.refreshActiveTime < activeCapTimestamp) {
            meta.refreshActiveTime = activeCapTimestamp;
            changed = true;
          }
          if (changed) cappedCount++;
        }

        if (cappedCount > 0) {
          await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
          logger.info('Age cap applied on aging re-enable', {
            cappedCount,
            tabCount: Object.keys(tabMeta).length,
            capWindowMs: capWindow,
          }, cid);
        } else {
          logger.debug('Age cap check: no tabs needed capping', {
            tabCount: Object.keys(tabMeta).length,
          }, cid);
        }
      } catch (err) {
        logger.error('Failed to apply age cap', { error: err.message }, cid);
      }
    }

    // T012: Dissolution — when tabSortingEnabled transitions from true → false
    if (oldSettings.tabSortingEnabled !== false && newSettings.tabSortingEnabled === false) {
      try {
        await _dissolveAllSpecialGroups(cid);
      } catch (err) {
        logger.error('Failed to dissolve special groups', { error: err.message }, cid);
      }
    }

    // T018: Reactive group name update — when yellowGroupName or redGroupName changes
    if (oldSettings.yellowGroupName !== newSettings.yellowGroupName
        || oldSettings.redGroupName !== newSettings.redGroupName) {
      try {
        await _updateSpecialGroupNames(newSettings, cid);
      } catch (err) {
        logger.error('Failed to update special group names', { error: err.message }, cid);
      }
    }

    logger.info('Settings changed, triggering re-evaluation', null, cid);
    try {
      await runEvaluationCycle(cid);
    } catch (err) {
      logger.error('Re-evaluation after settings change failed', { error: err.message }, cid);
    }
  }
});

// ─── Reactive Settings Helpers ────────────────────────────────────────────────

/**
 * T012: Dissolve special groups in all windows when tab sorting is disabled.
 */
async function _dissolveAllSpecialGroups(cid) {
  const state = await readState([STORAGE_KEYS.WINDOW_STATE]);
  const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
  let totalDissolved = 0;
  const windowIds = Object.keys(windowState).map(Number);

  for (const windowId of windowIds) {
    const { dissolved } = await dissolveSpecialGroups(windowId, windowState);
    totalDissolved += dissolved;
  }

  if (totalDissolved > 0) {
    await batchWrite({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
    logger.info('Dissolved special groups on tabSortingEnabled=false', {
      windowIds,
      windowCount: windowIds.length,
      totalDissolved,
    }, cid);
  } else {
    logger.debug('No special groups to dissolve', { windowIds }, cid);
  }
}

/**
 * T018: Update special group titles when group name settings change.
 */
async function _updateSpecialGroupNames(settings, cid) {
  const state = await readState([STORAGE_KEYS.WINDOW_STATE]);
  const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
  let updated = 0;

  for (const [windowId, ws] of Object.entries(windowState)) {
    for (const type of ['yellow', 'red']) {
      const groupId = ws.specialGroups?.[type];
      if (groupId === null || groupId === undefined) continue;
      const nameKey = type === 'yellow' ? 'yellowGroupName' : 'redGroupName';
      const newTitle = settings[nameKey] ?? '';
      try {
        await chrome.tabGroups.update(groupId, { title: newTitle });
        updated++;
        logger.debug('Updated special group name', { windowId, type, groupId, newTitle }, cid);
      } catch (err) {
        logger.warn('Failed to update special group name', { windowId, type, groupId, error: err.message }, cid);
      }
    }
  }

  if (updated > 0) {
    logger.info('Reactive group name update complete', { updated }, cid);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function scanExistingTabs(cid) {
  try {
    const tabs = await chrome.tabs.query({});
    const currentActiveTime = await getCurrentActiveTime();
    const now = Date.now();
    const tabMeta = {};

    for (const tab of tabs) {
      if (tab.pinned) continue;
      tabMeta[tab.id] = {
        tabId: tab.id,
        windowId: tab.windowId,
        refreshActiveTime: currentActiveTime,
        refreshWallTime: now,
        status: STATUS.GREEN,
        groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null,
        isSpecialGroup: false,
        pinned: false,
        url: tab.url || '',
      };
    }

    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    logger.info('Scanned existing tabs', { count: Object.keys(tabMeta).length }, cid);
  } catch (err) {
    logger.error('Failed to scan existing tabs', { error: err.message }, cid);
  }
}

async function reconcileState(cid) {
  // Mutex: if reconciliation is already in progress (e.g. both onInstalled
  // and onStartup fire on restart), wait for it instead of running twice.
  if (reconcilePromise) {
    logger.info('reconcileState already running, waiting for existing call', null, cid);
    await reconcilePromise;
    return;
  }
  reconcilePromise = reconcileStateImpl(cid);
  try {
    await reconcilePromise;
  } finally {
    reconcilePromise = null;
  }
}

async function reconcileStateImpl(cid) {
  try {
    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const storedTabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const storedWindowState = state[STORAGE_KEYS.WINDOW_STATE] || {};

    // Count stored entries with matchable URLs (exclude blank/newtab) — if
    // any exist we may need to wait for Chrome's session-restored tabs to
    // finish loading their URLs before URL-based matching will work.
    const isMatchableUrl = (u) => u && u !== '' && u !== 'about:blank' && u !== 'chrome://newtab/';
    const storedUrlCount = Object.values(storedTabMeta)
      .filter((m) => isMatchableUrl(m.url)).length;

    let chromeTabs, chromeWindows;
    if (storedUrlCount > 0) {
      // Poll until Chrome tabs have real URLs (session restore loads lazily)
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        [chromeTabs, chromeWindows] = await Promise.all([
          chrome.tabs.query({}),
          chrome.windows.getAll(),
        ]);
        const realUrlCount = chromeTabs.filter(
          (t) => !t.pinned && isMatchableUrl(t.url),
        ).length;
        if (realUrlCount >= storedUrlCount) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    } else {
      [chromeTabs, chromeWindows] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getAll(),
      ]);
    }

    const currentActiveTime = await getCurrentActiveTime();
    const now = Date.now();

    const chromeWindowIds = new Set(chromeWindows.map((w) => w.id));
    const reconciledMeta = {};
    const liveGroupIdsByWindow = new Map();

    // Build URL → old meta lookup for age preservation across restarts.
    // Chrome assigns new tab IDs on restart, so ID-based matching fails;
    // we fall back to URL matching to carry forward refresh timestamps.
    const urlToOldMetas = new Map();
    for (const meta of Object.values(storedTabMeta)) {
      if (meta.url && meta.url !== 'chrome://newtab/' && meta.url !== '') {
        const bucket = urlToOldMetas.get(meta.url) || [];
        bucket.push(meta);
        urlToOldMetas.set(meta.url, bucket);
      }
    }
    const consumedOldMetas = new Set();
    // Track old→new group ID mapping for remapping windowState references
    const oldToNewGroupVotes = new Map(); // oldGroupId → Map(newGroupId → count)
    let urlMatches = 0;

    for (const tab of chromeTabs) {
      if (tab.pinned) continue;
      const tabIdStr = String(tab.id);
      const liveGroupId = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null;
      if (liveGroupId !== null) {
        const bucket = liveGroupIdsByWindow.get(tab.windowId) || new Set();
        bucket.add(liveGroupId);
        liveGroupIdsByWindow.set(tab.windowId, bucket);
      }
      if (storedTabMeta[tabIdStr] || storedTabMeta[tab.id]) {
        const existing = storedTabMeta[tabIdStr] || storedTabMeta[tab.id];
        existing.windowId = tab.windowId;
        existing.groupId = liveGroupId;
        existing.pinned = tab.pinned;
        existing.url = tab.url || existing.url || '';
        reconciledMeta[tab.id] = existing;
        consumedOldMetas.add(existing);
      } else {
        // Tab not found by ID — try URL-based matching to preserve age
        let matched = null;
        if (tab.url && tab.url !== 'chrome://newtab/') {
          const candidates = urlToOldMetas.get(tab.url);
          if (candidates) {
            for (let i = 0; i < candidates.length; i++) {
              if (!consumedOldMetas.has(candidates[i])) {
                matched = candidates[i];
                consumedOldMetas.add(matched);
                candidates.splice(i, 1);
                urlMatches++;
                break;
              }
            }
          }
        }

        if (matched) {
          // Record old→new group mapping for windowState remapping
          if (matched.groupId !== null && liveGroupId !== null) {
            const votes = oldToNewGroupVotes.get(matched.groupId) || new Map();
            votes.set(liveGroupId, (votes.get(liveGroupId) || 0) + 1);
            oldToNewGroupVotes.set(matched.groupId, votes);
          }
          reconciledMeta[tab.id] = {
            tabId: tab.id,
            windowId: tab.windowId,
            refreshActiveTime: matched.refreshActiveTime,
            refreshWallTime: matched.refreshWallTime,
            status: matched.status,
            groupId: liveGroupId,
            isSpecialGroup: false,
            pinned: false,
            url: tab.url || '',
          };
        } else {
          reconciledMeta[tab.id] = {
            tabId: tab.id,
            windowId: tab.windowId,
            refreshActiveTime: currentActiveTime,
            refreshWallTime: now,
            status: STATUS.GREEN,
            groupId: liveGroupId,
            isSpecialGroup: false,
            pinned: false,
            url: tab.url || '',
          };
        }
      }
    }

    // Resolve old→new group ID mapping (pick the new group with most tab matches)
    const groupIdMap = new Map();
    for (const [oldGid, newGidCounts] of oldToNewGroupVotes) {
      let bestNewGid = null;
      let bestCount = 0;
      for (const [newGid, count] of newGidCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestNewGid = newGid;
        }
      }
      if (bestNewGid !== null) groupIdMap.set(oldGid, bestNewGid);
    }

    if (urlMatches > 0) {
      logger.info('URL-based tab matching preserved ages across restart', {
        urlMatches,
        groupMappings: groupIdMap.size,
      }, cid);
    }

    // Build old→new window ID mapping from tab metadata.
    // After a restart Chrome assigns new window IDs, so stored window state
    // entries reference stale IDs.  We use tab windowId to recover the mapping.
    const windowIdMap = new Map();
    for (const meta of Object.values(reconciledMeta)) {
      const storedWid = Object.values(storedTabMeta).find(
        (m) => m.url && m.url === meta.url && m.url !== 'about:blank',
      )?.windowId;
      if (storedWid !== undefined && storedWid !== meta.windowId) {
        const votes = windowIdMap.get(storedWid) || new Map();
        votes.set(meta.windowId, (votes.get(meta.windowId) || 0) + 1);
        windowIdMap.set(storedWid, votes);
      }
    }
    // Resolve to best mapping
    const resolvedWindowMap = new Map();
    for (const [oldWid, newWidCounts] of windowIdMap) {
      let bestNewWid = null;
      let bestCount = 0;
      for (const [newWid, count] of newWidCounts) {
        if (count > bestCount) { bestCount = count; bestNewWid = newWid; }
      }
      if (bestNewWid !== null) resolvedWindowMap.set(oldWid, bestNewWid);
    }

    const reconciledWindowState = {};
    // Keep existing window state for windows still open (or mapped to new ID)
    for (const [wid, ws] of Object.entries(storedWindowState)) {
      const numWid = Number(wid);
      const resolvedWid = chromeWindowIds.has(numWid)
        ? numWid
        : (resolvedWindowMap.get(numWid) ?? null);
      if (resolvedWid !== null && chromeWindowIds.has(resolvedWid)) {
        const liveGroupIds = liveGroupIdsByWindow.get(resolvedWid) || new Set();
        const currentState = ws && typeof ws === 'object' ? ws : {};
        const storedSpecialGroups = currentState.specialGroups && typeof currentState.specialGroups === 'object'
          ? currentState.specialGroups
          : { yellow: null, red: null };
        const groupZones = currentState.groupZones && typeof currentState.groupZones === 'object'
          ? currentState.groupZones
          : {};
        const groupNamingSource = currentState.groupNaming && typeof currentState.groupNaming === 'object'
          ? currentState.groupNaming
          : {};

        // Remap special group IDs using the old→new mapping.
        // After a restart Chrome assigns new group IDs, so the stored
        // references become stale; the groupIdMap lets us recover them.
        const specialGroups = { yellow: null, red: null };
        for (const type of ['yellow', 'red']) {
          const oldId = storedSpecialGroups[type];
          if (oldId === null) continue;
          const newId = groupIdMap.get(oldId);
          if (newId !== undefined && liveGroupIds.has(newId)) {
            specialGroups[type] = newId;
          } else if (liveGroupIds.has(oldId)) {
            specialGroups[type] = oldId; // ID didn't change
          }
          // else: group no longer exists → stays null
        }

        // Remap groupNaming entries: try the stored ID first, then
        // fall back to the old→new mapping so naming metadata survives restarts.
        const groupNaming = {};
        for (const [groupId, metadata] of Object.entries(groupNamingSource)) {
          const numId = Number(groupId);
          const resolvedId = liveGroupIds.has(numId) ? numId : (groupIdMap.get(numId) ?? null);
          if (resolvedId !== null && liveGroupIds.has(resolvedId)) {
            const now = Date.now();
            const firstUnnamedSeenAt = Number.isFinite(metadata?.firstUnnamedSeenAt) && metadata.firstUnnamedSeenAt > 0
              ? metadata.firstUnnamedSeenAt
              : now;
            const lastAutoNamedAt = Number.isFinite(metadata?.lastAutoNamedAt) && metadata.lastAutoNamedAt > 0
              ? metadata.lastAutoNamedAt
              : null;
            const lastCandidate = typeof metadata?.lastCandidate === 'string' && metadata.lastCandidate.trim()
              ? metadata.lastCandidate.trim().split(/\s+/).slice(0, 2).join(' ')
              : null;
            const userEditLockUntil = Number.isFinite(metadata?.userEditLockUntil) && metadata.userEditLockUntil > 0
              ? metadata.userEditLockUntil
              : now;
            groupNaming[resolvedId] = {
              firstUnnamedSeenAt,
              lastAutoNamedAt,
              lastCandidate,
              userEditLockUntil,
            };
          }
        }

        reconciledWindowState[resolvedWid] = {
          specialGroups,
          groupZones,
          groupNaming,
        };
      }
    }
    // Create default state for windows that have tabs but no stored state
    for (const wid of chromeWindowIds) {
      if (!reconciledWindowState[wid] && !reconciledWindowState[String(wid)]) {
        reconciledWindowState[wid] = {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {},
        };
      }
    }

    await batchWrite({
      [STORAGE_KEYS.TAB_META]: reconciledMeta,
      [STORAGE_KEYS.WINDOW_STATE]: reconciledWindowState,
    });

    logger.info('State reconciled', {
      tabsInChrome: chromeTabs.length,
      tabsReconciled: Object.keys(reconciledMeta).length,
      urlMatches,
      windowsReconciled: Object.keys(reconciledWindowState).length,
      chromeWindowCount: chromeWindows.length,
      chromeWindowTypes: chromeWindows.map((w) => ({ id: w.id, type: w.type })),
      storedWindowCount: Object.keys(storedWindowState).length,
    }, cid);
  } catch (err) {
    logger.error('State reconciliation failed', { error: err.message, errorCode: ERROR_CODES.ERR_RECOVERY }, cid);
  }
}
