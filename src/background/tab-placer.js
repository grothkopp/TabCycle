/**
 * Places newly created tabs according to context-aware grouping rules.
 *
 * When a new tab is opened, this module decides where it goes based on
 * the "context tab" — the tab that was active when the new one was created
 * (identified by openerTabId).
 *
 * Placement rules:
 *   1. Context tab is in a user group → add new tab to that group, right of context
 *   2. Context tab is ungrouped & unpinned → group both into a new green group
 *   3. All other cases (pinned, managed group, no context) → move to leftmost position
 */

import { createLogger } from '../shared/logger.js';
import { ERROR_CODES } from '../shared/constants.js';
import { isManagedAgingGroup, markGroupAsCreatedByExtension } from './group-manager.js';

const logger = createLogger('background');

/**
 * Places a newly created tab near the tab that opened it.
 *
 * @param {chrome.tabs.Tab} newTab - The newly created tab
 * @param {number} windowId - The window the tab was created in
 * @param {object} tabMeta - All tab metadata entries (may be mutated with group info)
 * @param {object} windowState - Per-window state (for checking managed groups)
 * @param {object} settings - User settings (for autoGroupEnabled check)
 */
export async function placeNewlyCreatedTabNearItsContext(newTab, windowId, tabMeta, windowState, settings) {
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

    // No context tab → move to far left
    if (!contextTab) {
      await chrome.tabs.move(newTab.id, { index: 0 });
      logger.debug('New tab moved to far left (no context tab)', { newTabId: newTab.id, windowId });
      return;
    }

    // Context tab is pinned → move to far left
    if (contextTab.pinned) {
      await chrome.tabs.move(newTab.id, { index: 0 });
      logger.debug('New tab moved to far left (context tab pinned)', { newTabId: newTab.id, contextTabId: contextTab.id });
      return;
    }

    const contextTabGroupId = contextTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
      ? contextTab.groupId
      : null;

    // Context tab is in a managed aging group → move to far left
    if (contextTabGroupId !== null && isManagedAgingGroup(contextTabGroupId, windowId, windowState)) {
      await chrome.tabs.move(newTab.id, { index: 0 });
      logger.debug('New tab moved to far left (context in special group)', {
        newTabId: newTab.id,
        contextTabId: contextTab.id,
        specialGroupId: contextTabGroupId,
      });
      return;
    }

    // Context tab is in a user group → add new tab to same group, right of context
    if (contextTabGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [newTab.id], groupId: contextTabGroupId });
        await chrome.tabs.move(newTab.id, { index: contextTab.index + 1 });
        logger.debug('New tab added to context tab group, right of context', {
          newTabId: newTab.id,
          groupId: contextTabGroupId,
        });
      } catch (groupError) {
        logger.warn('Failed to add to context group, moving to far left', {
          newTabId: newTab.id,
          groupId: contextTabGroupId,
          error: groupError.message,
        });
        await chrome.tabs.move(newTab.id, { index: 0 });
      }
      return;
    }

    // Context tab is ungrouped & unpinned → group both into a new green group
    const newGroupId = await chrome.tabs.group({
      tabIds: [contextTab.id, newTab.id],
      createProperties: { windowId },
    });
    await chrome.tabGroups.update(newGroupId, { title: '', color: 'green' });
    markGroupAsCreatedByExtension(newGroupId);

    // Update metadata for context tab to reflect the new group
    const contextTabMetadata = tabMeta[contextTab.id] || tabMeta[String(contextTab.id)];
    if (contextTabMetadata) {
      contextTabMetadata.groupId = newGroupId;
      contextTabMetadata.isSpecialGroup = false;
    }

    // Update metadata for new tab to reflect the new group
    const newTabMetadata = tabMeta[newTab.id] || tabMeta[String(newTab.id)];
    if (newTabMetadata) {
      newTabMetadata.groupId = newGroupId;
      newTabMetadata.isSpecialGroup = false;
    }

    logger.debug('Created new group for context + new tab, color green', {
      newTabId: newTab.id,
      contextTabId: contextTab.id,
      groupId: newGroupId,
    });
  } catch (error) {
    logger.error('Failed to place new tab', {
      newTabId: newTab.id,
      windowId,
      error: error.message,
      errorCode: ERROR_CODES.ERR_TAB_MOVE,
    });
  }
}
