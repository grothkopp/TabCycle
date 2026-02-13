import { STORAGE_KEYS, ALARM_NAME, ALARM_PERIOD_MINUTES, DEFAULT_THRESHOLDS, DEFAULT_BOOKMARK_SETTINGS, DEFAULT_SHOW_GROUP_AGE, TIME_MODE, STATUS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { readState, batchWrite } from './state-persistence.js';
import { createTabEntry, handleNavigation, reconcileTabs } from './tab-tracker.js';
import { evaluateAllTabs } from './status-evaluator.js';
import {
  isSpecialGroup,
  getSpecialGroupType,
  removeSpecialGroupIfEmpty,
  ungroupTab,
  computeGroupStatus,
  updateGroupColor,
  sortTabsAndGroups,
  closeGoneGroups,
  dissolveUnnamedSingleTabGroups,
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

// Guard: suppress reactive event handlers while the evaluation cycle owns state
let evaluationCycleRunning = false;
let evaluationCycleStartedAt = 0;
const EVALUATION_CYCLE_TIMEOUT_MS = 60_000; // auto-reset guard after 60s

// Guard: suppress onUpdated groupId handler while placeNewTab is running
let tabPlacementRunning = false;

// ─── Installation ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  const cid = logger.correlationId();
  logger.info('Extension installed/updated', { reason: details.reason }, cid);

  try {
    if (details.reason === 'install') {
      const defaultSettings = {
        timeMode: TIME_MODE.ACTIVE,
        thresholds: {
          greenToYellow: DEFAULT_THRESHOLDS.GREEN_TO_YELLOW,
          yellowToRed: DEFAULT_THRESHOLDS.YELLOW_TO_RED,
          redToGone: DEFAULT_THRESHOLDS.RED_TO_GONE,
        },
        bookmarkEnabled: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED,
        bookmarkFolderName: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME,
      };

      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: defaultSettings,
        [STORAGE_KEYS.TAB_META]: {},
        [STORAGE_KEYS.WINDOW_STATE]: {},
        [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: null },
      });

      await initActiveTime();
      logger.info('Storage initialized with defaults', null, cid);
    }

    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
    logger.info('Alarm created', { name: ALARM_NAME, periodMinutes: ALARM_PERIOD_MINUTES }, cid);

    if (details.reason === 'install') {
      await scanExistingTabs(cid);
    } else {
      await reconcileState(cid);
    }

    await runEvaluationCycle(cid);
  } catch (err) {
    logger.error('onInstalled handler failed', { error: err.message, errorCode: ERROR_CODES.ERR_ALARM_CREATE }, cid);
  }
});

// ─── Browser Startup ─────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
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
    }
    if (groupIdFixes > 0) {
      logger.info('Reconciled stale groupIds in tabMeta', { fixes: groupIdFixes }, cid);
    }
  } catch (err) {
    logger.warn('Failed to reconcile groupIds', { error: err.message }, cid);
  }

  const transitions = evaluateAllTabs(tabMeta, currentActiveTime, settings);
  const transitionCount = Object.keys(transitions).length;

  // Separate gone tabs from other transitions
  const goneTabIds = [];
  for (const [tabId, t] of Object.entries(transitions)) {
    if (t.newStatus === STATUS.GONE) {
      goneTabIds.push(Number(tabId));
    } else {
      tabMeta[tabId].status = t.newStatus;
    }
  }

  // Resolve bookmark folder once if bookmarking is enabled and there are gone tabs
  const bookmarkEnabled = settings.bookmarkEnabled !== undefined
    ? settings.bookmarkEnabled
    : DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED;
  let bookmarkFolderId = null;

  if (bookmarkEnabled && goneTabIds.length > 0) {
    bookmarkFolderId = await resolveBookmarkFolder(settings);
    logger.debug('Bookmark folder resolved', { bookmarkFolderId, bookmarkEnabled }, cid);
  }

  // ── Identify gone groups BEFORE removing any tabs ──────────────────
  // We must do this now while the tabs and groups still exist in Chrome,
  // so that chrome.tabGroups.get() and chrome.tabs.query() can retrieve
  // group info and tab URLs for bookmarking.
  const goneGroupIds = [];          // group IDs whose every tab is gone
  const goneGroupTabIds = new Set(); // tab IDs that belong to a gone group

  // Collect all user-group IDs that have at least one gone tab
  const candidateGroupIds = new Set();
  for (const tabId of goneTabIds) {
    const meta = tabMeta[tabId] || tabMeta[String(tabId)];
    if (meta && meta.groupId !== null && !meta.isSpecialGroup) {
      candidateGroupIds.add(meta.groupId);
    }
  }

  // A group is "gone" when ALL its non-pinned tabs are gone
  for (const gid of candidateGroupIds) {
    const allTabsInGroup = Object.values(tabMeta).filter(
      (m) => m.groupId === gid && !m.pinned && !m.isSpecialGroup
    );
    const allGone = allTabsInGroup.length > 0 && allTabsInGroup.every(
      (m) => goneTabIds.includes(m.tabId)
    );
    if (allGone) {
      goneGroupIds.push(gid);
      for (const m of allTabsInGroup) goneGroupTabIds.add(m.tabId);
    }
  }

  // Capture window ID for each gone group while tabMeta still has the tabs
  const goneGroupWindowMap = new Map(); // groupId → windowId
  for (const gid of goneGroupIds) {
    const sample = Object.values(tabMeta).find(
      (m) => m.groupId === gid && !m.pinned && !m.isSpecialGroup
    );
    if (sample) goneGroupWindowMap.set(gid, sample.windowId);
  }

  logger.debug('Gone analysis', {
    goneTabCount: goneTabIds.length,
    goneGroupCount: goneGroupIds.length,
    goneGroupTabCount: goneGroupTabIds.size,
    goneGroupIds,
  }, cid);

  // ── Bookmark gone GROUPS first (tabs still exist in Chrome) ────────
  const bookmarkedGroupIds = new Set(); // dedup guard
  if (bookmarkEnabled && bookmarkFolderId && goneGroupIds.length > 0) {
    for (const gid of goneGroupIds) {
      if (bookmarkedGroupIds.has(gid)) {
        logger.warn('Skipping duplicate group bookmark', { groupId: gid }, cid);
        continue;
      }
      try {
        const groupInfo = await chrome.tabGroups.get(gid);
        const groupTabs = await chrome.tabs.query({ groupId: gid });
        logger.debug('Bookmarking gone group', {
          groupId: gid,
          groupTitle: groupInfo.title || '(unnamed)',
          tabCount: groupTabs.length,
          tabUrls: groupTabs.map((t) => t.url),
        }, cid);
        const result = await bookmarkGroupTabs(groupInfo.title, groupTabs, bookmarkFolderId);
        bookmarkedGroupIds.add(gid);
        logger.info('Bookmarked gone group', {
          groupId: gid,
          groupTitle: groupInfo.title || '(unnamed)',
          tabsCreated: result.created,
          tabsSkipped: result.skipped,
          tabsFailed: result.failed,
        }, cid);
      } catch (err) {
        logger.warn('Failed to bookmark gone group', {
          groupId: gid,
          error: err.message,
          errorCode: ERROR_CODES.ERR_BOOKMARK_FOLDER,
        }, cid);
      }
    }
  }

  // ── Bookmark individual gone tabs (not part of a gone group) ───────
  let bookmarksCreated = 0;
  let bookmarksSkipped = 0;

  for (const tabId of goneTabIds) {
    // Skip tabs already bookmarked as part of a gone group
    if (goneGroupTabIds.has(tabId)) continue;

    if (bookmarkEnabled && bookmarkFolderId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (isBookmarkableUrl(tab.url)) {
          await bookmarkTab(tab, bookmarkFolderId);
          bookmarksCreated++;
          logger.debug('Bookmarked individual gone tab', { tabId, url: tab.url }, cid);
        } else {
          bookmarksSkipped++;
          logger.debug('Skipped bookmarking tab with blocklisted URL', { tabId, url: tab.url }, cid);
        }
      } catch (err) {
        logger.warn('Failed to bookmark gone tab', { tabId, error: err.message, errorCode: ERROR_CODES.ERR_BOOKMARK_CREATE }, cid);
      }
    }
  }

  // ── Remove all gone tabs and close gone groups ─────────────────────
  for (const tabId of goneTabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (err) {
      logger.warn('Failed to remove gone tab', { tabId, error: err.message, errorCode: ERROR_CODES.ERR_TAB_REMOVE }, cid);
    }
    delete tabMeta[tabId];
  }

  // Close gone groups and clean up groupZones
  const allWindows = new Set(Object.values(tabMeta).map((m) => m.windowId));
  // Ensure windows with gone groups are included (their tabs are already deleted from tabMeta)
  for (const wid of goneGroupWindowMap.values()) allWindows.add(wid);

  for (const wid of allWindows) {
    // Gone groups for this window (identified before tab removal)
    const windowGoneGroupIds = goneGroupIds.filter(
      (gid) => goneGroupWindowMap.get(gid) === Number(wid)
    );

    // Also find groups that lost all tabs for other reasons (e.g. manual removal)
    const remainingGroupIds = new Set();
    for (const m of Object.values(tabMeta)) {
      if (m.windowId === Number(wid) && m.groupId !== null && !m.isSpecialGroup) {
        remainingGroupIds.add(m.groupId);
      }
    }
    const emptyGroupIds = [];
    for (const gid of remainingGroupIds) {
      const status = computeGroupStatus(gid, tabMeta);
      if (status === null) emptyGroupIds.push(gid);
    }

    const allGoneGroupIds = [...new Set([...windowGoneGroupIds, ...emptyGroupIds])];

    if (allGoneGroupIds.length > 0) {
      const closedIds = await closeGoneGroups(wid, allGoneGroupIds, tabMeta, windowState);
      for (const id of closedIds) {
        delete tabMeta[id];
        delete tabMeta[String(id)];
      }
    }

    // Dissolve unnamed single-tab groups
    await dissolveUnnamedSingleTabGroups(wid, tabMeta, windowState);

    // Unified sort: reads browser state, moves ungrouped tabs to special
    // groups as needed, then sorts all groups into zone order
    await sortTabsAndGroups(wid, tabMeta, windowState);

    // Update group titles with age if enabled
    const showGroupAge = settings.showGroupAge !== undefined
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
      goneClosed: goneTabIds.length,
      bookmarksCreated,
      bookmarksSkipped,
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

    // Track the new tab in meta
    const currentActiveTime = await getCurrentActiveTime();
    const entry = createTabEntry(tab, currentActiveTime);
    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    tabMeta[tab.id] = entry;

    // Context-aware placement for non-command-created tabs (e.g., middle-click, link open)
    // Guard covers both placement and persist so onUpdated events triggered by
    // chrome.tabs.group() inside placeNewTab cannot race with our batchWrite.
    tabPlacementRunning = true;
    try {
      await placeNewTab(tab, tab.windowId, tabMeta, windowState);
      // Persist all meta changes (includes group updates from placeNewTab)
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    } finally {
      tabPlacementRunning = false;
    }
    logger.debug('Tab created', { tabId: tab.id, windowId: tab.windowId }, cid);
  } catch (err) {
    logger.error('onCreated handler failed', { tabId: tab.id, error: err.message }, cid);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (evaluationCycleRunning) return;
  const cid = logger.correlationId();
  try {
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
  } catch (err) {
    logger.error('onRemoved handler failed', { tabId, error: err.message }, cid);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const cid = logger.correlationId();

  // T041: Handle user manually moving tab to a different group
  // Skip if the evaluation cycle is running — it owns state and will persist it.
  if (changeInfo.groupId !== undefined && !evaluationCycleRunning && !tabPlacementRunning) {
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
  if (evaluationCycleRunning) return;
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
  } catch (err) {
    logger.warn('onMoved dissolution check failed', { tabId, error: err.message }, cid);
  }
});

// ─── Navigation ──────────────────────────────────────────────────────────────

// Per-tab debounce: avoid double-processing when both onCommitted and
// onHistoryStateUpdated fire for the same tab within a short window.
const NAV_DEBOUNCE_MS = 1000;
const _lastNavHandled = new Map();

async function _handleNavigationEvent(tabId, source) {
  const now = Date.now();
  const last = _lastNavHandled.get(tabId) || 0;
  if (now - last < NAV_DEBOUNCE_MS) {
    logger.debug('Navigation debounced', { tabId, source, sinceLast: now - last });
    return;
  }
  _lastNavHandled.set(tabId, now);

  const cid = logger.correlationId();
  try {
    // Skip navigations caused by Chrome restoring a suspended/discarded tab.
    // The tab was not actively navigated by the user — its age should not reset.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded || tab.status === 'unloaded') {
        logger.debug('Ignoring navigation for discarded/suspended tab', { tabId, source }, cid);
        return;
      }
    } catch { /* tab gone — will be caught below */ }

    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const existing = tabMeta[tabId] || tabMeta[String(tabId)];
    if (!existing) {
      logger.debug('Navigation for untracked tab, skipping', { tabId, source }, cid);
      return;
    }
    const currentActiveTime = await getCurrentActiveTime();
    const updated = handleNavigation(existing, currentActiveTime);
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
    // Double-check against windowState to never touch special group colors.
    const groupId = updated.groupId;
    if (groupId !== null && !updated.isSpecialGroup
        && !isSpecialGroup(groupId, existing.windowId, windowState)) {
      const groupStatus = computeGroupStatus(groupId, tabMeta);
      if (groupStatus) {
        await updateGroupColor(groupId, groupStatus);
      }
    }
    await sortTabsAndGroups(existing.windowId, tabMeta, windowState);

    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: windowState });
    logger.debug('Navigation handled, refresh time reset', { tabId, source }, cid);
  } catch (err) {
    logger.error('Navigation handler failed', { tabId, source, error: err.message }, cid);
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
    if (ws && ws.specialGroups) {
      let changed = false;
      if (ws.specialGroups.yellow === group.id) {
        ws.specialGroups.yellow = null;
        changed = true;
      }
      if (ws.specialGroups.red === group.id) {
        ws.specialGroups.red = null;
        changed = true;
      }
      if (changed) {
        await batchWrite({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
        logger.info('Special group removed externally', { groupId: group.id, windowId: group.windowId }, cid);
      }
    }
    logger.debug('Tab group removed', { groupId: group.id, windowId: group.windowId }, cid);
  } catch (err) {
    logger.error('onGroupRemoved handler failed', { groupId: group.id, error: err.message }, cid);
  }
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.WINDOW_STATE]);
    const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    // If this is a special group, ignore user modifications to title/color
    // (TabCycle will re-apply on next evaluation cycle)
    if (isSpecialGroup(group.id, group.windowId, windowState)) {
      logger.debug('Special group updated, will re-apply on next cycle', { groupId: group.id }, cid);
      return;
    }
    // For user groups: we never overwrite the user's title (FR-023)
    // Color will be re-applied to match status on next evaluation cycle
    logger.debug('Tab group updated by user', { groupId: group.id, title: group.title, color: group.color }, cid);
  } catch (err) {
    logger.error('onGroupUpdated handler failed', { groupId: group.id, error: err.message }, cid);
  }
});

// ─── Storage Changes ─────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;

  const cid = logger.correlationId();
  if (changes[STORAGE_KEYS.SETTINGS]) {
    logger.info('Settings changed, triggering re-evaluation', null, cid);
    try {
      await runEvaluationCycle(cid);
    } catch (err) {
      logger.error('Re-evaluation after settings change failed', { error: err.message }, cid);
    }
  }
});

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
      };
    }

    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    logger.info('Scanned existing tabs', { count: Object.keys(tabMeta).length }, cid);
  } catch (err) {
    logger.error('Failed to scan existing tabs', { error: err.message }, cid);
  }
}

async function reconcileState(cid) {
  try {
    const [chromeTabs, chromeWindows] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll(),
    ]);

    const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
    const storedTabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const storedWindowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
    const currentActiveTime = await getCurrentActiveTime();
    const now = Date.now();

    const chromeTabIds = new Set(chromeTabs.map((t) => t.id));
    const chromeWindowIds = new Set(chromeWindows.map((w) => w.id));
    const reconciledMeta = {};

    for (const tab of chromeTabs) {
      if (tab.pinned) continue;
      const tabIdStr = String(tab.id);
      if (storedTabMeta[tabIdStr] || storedTabMeta[tab.id]) {
        const existing = storedTabMeta[tabIdStr] || storedTabMeta[tab.id];
        existing.windowId = tab.windowId;
        existing.groupId = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null;
        existing.pinned = tab.pinned;
        reconciledMeta[tab.id] = existing;
      } else {
        reconciledMeta[tab.id] = {
          tabId: tab.id,
          windowId: tab.windowId,
          refreshActiveTime: currentActiveTime,
          refreshWallTime: now,
          status: STATUS.GREEN,
          groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null,
          isSpecialGroup: false,
          pinned: false,
        };
      }
    }

    const reconciledWindowState = {};
    // Keep existing window state for windows still open
    for (const [wid, ws] of Object.entries(storedWindowState)) {
      if (chromeWindowIds.has(Number(wid))) {
        reconciledWindowState[wid] = ws;
      }
    }
    // Create default state for windows that have tabs but no stored state
    for (const wid of chromeWindowIds) {
      if (!reconciledWindowState[wid] && !reconciledWindowState[String(wid)]) {
        reconciledWindowState[wid] = {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
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
      windowsReconciled: Object.keys(reconciledWindowState).length,
      chromeWindowCount: chromeWindows.length,
      chromeWindowTypes: chromeWindows.map((w) => ({ id: w.id, type: w.type })),
      storedWindowCount: Object.keys(storedWindowState).length,
    }, cid);
  } catch (err) {
    logger.error('State reconciliation failed', { error: err.message, errorCode: ERROR_CODES.ERR_RECOVERY }, cid);
  }
}
