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
    // ── Already sorted ───────────────────────────────────────────────

    it('should not move groups when already in correct zone order', async () => {
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

      expect(windowState[1].groupZones[1]).toBe('green');
      expect(windowState[1].groupZones[2]).toBe('yellow');
      expect(windowState[1].groupZones[3]).toBe('red');
      expect(result.moved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    // ── Out-of-order correction ──────────────────────────────────────

    it('should fix wrong order by moving all groups in desired order', async () => {
      // Visual order: red, green, yellow → wrong
      // Desired:      green, yellow, red
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'red' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'red', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      // All groups moved in desired order: green, yellow, red
      expect(result.moved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]); // green
      expect(moveCalls[1]).toEqual([3, { index: -1 }]); // yellow
      expect(moveCalls[2]).toEqual([1, { index: -1 }]); // red
    });

    // ── Intra-zone stability ─────────────────────────────────────────

    it('should NOT move groups when all are in the same zone (all green)', async () => {
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);
      expect(result.moved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should NOT move groups when all are in the same zone (all yellow)', async () => {
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);
      expect(result.moved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should NOT reorder groups that stay green after a tab refresh', async () => {
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);
      expect(result.moved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    // ── Cross-zone transitions ───────────────────────────────────────

    it('should sort a group that became green to the left of yellows', async () => {
      // Visual: [yellow:1] [yellow:2] [yellow:3]
      // Group 2 becomes green → desired: [green:2] [yellow:1] [yellow:3]
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'yellow', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      expect(windowState[1].groupZones[2]).toBe('green');
      // All groups moved in desired order: green:2, yellow:1, yellow:3
      expect(result.moved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]);
      expect(moveCalls[1]).toEqual([1, { index: -1 }]);
      expect(moveCalls[2]).toEqual([3, { index: -1 }]);
    });

    it('should sort a group that became yellow to the right of greens', async () => {
      // Visual: [green:1] [green:2] [green:3]
      // Group 2 becomes yellow → desired: [green:1] [green:3] [yellow:2]
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'green' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'green', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      expect(windowState[1].groupZones[2]).toBe('yellow');
      // All groups moved in desired order: green:1, green:3, yellow:2
      expect(result.moved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);
      expect(moveCalls[1]).toEqual([3, { index: -1 }]);
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);
    });

    it('should sort a group that became red to the far right', async () => {
      // Visual: [green:1] [green:2] [yellow:3]
      // Group 1 becomes red → desired: [green:2] [yellow:3] [red:1]
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'green' },
        { id: 3, windowId: 1, title: 'C', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'red', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 2, status: 'green', isSpecialGroup: false, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 3, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      expect(windowState[1].groupZones[1]).toBe('red');
      // All groups moved in desired order: green:2, yellow:3, red:1
      expect(result.moved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([2, { index: -1 }]);
      expect(moveCalls[1]).toEqual([3, { index: -1 }]);
      expect(moveCalls[2]).toEqual([1, { index: -1 }]);
    });

    // ── Special group handling ────────────────────────────────────────

    it('should position special Yellow at the left of the yellow zone', async () => {
      // Visual: [Yellow:50] [green:1] [yellow:2]
      // Desired: [green:1] [Yellow:50] [yellow:2]
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      // All groups moved in desired order: green:1, Yellow:50, yellow:2
      expect(result.moved).toBe(3);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);
      expect(moveCalls[1]).toEqual([50, { index: -1 }]);
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);
      // Special group does NOT get a zone assignment
      expect(windowState[1].groupZones[50]).toBeUndefined();
    });

    it('should not move special group when already at correct position', async () => {
      // Visual: [green:1] [Yellow:50] [yellow:2]  — already correct
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'yellow', isSpecialGroup: true, pinned: false },
        30: { tabId: 30, windowId: 1, groupId: 2, status: 'yellow', isSpecialGroup: false, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      expect(result.moved).toBe(0);
      expect(chrome.tabGroups.move).not.toHaveBeenCalled();
    });

    it('should position both special groups at their zone boundaries', async () => {
      // Visual: [Red:60] [Yellow:50] [green:1] [yellow:2] [red:3]
      // Desired: [green:1] [Yellow:50] [yellow:2] [Red:60] [red:3]
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 60, windowId: 1, title: 'Red', color: 'red' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 2, windowId: 1, title: 'B', color: 'yellow' },
        { id: 3, windowId: 1, title: 'C', color: 'red' },
      ]);

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

      const result = await sortGroupsIntoZones(1, tabMeta, windowState);

      // All 5 groups moved in desired order
      expect(result.moved).toBe(5);
      const moveCalls = chrome.tabGroups.move.mock.calls;
      expect(moveCalls[0]).toEqual([1, { index: -1 }]);   // green:1
      expect(moveCalls[1]).toEqual([50, { index: -1 }]);  // Yellow special
      expect(moveCalls[2]).toEqual([2, { index: -1 }]);   // yellow:2
      expect(moveCalls[3]).toEqual([60, { index: -1 }]);  // Red special
      expect(moveCalls[4]).toEqual([3, { index: -1 }]);   // red:3
    });

    it('should never change the color of a special group', async () => {
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, title: 'A', color: 'green' },
        { id: 50, windowId: 1, title: 'Yellow', color: 'yellow' },
      ]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 1, status: 'green', isSpecialGroup: false, pinned: false },
        20: { tabId: 20, windowId: 1, groupId: 50, status: 'green', isSpecialGroup: true, pinned: false },
      };

      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      await sortGroupsIntoZones(1, tabMeta, windowState);

      const updateCalls = chrome.tabGroups.update.mock.calls;
      for (const call of updateCalls) {
        expect(call[0]).not.toBe(50);
      }
    });
  });
});
