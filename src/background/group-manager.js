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

/**
 * Unified sort: reads live browser state, sorts an internal model, then
 * applies the minimal set of moves to make the browser match.
 *
 * 1. Ungrouped tabs: if status ≠ zone → move to special group (yellow/red)
 *    or leave to the right of the green zone.  If status = zone → skip.
 * 2. Groups: compute each group's status, build desired order, compare
 *    to actual order, move only when they differ.
 */
export async function sortTabsAndGroups(windowId, tabMeta, windowState) {
  const ws = ensureWindowState(windowId, windowState);
  const result = { tabsMoved: 0, groupsMoved: 0 };

  try {
    // ── 1. Read current browser state ──────────────────────────────────
    const [chromeTabs, chromeGroups] = await Promise.all([
      chrome.tabs.query({ windowId: Number(windowId) }),
      chrome.tabGroups.query({ windowId: Number(windowId) }),
    ]);

    // Build lookup: tabId → chrome tab (for position info)
    const chromeTabMap = new Map();
    for (const ct of chromeTabs) chromeTabMap.set(ct.id, ct);

    // Identify special group IDs
    const specialGroupIds = new Set();
    for (const g of chromeGroups) {
      if (isSpecialGroup(g.id, windowId, windowState)) specialGroupIds.add(g.id);
    }

    logger.debug('sortTabsAndGroups: browser state read', {
      windowId,
      tabCount: chromeTabs.length,
      groupCount: chromeGroups.length,
      specialGroupIds: [...specialGroupIds],
    });

    // ── 2. Sort ungrouped tabs ─────────────────────────────────────────
    // Collect unpinned, ungrouped tabs that we track
    for (const ct of chromeTabs) {
      if (ct.pinned) continue;
      const meta = tabMeta[ct.id] || tabMeta[String(ct.id)];
      if (!meta) continue;

      const actualGroupId = ct.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? ct.groupId : null;
      const inSpecial = actualGroupId !== null && specialGroupIds.has(actualGroupId);
      const inUserGroup = actualGroupId !== null && !inSpecial;

      // Skip tabs in user groups — they are sorted as part of group sorting
      if (inUserGroup) continue;

      // Determine what zone the tab is currently in
      let currentZone = 'green'; // ungrouped = green zone
      if (inSpecial) {
        const sgType = getSpecialGroupType(actualGroupId, windowId, windowState);
        if (sgType === SPECIAL_GROUP_TYPES.YELLOW) currentZone = 'yellow';
        else if (sgType === SPECIAL_GROUP_TYPES.RED) currentZone = 'red';
      }

      const desiredZone = meta.status; // green, yellow, or red

      // If status matches zone → don't sort it
      if (currentZone === desiredZone) continue;

      // Status differs from zone → move according to rules
      if (desiredZone === 'yellow') {
        // Move to yellow special group
        const moveResult = await moveTabToSpecialGroup(ct.id, 'yellow', windowId, windowState);
        if (moveResult.success) {
          meta.groupId = moveResult.groupId;
          meta.isSpecialGroup = true;
          result.tabsMoved++;
          // Refresh specialGroupIds in case a new group was created
          if (!specialGroupIds.has(moveResult.groupId)) specialGroupIds.add(moveResult.groupId);
        }
      } else if (desiredZone === 'red') {
        // Move to red special group (from yellow special or ungrouped)
        const moveResult = await moveTabToSpecialGroup(ct.id, 'red', windowId, windowState);
        if (moveResult.success) {
          meta.groupId = moveResult.groupId;
          meta.isSpecialGroup = true;
          result.tabsMoved++;
          if (!specialGroupIds.has(moveResult.groupId)) specialGroupIds.add(moveResult.groupId);
        }
      } else if (desiredZone === 'green' && inSpecial) {
        // Tab became green but is still in a special group → ungroup
        const ungrouped = await ungroupTab(ct.id);
        if (ungrouped) {
          meta.groupId = null;
          meta.isSpecialGroup = false;
          result.tabsMoved++;
        }
      }
    }

    // Clean up empty special groups only if we moved tabs out of them
    if (result.tabsMoved > 0) {
      await removeSpecialGroupIfEmpty(windowId, 'yellow', windowState);
      await removeSpecialGroupIfEmpty(windowId, 'red', windowState);
    }

    // ── 3. Sort groups ─────────────────────────────────────────────────
    // Re-read groups after tab moves may have created/emptied groups
    const groupsAfter = await chrome.tabGroups.query({ windowId: Number(windowId) });

    // Refresh special group set — also re-discover by title/color if
    // the windowState reference was lost (e.g. after service worker restart)
    const specialAfter = new Set();
    for (const g of groupsAfter) {
      if (isSpecialGroup(g.id, windowId, windowState)) {
        specialAfter.add(g.id);
      } else if (g.title === 'Yellow' && g.color === 'yellow' && ws.specialGroups.yellow === null) {
        // Re-register orphaned Yellow special group
        ws.specialGroups.yellow = g.id;
        specialAfter.add(g.id);
        logger.info('Re-discovered orphaned Yellow special group', { windowId, groupId: g.id });
      } else if (g.title === 'Red' && g.color === 'red' && ws.specialGroups.red === null) {
        // Re-register orphaned Red special group
        ws.specialGroups.red = g.id;
        specialAfter.add(g.id);
        logger.info('Re-discovered orphaned Red special group', { windowId, groupId: g.id });
      }
    }

    const userGroups = [];
    for (const g of groupsAfter) {
      if (!specialAfter.has(g.id)) userGroups.push(g);
    }

    // Snapshot previous zones BEFORE overwriting
    const prevZones = { ...ws.groupZones };

    // Compute status for every user group
    const statusMap = new Map();
    for (const group of userGroups) {
      const status = computeGroupStatus(group.id, tabMeta);
      if (!status) continue;
      statusMap.set(group.id, status);
      ws.groupZones[group.id] = status;
    }

    const ordered = userGroups.filter((g) => statusMap.has(g.id));

    // Detect which groups just transitioned into a new zone
    const justArrived = new Set();
    for (const g of ordered) {
      const cur = statusMap.get(g.id);
      const prev = prevZones[g.id] || prevZones[String(g.id)];
      if (prev !== undefined && prev !== cur) {
        justArrived.add(g.id);
      }
    }

    // Build sorted list per zone.  Within each zone:
    //   - newly arrived groups go to the LEFT (inserted first)
    //   - groups already in the zone keep their Chrome visual order
    // For green: newly refreshed → leftmost of ALL groups
    // For yellow/red: newly arrived → left of zone (right of special group)
    const greenGroups = ordered.filter((g) => statusMap.get(g.id) === 'green');
    const yellowGroups = ordered.filter((g) => statusMap.get(g.id) === 'yellow');
    const redGroups = ordered.filter((g) => statusMap.get(g.id) === 'red');

    const sortWithNewFirst = (groups) => {
      const arrived = groups.filter((g) => justArrived.has(g.id));
      const staying = groups.filter((g) => !justArrived.has(g.id));
      return [...arrived, ...staying];
    };

    const sortedUser = [
      ...sortWithNewFirst(greenGroups),
      ...sortWithNewFirst(yellowGroups),
      ...sortWithNewFirst(redGroups),
    ];

    // Insert special groups at zone boundaries:
    // Yellow special at the start of the yellow zone,
    // Red special at the start of the red zone.
    const desired = [];
    const yellowSpecialId = ws.specialGroups.yellow;
    const redSpecialId = ws.specialGroups.red;
    let yellowInserted = false;
    let redInserted = false;

    for (const g of sortedUser) {
      const zone = statusMap.get(g.id);
      if (!yellowInserted && yellowSpecialId !== null && specialAfter.has(yellowSpecialId)
          && ZONE_RANK[zone] >= ZONE_RANK.yellow) {
        desired.push({ id: yellowSpecialId, _special: true });
        yellowInserted = true;
      }
      if (!redInserted && redSpecialId !== null && specialAfter.has(redSpecialId)
          && ZONE_RANK[zone] >= ZONE_RANK.red) {
        desired.push({ id: redSpecialId, _special: true });
        redInserted = true;
      }
      desired.push(g);
    }
    if (!yellowInserted && yellowSpecialId !== null && specialAfter.has(yellowSpecialId)) {
      desired.push({ id: yellowSpecialId, _special: true });
    }
    if (!redInserted && redSpecialId !== null && specialAfter.has(redSpecialId)) {
      desired.push({ id: redSpecialId, _special: true });
    }

    // Compare current order to desired order
    const allOrdered = groupsAfter.filter((g) =>
      statusMap.has(g.id) || specialAfter.has(g.id)
    );
    const currentIds = allOrdered.map((g) => g.id);
    const desiredIds = desired.map((g) => g.id);

    logger.info('sortTabsAndGroups: group order comparison', {
      windowId,
      currentIds,
      desiredIds,
      specialGroups: { yellow: ws.specialGroups.yellow, red: ws.specialGroups.red },
      specialAfter: [...specialAfter],
      userGroupStatuses: Object.fromEntries(statusMap),
      groupsAfterIds: groupsAfter.map((g) => g.id),
      needsMove: currentIds.join(',') !== desiredIds.join(','),
    });

    if (currentIds.join(',') !== desiredIds.join(',')) {
      for (const g of desired) {
        try {
          await chrome.tabGroups.move(g.id, { index: -1 });
          result.groupsMoved++;
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

    logger.debug('sortTabsAndGroups: complete', {
      windowId,
      tabsMoved: result.tabsMoved,
      groupsMoved: result.groupsMoved,
      desiredGroupOrder: desiredIds,
    });
  } catch (err) {
    logger.error('Failed to sort tabs and groups', {
      windowId,
      error: err.message,
      errorCode: ERROR_CODES.ERR_GROUP_MOVE,
    });
  }

  return result;
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
