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
  sortTabsAndGroups,
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

  // Helper: set up chrome.tabs.query and chrome.tabGroups.query for sortTabsAndGroups.
  // sortTabsAndGroups calls tabs.query + tabGroups.query in phase 1 (tab sort),
  // then tabGroups.query again in phase 3 (group sort).
  function mockBrowserState(chromeTabs, chromeGroups) {
    chrome.tabs.query.mockResolvedValue(chromeTabs);
    // Phase 1 + phase 3 both call tabGroups.query
    chrome.tabGroups.query.mockResolvedValue(chromeGroups);
  }

  describe('sortTabsAndGroups – group sorting', () => {
    // ── Already sorted ───────────────────────────────────────────────

    it('should not move groups when already in correct zone order', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'red', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(windowState[1].groupZones[1]).toBe('green');
      expect(windowState[1].groupZones[2]).toBe('yellow');
      expect(windowState[1].groupZones[3]).toBe('red');
      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    // ── Out-of-order correction ──────────────────────────────────────

    it('should fix wrong order by moving all groups in desired order', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'red' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'red', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]); // green
      expect(moveCalls[1]).toEqual([3, { index: -1 }]); // yellow
      expect(moveCalls[2]).toEqual([1, { index: -1 }]); // red
    });

    // ── Intra-zone stability ─────────────────────────────────────────

    it('should NOT move groups when all are in the same zone (all green)', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);
      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should NOT move groups when all are in the same zone (all yellow)', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);
      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should NOT reorder groups that stay green after a tab refresh', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);
      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    // ── Cross-zone transitions ───────────────────────────────────────

    it('should sort a group that became green to the left of yellows', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'yellow', 2: 'yellow', 3: 'yellow' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(windowState[1].groupZones[2]).toBe('green');
      // Desired: [green:2(new)] [yellow:1] [yellow:3]
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]);
      expect(moveCalls[1]).toEqual([1, { index: -1 }]);
      expect(moveCalls[2]).toEqual([3, { index: -1 }]);
    });

    it('should sort a group that became yellow to the right of greens', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'green', 3: 'green' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(windowState[1].groupZones[2]).toBe('yellow');
      // Desired: [green:1] [green:3] [yellow:2(new)]
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);
      expect(moveCalls[1]).toEqual([3, { index: -1 }]);
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);
    });

    it('should sort a group that became red to the far right', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'red', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'green', 3: 'yellow' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(windowState[1].groupZones[1]).toBe('red');
      // Desired: [green:2] [yellow:3] [red:1(new)]
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]);
      expect(moveCalls[1]).toEqual([3, { index: -1 }]);
      expect(moveCalls[2]).toEqual([1, { index: -1 }]);
    });

    // ── Intra-zone ordering with transitions ─────────────────────────

    it('should place newly yellow group at left of yellow zone, right of Yellow special', async () => {
      // Visual: [green:1] [Yellow:50] [yellow:2] [yellow:3]
      // Group 1 becomes yellow → desired: [Yellow:50] [yellow:1(new)] [yellow:2] [yellow:3]
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
        { id: 40, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        40: { tabId: 40, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: { 1: 'green', 2: 'yellow', 3: 'yellow' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Desired: [Yellow:50] [yellow:1(new)] [yellow:2] [yellow:3]
      expect(result.groupsMoved).toBe(4);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([50, { index: -1 }]);  // Yellow special
      expect(moveCalls[1]).toEqual([1, { index: -1 }]);   // newly yellow (left of zone)
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);   // staying yellow
      expect(moveCalls[3]).toEqual([3, { index: -1 }]);   // staying yellow
    });

    it('should place newly red group at left of red zone, right of Red special', async () => {
      // Visual: [green:1] [Yellow:50] [yellow:2] [Red:60] [red:3]
      // Group 2 becomes red → desired: [green:1] [Yellow:50] [Red:60] [red:2(new)] [red:3]
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 60, windowId: 1, title: 'Red', color: 'red' },
        { id: 3, windowId: 1, title: 'C', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
        { id: 40, windowId: 1, groupId: 60, pinned: false },
        { id: 50, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'red', isSpecialGroup: false, pinned: false },
        40: { tabId: 40, windowId: 1, groupId: 60, status: 'red', isSpecialGroup: true, pinned: false },
        50: { tabId: 50, windowId: 1, groupId: 3, status: 'red', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: 60 }, groupZones: { 1: 'green', 2: 'yellow', 3: 'red' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Desired: [green:1] [Yellow:50] [Red:60] [red:2(new)] [red:3]
      expect(result.groupsMoved).toBe(5);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);   // green:1
      expect(moveCalls[1]).toEqual([50, { index: -1 }]);  // Yellow special
      expect(moveCalls[2]).toEqual([60, { index: -1 }]);  // Red special
      expect(moveCalls[3]).toEqual([2, { index: -1 }]);   // red:2 (newly red, left of zone)
      expect(moveCalls[4]).toEqual([3, { index: -1 }]);   // red:3 (staying)
    });

    it('should place refreshed green group at leftmost position', async () => {
      // Visual: [green:1] [green:2] [yellow:3]
      // Group 3 becomes green → desired: [green:3(new)] [green:1] [green:2]
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 2, pinned: false },
        { id: 30, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'green', 3: 'yellow' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Desired: [green:3(new, leftmost)] [green:1] [green:2]
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([3, { index: -1 }]);   // newly green (leftmost)
      expect(moveCalls[1]).toEqual([1, { index: -1 }]);   // staying green
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);   // staying green
    });

    // ── Special group handling ────────────────────────────────────────

    it('should move Yellow special to the right of green groups when no yellow user groups exist', async () => {
      // User scenario: [Yellow:50] [green:1] [green:2]
      // Yellow has no yellow user groups to anchor to → should go after all greens
      // Desired: [green:1] [green:2] [Yellow:50]
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
      ];
      const tabs = [
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Yellow should be moved to the right of all green groups
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);   // green:1
      expect(moveCalls[1]).toEqual([2, { index: -1 }]);   // green:2
      expect(moveCalls[2]).toEqual([50, { index: -1 }]);  // Yellow special (after greens)
    });

    it('should position special Yellow at the left of the yellow zone', async () => {
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);
      expect(moveCalls[1]).toEqual([50, { index: -1 }]);
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);
      // Special group does NOT get a zone assignment
      expect(windowState[1].groupZones[50]).toBeUndefined();
    });

    it('should not move special group when already at correct position', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should position both special groups at their zone boundaries', async () => {
      const groups = [
        { id: 60, windowId: 1, title: 'Red', color: 'red' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
        { id: 40, windowId: 1, groupId: 60, pinned: false },
        { id: 50, windowId: 1, groupId: 3, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        40: { tabId: 40, windowId: 1, groupId: 60, status: 'red', isSpecialGroup: true, pinned: false },
        50: { tabId: 50, windowId: 1, groupId: 3, status: 'red', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: 60 }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.groupsMoved).toBe(5);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);   // green:1
      expect(moveCalls[1]).toEqual([50, { index: -1 }]);  // Yellow special
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);   // yellow:2
      expect(moveCalls[3]).toEqual([60, { index: -1 }]);  // Red special
      expect(moveCalls[4]).toEqual([3, { index: -1 }]);   // red:3
    });

    it('should re-discover orphaned Yellow special group and sort it correctly', async () => {
      // windowState lost the Yellow reference (null), but Chrome still has the group
      // The sort should re-discover it by title/color and sort it to the right of greens
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
      ];
      const tabs = [
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Should re-discover Yellow group and re-register it
      expect(windowState[1].specialGroups.yellow).toBe(50);
      // Should move Yellow to the right of green groups
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);   // green:1
      expect(moveCalls[1]).toEqual([2, { index: -1 }]);   // green:2
      expect(moveCalls[2]).toEqual([50, { index: -1 }]);  // Yellow special (after greens)
    });

    it('should never change the color of a special group', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'green', isSpecialGroup: true, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      await sortTabsAndGroups(1, tabMeta, windowState);

      const updateCalls = chrome.tabGroups.update.mock.calls;
      for (const call of updateCalls) {
        expect(call[0]).not.toBe(50);
      }
    });
  });

  describe('sortTabsAndGroups – ungrouped tab sorting', () => {
    it('should move ungrouped yellow tab to yellow special group', async () => {
      // Tab 10 is ungrouped but status=yellow → should be moved to yellow special group
      const groups = [];
      const tabs = [
        { id: 10, windowId: 1, groupId: -1, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      // Mock the group creation for moveTabToSpecialGroup
      chrome.tabs.group.mockResolvedValueOnce(100);
      chrome.tabGroups.update.mockResolvedValueOnce({ id: 100, title: 'Yellow', color: 'yellow' });

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.tabsMoved).toBe(1);
      expect(tabMeta[10].isSpecialGroup).toBe(true);
      expect(tabMeta[10].groupId).toBe(100);
    });

    it('should not move ungrouped green tab', async () => {
      const groups = [];
      const tabs = [
        { id: 10, windowId: 1, groupId: -1, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.tabsMoved).toBe(0);
      expect(tabMeta[10].isSpecialGroup).toBe(false);
      expect(tabMeta[10].groupId).toBeNull();
    });

    it('should move tab from yellow special to red special when status becomes red', async () => {
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 50, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      // Mock moving to red group
      chrome.tabs.group.mockResolvedValueOnce(60);
      chrome.tabGroups.update.mockResolvedValueOnce({ id: 60, title: 'Red', color: 'red' });
      // Mock empty check for yellow group after move
      chrome.tabs.query.mockImplementation(async (q) => {
        if (q.windowId) return tabs;
        if (q.groupId === 50) return []; // yellow group now empty
        if (q.groupId === 60) return [{ id: 10 }];
        return [];
      });

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 50, status: 'red', isSpecialGroup: true, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.tabsMoved).toBe(1);
      expect(tabMeta[10].groupId).toBe(60);
      expect(tabMeta[10].isSpecialGroup).toBe(true);
    });

    it('should not move tab already in correct special group', async () => {
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 50, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.tabsMoved).toBe(0);
    });

    it('should skip tabs in user groups (they are sorted as groups)', async () => {
      const groups = [
        { id: 5, windowId: 1, title: 'MyGroup', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 5, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 5, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Tab should not be individually moved — it's in a user group
      expect(result.tabsMoved).toBe(0);
    });
  });
});
