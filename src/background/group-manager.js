import { SPECIAL_GROUP_TYPES, ERROR_CODES } from '../shared/constants.js';
import { computeAge } from './status-evaluator.js';
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
    const result = await chrome.tabGroups.update(groupId, { color: status });
    logger.debug('Updated group color', { groupId, status, resultColor: result?.color });
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

const ZONE_RANK = { green: 0, yellow: 1, red: 2 };

export async function sortGroupsIntoZones(windowId, tabMeta, windowState, activeTimeMs, settings) {
  const ws = ensureWindowState(windowId, windowState);
  let moved = 0;

  try {
    // groups come back in current visual order (left → right)
    const groups = await chrome.tabGroups.query({ windowId: Number(windowId) });

    logger.debug('Raw tabGroups.query result', {
      windowId,
      groups: groups.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed })),
    });

    // Separate user groups from special groups
    const userGroups = [];
    const specialGroupIds = new Set();
    for (const g of groups) {
      if (isSpecialGroup(g.id, windowId, windowState)) {
        specialGroupIds.add(g.id);
      } else {
        userGroups.push(g);
      }
    }

    // Compute the current zone for every user group
    const statusMap = new Map(); // groupId → zone string
    for (const group of userGroups) {
      const status = computeGroupStatus(group.id, tabMeta);
      if (!status) continue;
      statusMap.set(group.id, status);
      ws.groupZones[group.id] = status;
    }

    // Only consider groups that have a computed status
    const ordered = userGroups.filter((g) => statusMap.has(g.id));

    // Build the desired order: stable-sort user groups by zone rank,
    // then insert special groups at their zone boundaries.
    // Within each zone the original visual order (from Chrome query) is kept.
    const sortedUser = [...ordered].sort((a, b) => {
      return ZONE_RANK[statusMap.get(a.id)] - ZONE_RANK[statusMap.get(b.id)];
    });

    // Insert special groups: Yellow at the start of the yellow zone,
    // Red at the start of the red zone (FR-013, FR-014).
    const desired = [];
    const yellowSpecialId = ws.specialGroups.yellow;
    const redSpecialId = ws.specialGroups.red;
    let yellowInserted = false;
    let redInserted = false;

    for (const g of sortedUser) {
      const zone = statusMap.get(g.id);
      // Insert special Yellow before the first yellow-or-later user group
      if (!yellowInserted && yellowSpecialId !== null && specialGroupIds.has(yellowSpecialId)
          && ZONE_RANK[zone] >= ZONE_RANK.yellow) {
        desired.push({ id: yellowSpecialId, _special: true });
        yellowInserted = true;
      }
      // Insert special Red before the first red user group
      if (!redInserted && redSpecialId !== null && specialGroupIds.has(redSpecialId)
          && ZONE_RANK[zone] >= ZONE_RANK.red) {
        desired.push({ id: redSpecialId, _special: true });
        redInserted = true;
      }
      desired.push(g);
    }
    // Append special groups at the end if their zone has no user groups
    if (!yellowInserted && yellowSpecialId !== null && specialGroupIds.has(yellowSpecialId)) {
      desired.push({ id: yellowSpecialId, _special: true });
      yellowInserted = true;
    }
    if (!redInserted && redSpecialId !== null && specialGroupIds.has(redSpecialId)) {
      desired.push({ id: redSpecialId, _special: true });
    }

    // Build the current order including special groups
    const allOrdered = groups.filter((g) =>
      statusMap.has(g.id) || specialGroupIds.has(g.id)
    );
    const currentIds = allOrdered.map((g) => g.id);
    const desiredIds = desired.map((g) => g.id);

    // If order differs, move all groups in desired order to index:-1.
    // Each move appends to the end, so processing in desired order
    // produces the correct final sequence.  Group count is small (<10
    // typically) so moving all is fine and avoids partial-move bugs.
    if (currentIds.join(',') !== desiredIds.join(',')) {
      for (const g of desired) {
        try {
          await chrome.tabGroups.move(g.id, { index: -1 });
          moved++;
        } catch (err) {
          logger.warn('Failed to move group to zone', {
            groupId: g.id, zone: g._special ? 'special' : statusMap.get(g.id),
            error: err.message, errorCode: ERROR_CODES.ERR_GROUP_MOVE,
          });
        }
      }
    }

    // Update colors for user groups only (never touch special group colors)
    for (const g of ordered) {
      const status = statusMap.get(g.id);
      if (status) {
        await updateGroupColor(g.id, status);
      }
    }

    // Diagnostic: log all group ages for this window, sorted by age descending
    if (activeTimeMs !== undefined && settings) {
      const groupDiag = ordered.map((g) => {
        const tabCount = Object.values(tabMeta).filter(
          (m) => m.groupId === g.id && !m.pinned && !m.isSpecialGroup
        ).length;
        const age = computeGroupAge(g.id, tabMeta, activeTimeMs, settings);
        return {
          groupId: g.id,
          title: stripAgeSuffix(g.title) || '(unnamed)',
          chromeColor: g.color,
          computedStatus: statusMap.get(g.id),
          ageMs: age,
          ageFormatted: formatAge(age),
          tabCount,
        };
      });
      groupDiag.sort((a, b) => b.ageMs - a.ageMs);
      logger.info('Group age report', { windowId, groups: groupDiag });
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

// ─── Group Age Display ────────────────────────────────────────────────────────

const AGE_SUFFIX_RE = /\s?\([0-9]+[mhd]\)$/;

export function stripAgeSuffix(title) {
  if (!title) return title;
  return title.replace(AGE_SUFFIX_RE, '');
}

export function formatAge(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

export function computeGroupAge(groupId, tabMeta, activeTimeMs, settings) {
  let freshestAge = null;
  for (const meta of Object.values(tabMeta)) {
    if (meta.groupId !== groupId) continue;
    if (meta.pinned) continue;
    if (meta.isSpecialGroup) continue;
    const age = computeAge(meta, activeTimeMs, settings);
    if (freshestAge === null || age < freshestAge) freshestAge = age;
  }
  return freshestAge === null ? 0 : freshestAge;
}

export async function updateGroupTitlesWithAge(windowId, tabMeta, windowState, activeTimeMs, settings) {
  let updated = 0;
  try {
    const groups = await chrome.tabGroups.query({ windowId: Number(windowId) });

    for (const group of groups) {
      if (isSpecialGroup(group.id, windowId, windowState)) continue;

      const age = computeGroupAge(group.id, tabMeta, activeTimeMs, settings);
      if (age === 0) continue;

      const baseName = stripAgeSuffix(group.title) || '';
      const ageSuffix = `(${formatAge(age)})`;
      const newTitle = baseName ? `${baseName} ${ageSuffix}` : ageSuffix;

      if (newTitle !== group.title) {
        try {
          const result = await chrome.tabGroups.update(group.id, { title: newTitle });
          updated++;
          logger.debug('Updated group title with age', { groupId: group.id, newTitle, resultTitle: result?.title });
        } catch (err) {
          logger.warn('Failed to update group title with age', {
            groupId: group.id,
            newTitle,
            error: err.message,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Failed to update group titles with age', {
      windowId,
      error: err.message,
    });
  }
  return { updated };
}

export async function removeAgeSuffixFromAllGroups(windowId, windowState) {
  try {
    const groups = await chrome.tabGroups.query({ windowId: Number(windowId) });
    for (const group of groups) {
      if (isSpecialGroup(group.id, windowId, windowState)) continue;
      const baseName = stripAgeSuffix(group.title);
      if (baseName !== group.title) {
        try {
          await chrome.tabGroups.update(group.id, { title: baseName });
        } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
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
