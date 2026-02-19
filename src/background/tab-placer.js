import { createLogger } from '../shared/logger.js';
import { ERROR_CODES } from '../shared/constants.js';
import { isSpecialGroup, trackExtensionGroup } from './group-manager.js';

const logger = createLogger('background');

/**
 * Place a newly created tab according to context rules.
 *
 * The "context tab" is the tab that was active before the new tab was created.
 * We find it via `newTab.openerTabId` (set by Chrome for Ctrl+T / Cmd+T and
 * link-opened tabs) rather than querying the active tab, because Chrome has
 * already switched focus to the new tab by the time `onCreated` fires.
 *
 * Rules:
 *   1. Context tab is in a user group → move new tab to right of context tab in that group
 *   2. Context tab is ungrouped & unpinned → group both into a new tab group (color = green)
 *   3. All other cases (pinned, special-group, no context tab) → leftmost position
 */
export async function placeNewTab(newTab, windowId, tabMeta, windowState, settings) {
  // When auto-grouping is disabled, skip the entire placement logic.
  // New tabs open at Chrome's default position without being grouped.
  if (settings?.autoGroupEnabled === false) {
    logger.debug('Auto-grouping disabled, skipping tab placement', { newTabId: newTab.id, windowId });
    return;
  }

  try {
    // Find the context tab — the tab that was active before this new tab was created
    let contextTab = null;
    if (newTab.openerTabId) {
      try {
        contextTab = await chrome.tabs.get(newTab.openerTabId);
      } catch {
        // Opener tab may have been closed already
      }
    }

    // --- Case 3 fallback: no context tab → leftmost ---
    if (!contextTab) {
      await chrome.tabs.move(newTab.id, { index: 0 });
      logger.debug('New tab moved to far left (no context tab)', { newTabId: newTab.id, windowId });
      return;
    }

    // --- Case 3: context tab is pinned → leftmost ---
    if (contextTab.pinned) {
      await chrome.tabs.move(newTab.id, { index: 0 });
      logger.debug('New tab moved to far left (context tab pinned)', { newTabId: newTab.id, contextTabId: contextTab.id });
      return;
    }

    const contextGroupId = contextTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
      ? contextTab.groupId
      : null;

    // --- Case 3: context tab is in a special group → leftmost ---
    if (contextGroupId !== null && isSpecialGroup(contextGroupId, windowId, windowState)) {
      await chrome.tabs.move(newTab.id, { index: 0 });
      logger.debug('New tab moved to far left (context in special group)', {
        newTabId: newTab.id,
        contextTabId: contextTab.id,
        specialGroupId: contextGroupId,
      });
      return;
    }

    // --- Case 1: context tab is in a user group → add new tab to same group, right of context ---
    if (contextGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [newTab.id], groupId: contextGroupId });
        await chrome.tabs.move(newTab.id, { index: contextTab.index + 1 });
        logger.debug('New tab added to context tab group, right of context', {
          newTabId: newTab.id,
          groupId: contextGroupId,
        });
      } catch (groupErr) {
        // Group may have been removed between query and group call — fall back to leftmost
        logger.warn('Failed to add to context group, moving to far left', {
          newTabId: newTab.id,
          groupId: contextGroupId,
          error: groupErr.message,
        });
        await chrome.tabs.move(newTab.id, { index: 0 });
      }
      return;
    }

    // --- Case 2: context tab is ungrouped & unpinned → group both, set green color ---
    const groupId = await chrome.tabs.group({
      tabIds: [contextTab.id, newTab.id],
      createProperties: { windowId },
    });
    await chrome.tabGroups.update(groupId, { title: '', color: 'green' });
    trackExtensionGroup(groupId);

    // Update tab meta for the context tab to reflect the new group
    const contextMeta = tabMeta[contextTab.id] || tabMeta[String(contextTab.id)];
    if (contextMeta) {
      contextMeta.groupId = groupId;
      contextMeta.isSpecialGroup = false;
    }

    // Update new tab meta to reflect the new group
    const newMeta = tabMeta[newTab.id] || tabMeta[String(newTab.id)];
    if (newMeta) {
      newMeta.groupId = groupId;
      newMeta.isSpecialGroup = false;
    }

    logger.debug('Created new group for context + new tab, color green', {
      newTabId: newTab.id,
      contextTabId: contextTab.id,
      groupId,
    });
  } catch (err) {
    logger.error('Failed to place new tab', {
      newTabId: newTab.id,
      windowId,
      error: err.message,
      errorCode: ERROR_CODES.ERR_TAB_MOVE,
    });
  }
}
