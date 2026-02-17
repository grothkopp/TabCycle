import { jest } from '@jest/globals';

// Mock chrome APIs
globalThis.chrome = {
  storage: {
    local: {
      get: jest.fn(async () => ({})),
      set: jest.fn(async () => {}),
    },
  },
  windows: {
    WINDOW_ID_NONE: -1,
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    update: jest.fn(async (groupId, props) => ({ id: groupId, ...props })),
  },
  tabs: {
    query: jest.fn(async () => []),
    get: jest.fn(async () => null),
    group: jest.fn(async (opts) => opts.groupId || 200),
    move: jest.fn(async () => {}),
  },
};

const { placeNewTab } = await import('../../src/background/tab-placer.js');

describe('tab-placer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should add new tab to context tab user group', async () => {
    const contextTab = { id: 10, windowId: 1, groupId: 5, pinned: false, index: 3 };
    chrome.tabs.get.mockResolvedValueOnce(contextTab);

    const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 4, openerTabId: 10 };
    const windowState = {
      1: { specialGroups: { yellow: 50, red: 60 }, groupZones: {} },
    };
    const tabMeta = {};

    await placeNewTab(newTab, 1, tabMeta, windowState);

    expect(chrome.tabs.get).toHaveBeenCalledWith(10);
    expect(chrome.tabs.group).toHaveBeenCalledWith(expect.objectContaining({
      tabIds: [20],
      groupId: 5,
    }));
    expect(chrome.tabs.move).toHaveBeenCalledWith(20, { index: 4 });
  });

  it('should move new tab to far left when context tab is in special group', async () => {
    const contextTab = { id: 10, windowId: 1, groupId: 50, pinned: false, index: 5 };
    chrome.tabs.get.mockResolvedValueOnce(contextTab);

    const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 6, openerTabId: 10 };
    const windowState = {
      1: { specialGroups: { yellow: 50, red: 60 }, groupZones: {} },
    };
    const tabMeta = {};

    await placeNewTab(newTab, 1, tabMeta, windowState);

    expect(chrome.tabs.move).toHaveBeenCalledWith(20, { index: 0 });
    expect(chrome.tabs.group).not.toHaveBeenCalled();
  });

  it('should create new group with both tabs when context tab is ungrouped', async () => {
    const contextTab = { id: 10, windowId: 1, groupId: -1, pinned: false, index: 2 };
    chrome.tabs.get.mockResolvedValueOnce(contextTab);

    const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 3, openerTabId: 10 };
    const windowState = {
      1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
    };
    const tabMeta = {
      10: { tabId: 10, windowId: 1, groupId: null, isSpecialGroup: false, pinned: false },
      20: { tabId: 20, windowId: 1, groupId: null, isSpecialGroup: false, pinned: false },
    };

    await placeNewTab(newTab, 1, tabMeta, windowState);

    expect(chrome.tabs.group).toHaveBeenCalledWith(expect.objectContaining({
      tabIds: [10, 20],
      createProperties: { windowId: 1 },
    }));
    // Should set color green immediately on new group creation
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(200, expect.objectContaining({
      title: '',
      color: 'green',
    }));
    // Both tabs' meta should be updated with the new groupId
    expect(tabMeta[10].groupId).toBe(200);
    expect(tabMeta[20].groupId).toBe(200);
  });

  it('should move to far left when context tab is pinned', async () => {
    const contextTab = { id: 10, windowId: 1, groupId: -1, pinned: true, index: 0 };
    chrome.tabs.get.mockResolvedValueOnce(contextTab);

    const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 1, openerTabId: 10 };
    const windowState = {};
    const tabMeta = {};

    await placeNewTab(newTab, 1, tabMeta, windowState);

    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.tabs.move).toHaveBeenCalledWith(20, { index: 0 });
  });

  it('should move to far left when no openerTabId (no context tab)', async () => {
    const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 0 };
    const windowState = {};
    const tabMeta = {};

    await placeNewTab(newTab, 1, tabMeta, windowState);

    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.tabs.move).toHaveBeenCalledWith(20, { index: 0 });
  });

  it('should fall back to far left when group add fails (stale group ID)', async () => {
    const contextTab = { id: 10, windowId: 1, groupId: 999, pinned: false, index: 3 };
    chrome.tabs.get.mockResolvedValueOnce(contextTab);
    chrome.tabs.group.mockRejectedValueOnce(new Error('No group with id: 999'));

    const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 4, openerTabId: 10 };
    const windowState = {
      1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
    };
    const tabMeta = {};

    await placeNewTab(newTab, 1, tabMeta, windowState);

    // Should have tried and failed, then fallen back to leftmost
    expect(chrome.tabs.move).toHaveBeenCalledWith(20, { index: 0 });
  });

  // ─── v2: autoGroupEnabled toggle ──────────────────────────────────────────

  describe('autoGroupEnabled toggle', () => {
    it('should skip all placement logic when autoGroupEnabled is false', async () => {
      const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 3, openerTabId: 10 };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };
      const tabMeta = {};
      const settings = { autoGroupEnabled: false };

      await placeNewTab(newTab, 1, tabMeta, windowState, settings);

      // No grouping, no moving, no context tab lookup
      expect(chrome.tabs.get).not.toHaveBeenCalled();
      expect(chrome.tabs.group).not.toHaveBeenCalled();
      expect(chrome.tabs.move).not.toHaveBeenCalled();
    });

    it('should proceed with normal placement when autoGroupEnabled is true', async () => {
      const contextTab = { id: 10, windowId: 1, groupId: -1, pinned: false, index: 2 };
      chrome.tabs.get.mockResolvedValueOnce(contextTab);

      const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 3, openerTabId: 10 };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };
      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: null, isSpecialGroup: false, pinned: false },
      };
      const settings = { autoGroupEnabled: true };

      await placeNewTab(newTab, 1, tabMeta, windowState, settings);

      // Should group both tabs (Case 2: context ungrouped & unpinned)
      expect(chrome.tabs.group).toHaveBeenCalledWith(expect.objectContaining({
        tabIds: [10, 20],
      }));
    });

    it('should proceed with placement when settings is undefined (backward compat)', async () => {
      const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 0 };
      const windowState = {};
      const tabMeta = {};

      await placeNewTab(newTab, 1, tabMeta, windowState, undefined);

      // Should still run the placement logic (no context tab → leftmost)
      expect(chrome.tabs.move).toHaveBeenCalledWith(20, { index: 0 });
    });

    it('should proceed with placement when settings has no autoGroupEnabled key', async () => {
      const contextTab = { id: 10, windowId: 1, groupId: -1, pinned: false, index: 2 };
      chrome.tabs.get.mockResolvedValueOnce(contextTab);

      const newTab = { id: 20, windowId: 1, groupId: -1, pinned: false, index: 3, openerTabId: 10 };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };
      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: null, isSpecialGroup: false, pinned: false },
      };
      const settings = { tabSortingEnabled: true }; // no autoGroupEnabled

      await placeNewTab(newTab, 1, tabMeta, windowState, settings);

      // Should proceed (autoGroupEnabled defaults to true when absent)
      expect(chrome.tabs.group).toHaveBeenCalled();
    });
  });
});
