import { STORAGE_KEYS, ALARM_NAME, ALARM_PERIOD_MINUTES, DEFAULT_THRESHOLDS, DEFAULT_BOOKMARK_SETTINGS, TIME_MODE, STATUS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { readState, batchWrite } from './state-persistence.js';
import { createTabEntry, handleNavigation, reconcileTabs } from './tab-tracker.js';
import { evaluateAllTabs } from './status-evaluator.js';
import {
  isSpecialGroup,
  getSpecialGroupType,
  moveTabToSpecialGroup,
  removeSpecialGroupIfEmpty,
  ungroupTab,
  computeGroupStatus,
  updateGroupColor,
  sortGroupsIntoZones,
  closeGoneGroups,
  dissolveUnnamedSingleTabGroups,
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

    await scanExistingTabs(cid);
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
  } catch (err) {
    logger.error('onStartup handler failed', { error: err.message, errorCode: ERROR_CODES.ERR_RECOVERY }, cid);
  }
});

// ─── Alarm (Evaluation Cycle) ────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const cid = logger.correlationId();
  try {
    await runEvaluationCycle(cid);
  } catch (err) {
    logger.error('Evaluation cycle failed', { error: err.message }, cid);
  }
});

async function runEvaluationCycle(cid) {
  await persistActiveTime();

  const state = await readState([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TAB_META,
    STORAGE_KEYS.WINDOW_STATE,
  ]);

  const settings = state[STORAGE_KEYS.SETTINGS];
  const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
  const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
  const currentActiveTime = await getCurrentActiveTime();

  const transitions = evaluateAllTabs(tabMeta, currentActiveTime, settings);
  const transitionCount = Object.keys(transitions).length;

  // Close tabs that reached GONE
  const goneTabIds = [];
  for (const [tabId, t] of Object.entries(transitions)) {
    if (t.newStatus === STATUS.GONE) {
      goneTabIds.push(Number(tabId));
    } else {
      tabMeta[tabId].status = t.newStatus;
    }
  }

  // Bookmark individual gone tabs before removal (FR-001, FR-004, FR-012, FR-017)
  const bookmarkEnabled = settings.bookmarkEnabled !== undefined
    ? settings.bookmarkEnabled
    : DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED;
  let bookmarkFolderId = null;

  if (bookmarkEnabled && goneTabIds.length > 0) {
    bookmarkFolderId = await resolveBookmarkFolder(settings);
  }

  let bookmarksCreated = 0;
  let bookmarksSkipped = 0;

  for (const tabId of goneTabIds) {
    // Bookmark before removal — tab info must be captured first
    if (bookmarkEnabled && bookmarkFolderId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (isBookmarkableUrl(tab.url)) {
          await bookmarkTab(tab, bookmarkFolderId);
          bookmarksCreated++;
        } else {
          bookmarksSkipped++;
          logger.debug('Skipped bookmarking tab with blocklisted URL', { tabId, url: tab.url }, cid);
        }
      } catch (err) {
        logger.warn('Failed to bookmark gone tab', { tabId, error: err.message, errorCode: ERROR_CODES.ERR_BOOKMARK_CREATE }, cid);
      }
    }

    try {
      await chrome.tabs.remove(tabId);
    } catch (err) {
      logger.warn('Failed to remove gone tab', { tabId, error: err.message, errorCode: ERROR_CODES.ERR_TAB_REMOVE }, cid);
    }
    delete tabMeta[tabId];
  }

  // Move ungrouped tabs transitioning to yellow/red into special groups
  const windowsAffected = new Set();
  for (const [tabId, t] of Object.entries(transitions)) {
    if (t.newStatus === STATUS.GONE) continue; // already handled above
    const meta = tabMeta[tabId];
    if (!meta) continue;

    windowsAffected.add(meta.windowId);

    if (t.newStatus === STATUS.YELLOW && !meta.isSpecialGroup && meta.groupId === null) {
      const result = await moveTabToSpecialGroup(Number(tabId), 'yellow', meta.windowId, windowState);
      if (result.success) {
        meta.groupId = result.groupId;
        meta.isSpecialGroup = true;
      }
    } else if (t.newStatus === STATUS.RED && meta.isSpecialGroup && getSpecialGroupType(meta.groupId, meta.windowId, windowState) === 'yellow') {
      const result = await moveTabToSpecialGroup(Number(tabId), 'red', meta.windowId, windowState);
      if (result.success) {
        meta.groupId = result.groupId;
        meta.isSpecialGroup = true;
      }
    }
  }

  // Clean up empty special groups
  for (const wid of windowsAffected) {
    await removeSpecialGroupIfEmpty(wid, 'yellow', windowState);
    await removeSpecialGroupIfEmpty(wid, 'red', windowState);
  }

  // Identify user-created groups that reached GONE status and close them
  const allWindows = new Set(Object.values(tabMeta).map((m) => m.windowId));
  for (const wid of windowsAffected) allWindows.add(wid);

  for (const wid of allWindows) {
    // Find gone groups: user groups where ALL tabs are gone
    const groupIds = new Set();
    for (const m of Object.values(tabMeta)) {
      if (m.windowId === Number(wid) && m.groupId !== null && !m.isSpecialGroup) {
        groupIds.add(m.groupId);
      }
    }
    const goneGroupIds = [];
    for (const gid of groupIds) {
      const status = computeGroupStatus(gid, tabMeta);
      if (status === null) goneGroupIds.push(gid); // no non-pinned tabs left
    }
    if (goneGroupIds.length > 0) {
      // Bookmark gone groups before closing them (FR-002, FR-003, FR-012)
      if (bookmarkEnabled && bookmarkFolderId) {
        for (const gid of goneGroupIds) {
          try {
            const groupInfo = await chrome.tabGroups.get(gid);
            const groupTabs = await chrome.tabs.query({ groupId: gid });
            const result = await bookmarkGroupTabs(groupInfo.title, groupTabs, bookmarkFolderId);
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

      const closedIds = await closeGoneGroups(wid, goneGroupIds, tabMeta, windowState);
      for (const id of closedIds) {
        delete tabMeta[id];
        delete tabMeta[String(id)];
      }
    }

    // Dissolve unnamed single-tab groups
    await dissolveUnnamedSingleTabGroups(wid, tabMeta, windowState);

    // Sort groups into zones and update colors
    await sortGroupsIntoZones(wid, tabMeta, windowState);
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
    await placeNewTab(tab, tab.windowId, tabMeta, windowState);

    // Persist all meta changes (includes group updates from placeNewTab)
    await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    logger.debug('Tab created', { tabId: tab.id, windowId: tab.windowId }, cid);
  } catch (err) {
    logger.error('onCreated handler failed', { tabId: tab.id, error: err.message }, cid);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
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

  // DIAGNOSTIC: Log every onUpdated event with its changeInfo keys
  logger.info('DIAG onUpdated fired', {
    tabId,
    changeInfoKeys: Object.keys(changeInfo),
    groupId: changeInfo.groupId,
    windowId: tab.windowId,
  }, cid);

  // T041: Handle user manually moving tab to a different group
  if (changeInfo.groupId !== undefined) {
    try {
      // DIAGNOSTIC: Enumerate all groups and their tab counts
      try {
        const allGroups = await chrome.tabGroups.query({ windowId: tab.windowId });
        for (const g of allGroups) {
          const groupTabs = await chrome.tabs.query({ groupId: g.id });
          logger.info('DIAG group snapshot', {
            groupId: g.id,
            title: g.title,
            color: g.color,
            tabCount: groupTabs.length,
            tabIds: groupTabs.map(t => t.id),
            isTracked: (await import('./group-manager.js')).isExtensionCreatedGroup(g.id),
          }, cid);
        }
      } catch (diagErr) {
        logger.warn('DIAG group enumeration failed', { error: diagErr.message }, cid);
      }

      const state = await readState([STORAGE_KEYS.TAB_META, STORAGE_KEYS.WINDOW_STATE]);
      const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
      const windowState = state[STORAGE_KEYS.WINDOW_STATE] || {};
      const meta = tabMeta[tabId] || tabMeta[String(tabId)];
      if (meta) {
        const newGroupId = changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? changeInfo.groupId : null;
        meta.groupId = newGroupId;
        meta.isSpecialGroup = newGroupId !== null && isSpecialGroup(newGroupId, tab.windowId, windowState);
        logger.info('DIAG tab group changed', { tabId, newGroupId, hasMeta: true }, cid);
      } else {
        logger.info('DIAG tab group changed but no meta', { tabId, changeGroupId: changeInfo.groupId }, cid);
      }
      // Dissolve any extension-created unnamed groups now left with a single tab
      const result = await dissolveUnnamedSingleTabGroups(tab.windowId, tabMeta, windowState);
      logger.info('DIAG dissolution result', { dissolved: result.dissolved, windowId: tab.windowId }, cid);
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

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const cid = logger.correlationId();
  try {
    const state = await readState([STORAGE_KEYS.TAB_META]);
    const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
    const existing = tabMeta[details.tabId] || tabMeta[String(details.tabId)];
    if (!existing) {
      logger.debug('Navigation for untracked tab, skipping', { tabId: details.tabId }, cid);
      return;
    }
    const currentActiveTime = await getCurrentActiveTime();
    const updated = handleNavigation(existing, currentActiveTime);
    tabMeta[details.tabId] = updated;
    // If tab was in a special group, ungroup it (navigating resets to green)
    if (existing.isSpecialGroup && existing.groupId !== null) {
      await ungroupTab(details.tabId);
      updated.groupId = null;
      updated.isSpecialGroup = false;
      tabMeta[details.tabId] = updated;

      // Clean up empty special group
      const wsState = await readState([STORAGE_KEYS.WINDOW_STATE]);
      const wState = wsState[STORAGE_KEYS.WINDOW_STATE] || {};
      const groupType = getSpecialGroupType(existing.groupId, existing.windowId, wState);
      if (groupType) {
        await removeSpecialGroupIfEmpty(existing.windowId, groupType, wState);
        await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta, [STORAGE_KEYS.WINDOW_STATE]: wState });
      } else {
        await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
      }
    } else {
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
    }
    logger.debug('Navigation committed, refresh time reset', { tabId: details.tabId }, cid);
  } catch (err) {
    logger.error('onCommitted handler failed', { tabId: details.tabId, error: err.message }, cid);
  }
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
    for (const [wid, ws] of Object.entries(storedWindowState)) {
      if (chromeWindowIds.has(Number(wid))) {
        reconciledWindowState[wid] = ws;
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
    }, cid);
  } catch (err) {
    logger.error('State reconciliation failed', { error: err.message, errorCode: ERROR_CODES.ERR_RECOVERY }, cid);
  }
}
