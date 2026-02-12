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
    query: jest.fn(async () => []),
    move: jest.fn(async () => {}),
  },
  tabs: {
    query: jest.fn(async () => []),
    group: jest.fn(async () => 100),
    move: jest.fn(async () => {}),
    remove: jest.fn(async () => {}),
    ungroup: jest.fn(async () => {}),
  },
};

const {
  computeGroupStatus,
  updateGroupColor,
  sortGroupsIntoZones,
  closeGoneGroups,
} = await import('../../src/background/group-manager.js');

describe('group-sorting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('computeGroupStatus', () => {
    it('should return status of the freshest (newest) tab in group', () => {
      const tabMeta = {
        1: { tabId: 1, groupId: 5, status: 'yellow', isSpecialGroup: false, pinned: false },
        2: { tabId: 2, groupId: 5, status: 'green', isSpecialGroup: false, pinned: false },
        3: { tabId: 3, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
      };
      // Freshest tab is green → group status should be green
      expect(computeGroupStatus(5, tabMeta)).toBe('green');
    });

    it('should return yellow when freshest tab is yellow', () => {
      const tabMeta = {
        1: { tabId: 1, groupId: 5, status: 'yellow', isSpecialGroup: false, pinned: false },
        2: { tabId: 2, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
      };
      expect(computeGroupStatus(5, tabMeta)).toBe('yellow');
    });

    it('should return red when all tabs are red', () => {
      const tabMeta = {
        1: { tabId: 1, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
        2: { tabId: 2, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
      };
      expect(computeGroupStatus(5, tabMeta)).toBe('red');
    });

    it('should return null when no tabs belong to group', () => {
      const tabMeta = {
        1: { tabId: 1, groupId: 10, status: 'green', isSpecialGroup: false, pinned: false },
      };
      expect(computeGroupStatus(5, tabMeta)).toBeNull();
    });

    it('should skip pinned tabs', () => {
      const tabMeta = {
        1: { tabId: 1, groupId: 5, status: 'green', isSpecialGroup: false, pinned: true },
        2: { tabId: 2, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
      };
      expect(computeGroupStatus(5, tabMeta)).toBe('red');
    });

    it('should skip tabs in special groups', () => {
      const tabMeta = {
        1: { tabId: 1, groupId: 5, status: 'green', isSpecialGroup: true, pinned: false },
        2: { tabId: 2, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
      };
      expect(computeGroupStatus(5, tabMeta)).toBe('red');
    });
  });

  describe('updateGroupColor', () => {
    it('should set green color for green status', async () => {
      await updateGroupColor(5, 'green');
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(5, { color: 'green' });
    });

    it('should set yellow color for yellow status', async () => {
      await updateGroupColor(5, 'yellow');
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(5, { color: 'yellow' });
    });

    it('should set red color for red status', async () => {
      await updateGroupColor(5, 'red');
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(5, { color: 'red' });
    });
  });

  describe('closeGoneGroups', () => {
    it('should close all tabs in a gone user group', async () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
        2: { tabId: 2, windowId: 1, groupId: 5, status: 'red', isSpecialGroup: false, pinned: false },
      };
      const windowState = {
        1: { specialGroups: { yellow: 50, red: 60 }, groupZones: { 5: 'red' } },
      };

      // computeGroupStatus returns 'red' but we need to simulate gone
      // closeGoneGroups works with a set of gone group IDs
      const goneGroupIds = [5];
      const closedTabIds = await closeGoneGroups(1, goneGroupIds, tabMeta, windowState);

      expect(chrome.tabs.remove).toHaveBeenCalled();
      expect(closedTabIds).toContain(1);
      expect(closedTabIds).toContain(2);
    });

    it('should not close special groups', async () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, groupId: 60, status: 'red', isSpecialGroup: true, pinned: false },
      };
      const windowState = {
        1: { specialGroups: { yellow: 50, red: 60 }, groupZones: {} },
      };

      const closedTabIds = await closeGoneGroups(1, [60], tabMeta, windowState);
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
      expect(closedTabIds).toHaveLength(0);
    });
  });

  describe('sortGroupsIntoZones', () => {
    it('should compute target zone positions for groups', async () => {
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'red' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'red', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      // Verify zones are assigned
      expect(windowState[1].groupZones[1]).toBe('green');
      expect(windowState[1].groupZones[2]).toBe('yellow');
      expect(windowState[1].groupZones[3]).toBe('red');
      expect(result.moved).toBeGreaterThanOrEqual(0);
    });

    it('should not move groups within the same zone', async () => {
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'green' } },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);
      // Groups already in green zone, no moves needed
      expect(result.moved).toBe(0);
    });
  });
});
