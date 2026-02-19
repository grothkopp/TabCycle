import { STATUS } from '../shared/constants.js';

const TAB_GROUP_ID_NONE = -1;

export function createTabEntry(tab, activeTimeMs) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    refreshActiveTime: activeTimeMs,
    refreshWallTime: Date.now(),
    status: STATUS.GREEN,
    groupId: tab.groupId !== TAB_GROUP_ID_NONE ? tab.groupId : null,
    isSpecialGroup: false,
    pinned: tab.pinned || false,
    url: tab.url || '',
  };
}

export function handleNavigation(existingMeta, activeTimeMs, url) {
  return {
    ...existingMeta,
    refreshActiveTime: activeTimeMs,
    refreshWallTime: Date.now(),
    status: STATUS.GREEN,
    url: url || existingMeta.url || '',
  };
}

export function reconcileTabs(storedMeta, chromeTabs, activeTimeMs) {
  const reconciled = {};
  const now = Date.now();

  for (const tab of chromeTabs) {
    if (tab.pinned) continue;

    const stored = storedMeta[tab.id] || storedMeta[String(tab.id)];
    if (stored) {
      reconciled[tab.id] = {
        ...stored,
        windowId: tab.windowId,
        groupId: tab.groupId !== TAB_GROUP_ID_NONE ? tab.groupId : null,
        pinned: tab.pinned || false,
        url: tab.url || stored.url || '',
      };
    } else {
      reconciled[tab.id] = {
        tabId: tab.id,
        windowId: tab.windowId,
        refreshActiveTime: activeTimeMs,
        refreshWallTime: now,
        status: STATUS.GREEN,
        groupId: tab.groupId !== TAB_GROUP_ID_NONE ? tab.groupId : null,
        isSpecialGroup: false,
        pinned: false,
        url: tab.url || '',
      };
    }
  }

  return reconciled;
}
