import { SPECIAL_GROUP_TYPES, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('background');

// Track groups created by our extension (eligible for auto-dissolution)
const extensionCreatedGroups = new Set();

export function trackExtensionGroup(groupId) {
  extensionCreatedGroups.add(groupId);
  logger.debug('Tracking extension-created group', { groupId });
}

export function untrackExtensionGroup(groupId) {
  extensionCreatedGroups.delete(groupId);
}

export function isExtensionCreatedGroup(groupId) {
  return extensionCreatedGroups.has(groupId);
}

// Pending dissolutions: groups that need dissolving but couldn't because of a drag lock
const pendingDissolutions = new Map(); // groupId → { tabId, windowId, tabMeta, startTime }
let dissolutionInterval = null;

async function processPendingDissolutions() {
  if (pendingDissolutions.size === 0) {
    clearInterval(dissolutionInterval);
    dissolutionInterval = null;
    return;
  }

  for (const [groupId, info] of pendingDissolutions) {
    // Give up after 10 seconds
    if (Date.now() - info.startTime > 10000) {
      logger.warn('Giving up on pending dissolution after timeout', { groupId, tabId: info.tabId });
      pendingDissolutions.delete(groupId);
      continue;
    }

    try {
      await chrome.tabs.ungroup(info.tabId);
      // Success — update meta from fresh state
      const { readState, batchWrite } = await import('./state-persistence.js');
      const { STORAGE_KEYS } = await import('../shared/constants.js');
      const state = await readState([STORAGE_KEYS.TAB_META]);
      const tabMeta = state[STORAGE_KEYS.TAB_META] || {};
      const meta = tabMeta[info.tabId] || tabMeta[String(info.tabId)];
      if (meta) {
        meta.groupId = null;
        meta.isSpecialGroup = false;
      }
      await batchWrite({ [STORAGE_KEYS.TAB_META]: tabMeta });
      extensionCreatedGroups.delete(groupId);
      pendingDissolutions.delete(groupId);
      logger.debug('Dissolved pending single-tab group after drag', {
        groupId, tabId: info.tabId, windowId: info.windowId,
      });
    } catch (err) {
      if (err.message && err.message.includes('cannot be edited')) {
        // Still dragging — will retry on next interval tick
      } else {
        // Different error — give up on this one
        logger.warn('Failed pending dissolution with unexpected error', {
          groupId, tabId: info.tabId, error: err.message,
        });
        pendingDissolutions.delete(groupId);
      }
    }
  }

  if (pendingDissolutions.size === 0) {
    clearInterval(dissolutionInterval);
    dissolutionInterval = null;
  }
}

function scheduleDissolution(groupId, tabId, windowId) {
  pendingDissolutions.set(groupId, { tabId, windowId, startTime: Date.now() });
  if (!dissolutionInterval) {
    dissolutionInterval = setInterval(processPendingDissolutions, 300);
  }
}

const GROUP_CONFIG = {
  [SPECIAL_GROUP_TYPES.YELLOW]: { title: 'Yellow', color: 'yellow' },
  [SPECIAL_GROUP_TYPES.RED]: { title: 'Red', color: 'red' },
};

export function isSpecialGroup(groupId, windowId, windowState) {
  if (groupId === null || groupId === undefined) return false;
  const ws = windowState[windowId] || windowState[String(windowId)];
  if (!ws || !ws.specialGroups) return false;
  return ws.specialGroups.yellow === groupId || ws.specialGroups.red === groupId;
}

export function getSpecialGroupType(groupId, windowId, windowState) {
  const ws = windowState[windowId] || windowState[String(windowId)];
  if (!ws || !ws.specialGroups) return null;
  if (ws.specialGroups.yellow === groupId) return SPECIAL_GROUP_TYPES.YELLOW;
  if (ws.specialGroups.red === groupId) return SPECIAL_GROUP_TYPES.RED;
  return null;
}

function ensureWindowState(windowId, windowState) {
  const key = windowId;
  if (!windowState[key]) {
    windowState[key] = {
      specialGroups: { yellow: null, red: null },
      groupZones: {},
    };
  }
  return windowState[key];
}

export async function ensureSpecialGroup(windowId, type, windowState, tabIdForCreation) {
  const ws = ensureWindowState(windowId, windowState);
  const existingGroupId = ws.specialGroups[type];

  if (existingGroupId !== null) {
    try {
      const tabs = await chrome.tabs.query({ groupId: existingGroupId });
      if (tabs.length > 0) {
        return { groupId: existingGroupId, created: false };
      }
    } catch {
      // Group may not exist anymore
    }
    ws.specialGroups[type] = null;
  }

  if (!tabIdForCreation) {
    return { groupId: null, created: false };
  }

  try {
    const config = GROUP_CONFIG[type];
    const groupId = await chrome.tabs.group({ tabIds: [tabIdForCreation], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, {
      title: config.title,
      color: config.color,
      collapsed: false,
    });
    ws.specialGroups[type] = groupId;
    logger.info('Created special group', { windowId, type, groupId });
    return { groupId, created: true };
  } catch (err) {
    logger.error('Failed to create special group', {
      windowId,
      type,
      error: err.message,
      errorCode: ERROR_CODES.ERR_GROUP_CREATE,
    });
    return { groupId: null, created: false };
  }
}

export async function removeSpecialGroupIfEmpty(windowId, type, windowState) {
  const ws = windowState[windowId] || windowState[String(windowId)];
  if (!ws || !ws.specialGroups) return { removed: false };

  const groupId = ws.specialGroups[type];
  if (groupId === null || groupId === undefined) return { removed: false };

  try {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length === 0) {
      ws.specialGroups[type] = null;
      logger.info('Removed empty special group reference', { windowId, type, groupId });
      return { removed: true };
    }
    return { removed: false };
  } catch {
    ws.specialGroups[type] = null;
    return { removed: true };
  }
}

export async function moveTabToSpecialGroup(tabId, type, windowId, windowState) {
  const ws = ensureWindowState(windowId, windowState);
  let groupId = ws.specialGroups[type];

  if (groupId === null) {
    const result = await ensureSpecialGroup(windowId, type, windowState, tabId);
    groupId = result.groupId;
    if (groupId === null) {
      logger.warn('Could not create special group for tab move', {
        tabId,
        type,
        windowId,
        errorCode: ERROR_CODES.ERR_GROUP_CREATE,
      });
      return { success: false };
    }
    if (result.created) {
      return { success: true, groupId };
    }
  }

  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
    logger.debug('Moved tab to special group', { tabId, type, groupId });
    return { success: true, groupId };
  } catch (err) {
    logger.error('Failed to move tab to special group', {
      tabId,
      type,
      groupId,
      error: err.message,
      errorCode: ERROR_CODES.ERR_TAB_GROUP,
    });
    return { success: false };
  }
}

// ─── Group Status & Sorting (US4) ────────────────────────────────────────────

const STATUS_PRIORITY = { green: 0, yellow: 1, red: 2 };

export function computeGroupStatus(groupId, tabMeta) {
  let freshest = null;
  for (const meta of Object.values(tabMeta)) {
    if (meta.groupId !== groupId) continue;
    if (meta.pinned) continue;
    if (meta.isSpecialGroup) continue;
    if (freshest === null || STATUS_PRIORITY[meta.status] < STATUS_PRIORITY[freshest]) {
      freshest = meta.status;
    }
  }
  return freshest;
}

export async function updateGroupColor(groupId, status) {
  try {
    await chrome.tabGroups.update(groupId, { color: status });
  } catch (err) {
    logger.warn('Failed to update group color', {
      groupId,
      status,
      error: err.message,
      errorCode: ERROR_CODES.ERR_GROUP_MOVE,
    });
  }
}

export async function closeGoneGroups(windowId, goneGroupIds, tabMeta, windowState) {
  const closedTabIds = [];
  const ws = windowState[windowId] || windowState[String(windowId)];

  for (const groupId of goneGroupIds) {
    if (ws && isSpecialGroup(groupId, windowId, windowState)) {
      continue;
    }

    const tabsInGroup = Object.values(tabMeta).filter(
      (m) => m.groupId === groupId && m.windowId === Number(windowId) && !m.pinned
    );

    for (const tab of tabsInGroup) {
      try {
        await chrome.tabs.remove(tab.tabId);
        closedTabIds.push(tab.tabId);
      } catch (err) {
        logger.warn('Failed to remove tab from gone group', {
          tabId: tab.tabId,
          groupId,
          error: err.message,
        });
      }
    }

    if (ws && ws.groupZones) {
      delete ws.groupZones[groupId];
      delete ws.groupZones[String(groupId)];
    }
  }

  return closedTabIds;
}

export async function sortGroupsIntoZones(windowId, tabMeta, windowState) {
  const ws = ensureWindowState(windowId, windowState);
  let moved = 0;

  try {
    const groups = await chrome.tabGroups.query({ windowId: Number(windowId) });
    const userGroups = groups.filter((g) => !isSpecialGroup(g.id, windowId, windowState));

    const greenGroups = [];
    const yellowGroups = [];
    const redGroups = [];

    for (const group of userGroups) {
      const status = computeGroupStatus(group.id, tabMeta);
      if (!status) continue;

      const previousZone = ws.groupZones[group.id] || ws.groupZones[String(group.id)];
      ws.groupZones[group.id] = status;

      if (status === 'green') greenGroups.push({ group, previousZone });
      else if (status === 'yellow') yellowGroups.push({ group, previousZone });
      else if (status === 'red') redGroups.push({ group, previousZone });
    }

    // Only move groups that changed zones
    const zoneOrder = [...greenGroups, ...yellowGroups, ...redGroups];
    let targetIndex = -1; // chrome will place after pinned tabs

    for (const { group, previousZone } of zoneOrder) {
      const currentZone = ws.groupZones[group.id];
      if (previousZone && previousZone === currentZone) {
        continue; // same zone, preserve order
      }

      try {
        if (targetIndex >= 0) {
          await chrome.tabGroups.move(group.id, { index: targetIndex });
        }
        moved++;
      } catch (err) {
        logger.warn('Failed to move group to zone', {
          groupId: group.id,
          zone: currentZone,
          error: err.message,
          errorCode: ERROR_CODES.ERR_GROUP_MOVE,
        });
      }
      targetIndex++;
    }

    // Update colors for all user groups
    for (const { group } of zoneOrder) {
      const status = ws.groupZones[group.id];
      if (status && group.color !== status) {
        await updateGroupColor(group.id, status);
      }
    }
  } catch (err) {
    logger.error('Failed to sort groups into zones', {
      windowId,
      error: err.message,
      errorCode: ERROR_CODES.ERR_GROUP_MOVE,
    });
  }

  return { moved };
}

/**
 * Dissolve unnamed groups that contain only a single tab.
 * The remaining tab is ungrouped and its meta is updated.
 */
export async function dissolveUnnamedSingleTabGroups(windowId, tabMeta, windowState) {
  let dissolved = 0;
  try {
    const groups = await chrome.tabGroups.query({ windowId: Number(windowId) });

    for (const group of groups) {
      // Skip special groups
      if (isSpecialGroup(group.id, windowId, windowState)) continue;
      // Only dissolve groups created by our extension
      if (!extensionCreatedGroups.has(group.id)) continue;
      // Only dissolve groups with no title (empty string or undefined)
      if (group.title) continue;

      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length !== 1) continue;

      const tab = tabs[0];
      try {
        await chrome.tabs.ungroup(tab.id);
        // Update tab meta
        const meta = tabMeta[tab.id] || tabMeta[String(tab.id)];
        if (meta) {
          meta.groupId = null;
          meta.isSpecialGroup = false;
        }
        extensionCreatedGroups.delete(group.id);
        dissolved++;
        logger.debug('Dissolved unnamed single-tab group', {
          groupId: group.id,
          tabId: tab.id,
          windowId,
        });
      } catch (err) {
        if (err.message && err.message.includes('cannot be edited')) {
          // Drag in progress — schedule continuous retry until drag completes
          scheduleDissolution(group.id, tab.id, windowId);
          logger.debug('Drag lock detected, scheduled dissolution retry', {
            groupId: group.id, tabId: tab.id,
          });
        } else {
          logger.warn('Failed to dissolve unnamed single-tab group', {
            groupId: group.id, tabId: tab.id, error: err.message,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Failed to query groups for dissolution', {
      windowId,
      error: err.message,
    });
  }
  return { dissolved };
}

export async function ungroupTab(tabId) {
  try {
    await chrome.tabs.ungroup(tabId);
    return true;
  } catch (err) {
    logger.warn('Failed to ungroup tab', { tabId, error: err.message });
    return false;
  }
}
