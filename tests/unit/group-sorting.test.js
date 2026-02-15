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
    get: jest.fn(async () => ({})),
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

    it('should place a brand-new green group at leftmost position (no prior groupZones entry)', async () => {
      // Visual: [green:1] [green:2] [green:3(new)]
      // Group 3 is brand new (no groupZones entry) → desired: [green:3(new)] [green:1] [green:2]
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

      // Group 3 has NO prior groupZones entry — it's brand new
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'green' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Desired: [green:3(new, leftmost)] [green:1] [green:2]
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([3, { index: -1 }]);   // brand-new green (leftmost)
      expect(moveCalls[1]).toEqual([1, { index: -1 }]);   // staying green
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);   // staying green
    });

    it('should keep visual order when multiple green groups have no prior zone entries', async () => {
      // chrome.tabGroups.query returns creation order [1,2],
      // but visual order from tab indices is [2,1].
      // With no prior groupZones entries, sort must preserve visual order
      // and avoid reordering based on creation order.
      const groups = [
        { id: 1, windowId: 1, title: 'Older', color: 'green' },
        { id: 2, windowId: 1, title: 'NewerLeft', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 2, pinned: false, index: 1 },
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 2 },
        { id: 30, windowId: 1, groupId: 1, pinned: false, index: 6 },
        { id: 40, windowId: 1, groupId: 1, pinned: false, index: 7 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        40: { tabId: 40, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should NOT move a brand-new green group when it is the only group', async () => {
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);
      expect(result.groupsMoved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
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
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 10, windowId: 1, groupId: 1, pinned: false },
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
        { id: 40, windowId: 1, groupId: 60, pinned: false },
        { id: 20, windowId: 1, groupId: 50, pinned: false },
        { id: 10, windowId: 1, groupId: 1, pinned: false },
        { id: 30, windowId: 1, groupId: 2, pinned: false },
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

    it('should NOT hijack a user group named "Yellow"/yellow as a special group when special ID is null', async () => {
      // A user created a group titled "Yellow" with color yellow.
      // windowState.specialGroups.yellow is null (lost after restart).
      // The sort must treat group 50 as a normal user group, NOT re-register it.
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
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Must NOT re-register the user group as a special group
      expect(windowState[1].specialGroups.yellow).toBeNull();
      // Group 50 should be sorted as a normal user group (yellow zone)
      expect(windowState[1].groupZones[50]).toBe('yellow');
      // Desired order: [green:1] [green:2] [yellow:50]
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);   // green:1
      expect(moveCalls[1]).toEqual([2, { index: -1 }]);   // green:2
      expect(moveCalls[2]).toEqual([50, { index: -1 }]);   // yellow user group (NOT special)
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

  describe('sortTabsAndGroups – threshold change resort', () => {
    // Scenario A: When thresholds change, tabs that were yellow under old
    // thresholds may become green or red under new thresholds. The sort
    // must move them to the correct special group (or ungroup them).

    it('should move tab from Yellow special to ungrouped when status changes to green (threshold raised)', async () => {
      // Tab was yellow under old thresholds, but after threshold raise its
      // status is now green → should be ungrouped (not in Yellow special).
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 50, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 50, status: 'green', isSpecialGroup: true, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Tab is green but in Yellow special → should be moved out
      expect(result.tabsMoved).toBe(1);
      expect(tabMeta[10].groupId).not.toBe(50);
    });

    it('should move tab from Yellow special to Red special when status changes to red (threshold lowered)', async () => {
      // Tab was yellow, but after threshold change its status is now red
      // → should move from Yellow special to Red special.
      const groups = [
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 50, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      chrome.tabs.group.mockResolvedValueOnce(60);
      chrome.tabGroups.update.mockResolvedValueOnce({ id: 60, title: 'Red', color: 'red' });
      chrome.tabs.query.mockImplementation(async (q) => {
        if (q.windowId) return tabs;
        if (q.groupId === 50) return [];
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

    it('should resort user groups when threshold change causes zone transitions', async () => {
      // Three user groups: 1 was green, 2 was yellow, 3 was green.
      // After threshold change: 1 is now yellow, 2 is now red, 3 stays green.
      // Current visual: [1(yellow), 2(red), 3(green)]
      // Desired: [green:3] [yellow:1] [red:2]
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false, index: 0 },
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 1 },
        { id: 30, windowId: 1, groupId: 3, pinned: false, index: 2 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'red', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'yellow', 3: 'green' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(windowState[1].groupZones[1]).toBe('yellow');
      expect(windowState[1].groupZones[2]).toBe('red');
      expect(windowState[1].groupZones[3]).toBe('green');
      // Desired: [3, 1, 2], current: [1, 2, 3] → must move
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([3, { index: -1 }]); // green
      expect(moveCalls[1]).toEqual([1, { index: -1 }]); // yellow
      expect(moveCalls[2]).toEqual([2, { index: -1 }]); // red
    });
  });

  describe('sortTabsAndGroups – refresh in user group triggers resort', () => {
    // Scenario C: When a tab in a yellow/red user group is refreshed
    // (navigated), its status becomes green. The group's status is
    // recomputed (freshest tab = green) and the group moves to green zone.

    it('should move yellow user group to green zone when one tab is refreshed', async () => {
      // Group 2 was yellow (left), group 1 was yellow (right).
      // Tab 11 in group 1 refreshed → green. Group 1 becomes green → leftmost.
      // Current visual: [2(yellow), 1(green)]
      // Desired: [green:1(refreshed, leftmost)] [yellow:2]
      const groups = [
        { id: 2, windowId: 1, title: 'News', color: 'yellow' },
        { id: 1, windowId: 1, title: 'Research', color: 'yellow' },
      ];
      const tabs = [
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 0 },
        { id: 10, windowId: 1, groupId: 1, pinned: false, index: 1 },
        { id: 11, windowId: 1, groupId: 1, pinned: false, index: 2 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        11: { tabId: 11, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'yellow', 2: 'yellow' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Group 1 should now be green (freshest tab is green)
      expect(windowState[1].groupZones[1]).toBe('green');
      // Group 2 stays yellow
      expect(windowState[1].groupZones[2]).toBe('yellow');
      // Desired: [1, 2], current: [2, 1] → must move
      expect(result.groupsMoved).toBe(2);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]); // newly green (leftmost)
      expect(moveCalls[1]).toEqual([2, { index: -1 }]); // staying yellow
    });

    it('should move red user group to green zone when a tab is refreshed', async () => {
      // Group 2 was red (right), group 1 was green (left).
      // Tab 20 in group 2 refreshed → green. Group 2 moves to green zone leftmost.
      // Desired: [green:2(refreshed, leftmost)] [green:1(staying)]
      const groups = [
        { id: 1, windowId: 1, title: 'Active', color: 'green' },
        { id: 2, windowId: 1, title: 'OldStuff', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 1, pinned: false, index: 0 },
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 1 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'red' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Group 2 should now be green (refreshed)
      expect(windowState[1].groupZones[2]).toBe('green');
      // Refreshed group goes to leftmost → desired: [2, 1], current: [1, 2] → must move
      expect(result.groupsMoved).toBe(2);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]); // newly green (leftmost)
      expect(moveCalls[1]).toEqual([1, { index: -1 }]); // staying green
    });
  });

  describe('sortTabsAndGroups – tab dragged to different-status group', () => {
    // Scenario D: When a user drags a green tab into a yellow group,
    // the group's status is recomputed. If the freshest tab is now green,
    // the group becomes green and must be resorted to the green zone.

    it('should recompute group status to green when a green tab is added to yellow group', async () => {
      // Group 1 green (left), group 2 yellow (right), group 3 yellow (right).
      // User drags green tab 10 into group 2.
      // Group 2 now has a green tab → status = green → leftmost.
      // Desired: [green:2(refreshed, leftmost)] [green:1(staying)] [yellow:3]
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ];
      const tabs = [
        { id: 30, windowId: 1, groupId: 1, pinned: false, index: 0 },
        { id: 10, windowId: 1, groupId: 2, pinned: false, index: 1 },
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 2 },
        { id: 40, windowId: 1, groupId: 3, pinned: false, index: 3 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        40: { tabId: 40, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'yellow', 3: 'yellow' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Group 2 should now be green (freshest tab is green)
      expect(windowState[1].groupZones[2]).toBe('green');
      // Group 2 transitioned yellow→green → leftmost
      // Desired: [2, 1, 3], current: [1, 2, 3] → must move
      expect(result.groupsMoved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]); // newly green (leftmost)
      expect(moveCalls[1]).toEqual([1, { index: -1 }]); // staying green
      expect(moveCalls[2]).toEqual([3, { index: -1 }]); // staying yellow
    });

    it('should recompute group status to yellow when a yellow tab is added to red group', async () => {
      // Group 2 was red. User drags yellow tab 10 into it.
      // Group 2 now has a yellow tab → status = yellow → moves to yellow zone.
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 2, pinned: false, index: 0 },
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 1 },
        { id: 30, windowId: 1, groupId: 1, pinned: false, index: 2 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'red', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'red' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      // Group 2 should now be yellow (freshest tab is yellow)
      expect(windowState[1].groupZones[2]).toBe('yellow');
      // Desired: [green:1] [yellow:2]
      expect(result.groupsMoved).toBeGreaterThan(0);
    });

    it('should keep group red when a red tab is added to another red group', async () => {
      // Group 2 was red. User drags another red tab into it.
      // Group 2 stays red → no zone change.
      const groups = [
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 2, pinned: false, index: 0 },
        { id: 20, windowId: 1, groupId: 2, pinned: false, index: 1 },
        { id: 30, windowId: 1, groupId: 1, pinned: false, index: 2 },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 2, status: 'red', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'red', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 1: 'green', 2: 'red' } },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(windowState[1].groupZones[2]).toBe('red');
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

    it('should recreate stale special group id before moving tab', async () => {
      const tabs = [
        { id: 10, windowId: 1, groupId: -1, pinned: false },
      ];
      chrome.tabGroups.query.mockResolvedValue([]);
      chrome.tabs.query.mockImplementation(async (q) => {
        if (q.windowId !== undefined) return tabs;
        if (q.groupId === 50) throw new Error('No group with id: 50.');
        if (q.groupId === 100) return [{ id: 10, windowId: 1, groupId: 100, pinned: false }];
        return [];
      });

      chrome.tabs.group.mockResolvedValueOnce(100);
      chrome.tabGroups.update.mockResolvedValueOnce({ id: 100, title: 'Yellow', color: 'yellow' });

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.tabsMoved).toBe(1);
      expect(windowState[1].specialGroups.yellow).toBe(100);
      expect(tabMeta[10].groupId).toBe(100);
      expect(tabMeta[10].isSpecialGroup).toBe(true);
      expect(chrome.tabs.group).not.toHaveBeenCalledWith(expect.objectContaining({
        groupId: 50,
      }));
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

    it('should close gone ungrouped tab and bookmark it', async () => {
      const groups = [];
      const tabs = [
        { id: 10, windowId: 1, groupId: -1, pinned: false, url: 'https://example.com', title: 'Example' },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, status: 'gone', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const mockBookmarkTab = jest.fn().mockResolvedValue(true);
      const mockBookmarkGroupTabs = jest.fn().mockResolvedValue({ created: 0, skipped: 0, failed: 0 });
      const mockIsBookmarkableUrl = jest.fn().mockReturnValue(true);

      const goneConfig = {
        bookmarkEnabled: true,
        bookmarkFolderId: 'folder-1',
        bookmarkTab: mockBookmarkTab,
        bookmarkGroupTabs: mockBookmarkGroupTabs,
        isBookmarkableUrl: mockIsBookmarkableUrl,
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState, goneConfig);

      expect(result.goneTabsClosed).toBe(1);
      expect(mockBookmarkTab).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.remove).toHaveBeenCalledWith(10);
      expect(tabMeta[10]).toBeUndefined();
    });

    it('should close gone tab in special group and bookmark it', async () => {
      const groups = [
        { id: 50, windowId: 1, title: 'Red', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 50, pinned: false, url: 'https://example.com', title: 'Example' },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 50, status: 'gone', isSpecialGroup: true, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: 50 }, groupZones: {} },
      };

      const mockBookmarkTab = jest.fn().mockResolvedValue(true);
      const mockIsBookmarkableUrl = jest.fn().mockReturnValue(true);

      const goneConfig = {
        bookmarkEnabled: true,
        bookmarkFolderId: 'folder-1',
        bookmarkTab: mockBookmarkTab,
        bookmarkGroupTabs: jest.fn(),
        isBookmarkableUrl: mockIsBookmarkableUrl,
      };

      const result = await sortTabsAndGroups(1, tabMeta, windowState, goneConfig);

      expect(result.goneTabsClosed).toBe(1);
      expect(mockBookmarkTab).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.remove).toHaveBeenCalledWith(10);
    });

    it('should NOT close gone ungrouped tab when goneConfig is not provided', async () => {
      const groups = [];
      const tabs = [
        { id: 10, windowId: 1, groupId: -1, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, status: 'gone', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      // No goneConfig passed → gone tabs are skipped
      const result = await sortTabsAndGroups(1, tabMeta, windowState);

      expect(result.goneTabsClosed).toBe(0);
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
      expect(tabMeta[10]).toBeDefined();
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

  describe('sortTabsAndGroups – gone zone handling', () => {
    function makeGoneConfig(overrides = {}) {
      return {
        bookmarkEnabled: true,
        bookmarkFolderId: 'folder-1',
        bookmarkTab: jest.fn().mockResolvedValue(true),
        bookmarkGroupTabs: jest.fn().mockResolvedValue({ created: 1, skipped: 0, failed: 0 }),
        isBookmarkableUrl: jest.fn().mockReturnValue(true),
        ...overrides,
      };
    }

    it('should close a gone user group and bookmark it as a whole', async () => {
      // Group 5 has two tabs, both gone → group status is gone → close entire group
      const groups = [
        { id: 5, windowId: 1, title: 'OldGroup', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 5, pinned: false, url: 'https://a.com', title: 'A' },
        { id: 20, windowId: 1, groupId: 5, pinned: false, url: 'https://b.com', title: 'B' },
      ];
      mockBrowserState(tabs, groups);

      // Mock chrome.tabGroups.get for bookmarking
      chrome.tabGroups.get.mockResolvedValue({ id: 5, title: 'OldGroup', color: 'red' });
      // Mock chrome.tabs.query({ groupId: 5 }) for bookmarking
      chrome.tabs.query.mockImplementation(async (q) => {
        if (q.groupId === 5) return tabs;
        if (q.windowId) return tabs;
        return [];
      });

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 5, status: 'gone', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 5, status: 'gone', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 5: 'red' } },
      };

      const gc = makeGoneConfig();
      const result = await sortTabsAndGroups(1, tabMeta, windowState, gc);

      expect(result.goneGroupsClosed).toBe(1);
      expect(gc.bookmarkGroupTabs).toHaveBeenCalledWith('OldGroup', tabs, 'folder-1');
      expect(chrome.tabs.remove).toHaveBeenCalledWith(10);
      expect(chrome.tabs.remove).toHaveBeenCalledWith(20);
      expect(tabMeta[10]).toBeUndefined();
      expect(tabMeta[20]).toBeUndefined();
      expect(windowState[1].groupZones[5]).toBeUndefined();
    });

    it('should NOT close a group when only some tabs are gone but group is refreshed', async () => {
      // Tab 10 is gone individually, but tab 20 was refreshed (green).
      // computeGroupStatus returns 'green' → group is NOT gone.
      // Tab 10 is in a user group → skipped in phase 2 (ungrouped tab sort).
      // The group should NOT be closed.
      const groups = [
        { id: 5, windowId: 1, title: 'MyGroup', color: 'green' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 5, pinned: false },
        { id: 20, windowId: 1, groupId: 5, pinned: false },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 5, status: 'gone', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 5, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 5: 'red' } },
      };

      const gc = makeGoneConfig();
      const result = await sortTabsAndGroups(1, tabMeta, windowState, gc);

      // Group is NOT gone (freshest tab is green) → no closing
      expect(result.goneGroupsClosed).toBe(0);
      expect(result.goneTabsClosed).toBe(0);
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
      expect(tabMeta[10]).toBeDefined();
      expect(tabMeta[20]).toBeDefined();
      // Group status should be green (freshest tab)
      expect(windowState[1].groupZones[5]).toBe('green');
    });

    it('should keep tab in tabMeta when chrome.tabs.remove fails for a gone group', async () => {
      // Tab 10 closes successfully, tab 20 fails → tab 20 must stay in tabMeta
      const groups = [
        { id: 5, windowId: 1, title: 'OldGroup', color: 'red' },
      ];
      const tabs = [
        { id: 10, windowId: 1, groupId: 5, pinned: false, url: 'https://a.com', title: 'A' },
        { id: 20, windowId: 1, groupId: 5, pinned: false, url: 'https://b.com', title: 'B' },
      ];
      mockBrowserState(tabs, groups);

      chrome.tabGroups.get.mockResolvedValue({ id: 5, title: 'OldGroup', color: 'red' });
      chrome.tabs.query.mockResolvedValueOnce(tabs).mockResolvedValueOnce(tabs);
      chrome.tabs.remove
        .mockResolvedValueOnce(undefined)          // tab 10 succeeds
        .mockRejectedValueOnce(new Error('Tab is uneditable'));  // tab 20 fails

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 5, status: 'gone', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 5, status: 'gone', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: { 5: 'red' } },
      };

      const gc = makeGoneConfig();
      const result = await sortTabsAndGroups(1, tabMeta, windowState, gc);

      expect(result.goneGroupsClosed).toBe(1);
      // Tab 10 was successfully closed → removed from tabMeta
      expect(tabMeta[10]).toBeUndefined();
      // Tab 20 failed to close → must remain in tabMeta
      expect(tabMeta[20]).toBeDefined();
    });

    it('should not bookmark gone tab when bookmarking is disabled', async () => {
      const groups = [];
      const tabs = [
        { id: 10, windowId: 1, groupId: -1, pinned: false, url: 'https://example.com', title: 'Ex' },
      ];
      mockBrowserState(tabs, groups);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: null, status: 'gone', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const gc = makeGoneConfig({ bookmarkEnabled: false });
      const result = await sortTabsAndGroups(1, tabMeta, windowState, gc);

      expect(result.goneTabsClosed).toBe(1);
      expect(gc.bookmarkTab).not.toHaveBeenCalled();
      expect(chrome.tabs.remove).toHaveBeenCalledWith(10);
    });
  });
});
