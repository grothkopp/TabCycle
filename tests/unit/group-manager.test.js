import { jest } from '@jest/globals';

// Mock chrome APIs
const mockGroups = [];
let mockGroupIdCounter = 100;
const mockTabs = [];

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
    update: jest.fn(async (groupId, props) => {
      const group = mockGroups.find((g) => g.id === groupId);
      if (group) Object.assign(group, props);
      return group;
    }),
  },
  tabs: {
    group: jest.fn(async (opts) => {
      const newId = mockGroupIdCounter++;
      mockGroups.push({ id: opts.groupId || newId, windowId: 1 });
      return opts.groupId || newId;
    }),
    ungroup: jest.fn(async () => {}),
    query: jest.fn(async (query) => {
      return mockTabs.filter((t) => {
        if (query.groupId !== undefined && t.groupId !== query.groupId) return false;
        if (query.windowId !== undefined && t.windowId !== query.windowId) return false;
        return true;
      });
    }),
    move: jest.fn(async () => {}),
  },
};

const {
  ensureSpecialGroup,
  removeSpecialGroupIfEmpty,
  isSpecialGroup,
  moveTabToSpecialGroup,
  dissolveUnnamedSingleTabGroups,
  trackExtensionGroup,
  untrackExtensionGroup,
} = await import('../../src/background/group-manager.js');

describe('group-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGroups.length = 0;
    mockTabs.length = 0;
    mockGroupIdCounter = 100;
  });

  describe('isSpecialGroup', () => {
    it('should return true for a yellow special group', () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: null }, groupZones: {} },
      };
      expect(isSpecialGroup(5, 1, windowState)).toBe(true);
    });

    it('should return true for a red special group', () => {
      const windowState = {
        1: { specialGroups: { yellow: null, red: 10 }, groupZones: {} },
      };
      expect(isSpecialGroup(10, 1, windowState)).toBe(true);
    });

    it('should return false for a non-special group', () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: 10 }, groupZones: {} },
      };
      expect(isSpecialGroup(99, 1, windowState)).toBe(false);
    });

    it('should return false when window has no state', () => {
      const windowState = {};
      expect(isSpecialGroup(5, 1, windowState)).toBe(false);
    });

    it('should return false for null groupId', () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: 10 }, groupZones: {} },
      };
      expect(isSpecialGroup(null, 1, windowState)).toBe(false);
    });
  });

  describe('ensureSpecialGroup', () => {
    it('should return existing group ID if already present', async () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: null }, groupZones: {} },
      };
      // Mock that group 5 still exists
      mockTabs.push({ id: 10, groupId: 5, windowId: 1 });

      const result = await ensureSpecialGroup(1, 'yellow', windowState);
      expect(result.groupId).toBe(5);
      expect(chrome.tabs.group).not.toHaveBeenCalled();
    });

    it('should create a new yellow group when none exists', async () => {
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };
      // Need a tab to create a group with
      chrome.tabs.group.mockResolvedValueOnce(100);

      const result = await ensureSpecialGroup(1, 'yellow', windowState, 42);
      expect(chrome.tabs.group).toHaveBeenCalled();
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, expect.objectContaining({
        title: 'Yellow',
        color: 'yellow',
      }));
      expect(result.groupId).toBe(100);
      expect(windowState[1].specialGroups.yellow).toBe(100);
    });

    it('should create a new red group when none exists', async () => {
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };
      chrome.tabs.group.mockResolvedValueOnce(101);

      const result = await ensureSpecialGroup(1, 'red', windowState, 43);
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(101, expect.objectContaining({
        title: 'Red',
        color: 'red',
      }));
      expect(result.groupId).toBe(101);
      expect(windowState[1].specialGroups.red).toBe(101);
    });
  });

  describe('removeSpecialGroupIfEmpty', () => {
    it('should remove group reference when group is empty', async () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: null }, groupZones: {} },
      };
      chrome.tabs.query.mockResolvedValueOnce([]); // no tabs in group

      const result = await removeSpecialGroupIfEmpty(1, 'yellow', windowState);
      expect(result.removed).toBe(true);
      expect(windowState[1].specialGroups.yellow).toBeNull();
    });

    it('should not remove group when it still has tabs', async () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: null }, groupZones: {} },
      };
      chrome.tabs.query.mockResolvedValueOnce([{ id: 10, groupId: 5 }]);

      const result = await removeSpecialGroupIfEmpty(1, 'yellow', windowState);
      expect(result.removed).toBe(false);
      expect(windowState[1].specialGroups.yellow).toBe(5);
    });

    it('should return early if no special group exists', async () => {
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await removeSpecialGroupIfEmpty(1, 'yellow', windowState);
      expect(result.removed).toBe(false);
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    });
  });

  describe('moveTabToSpecialGroup', () => {
    it('should move tab to existing special group', async () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: null }, groupZones: {} },
      };
      mockTabs.push({ id: 10, groupId: 5, windowId: 1 }); // group exists

      await moveTabToSpecialGroup(42, 'yellow', 1, windowState);
      expect(chrome.tabs.group).toHaveBeenCalledWith(expect.objectContaining({
        tabIds: [42],
        groupId: 5,
      }));
    });

    it('should create group first if it does not exist', async () => {
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };
      chrome.tabs.group.mockResolvedValueOnce(200); // creation call
      chrome.tabs.group.mockResolvedValueOnce(200); // move call (won't happen separately since creation includes tab)

      await moveTabToSpecialGroup(42, 'yellow', 1, windowState);
      // Should have called group at least once
      expect(chrome.tabs.group).toHaveBeenCalled();
    });
  });

  describe('dissolveUnnamedSingleTabGroups', () => {
    it('should ungroup the sole tab in an extension-created unnamed group', async () => {
      trackExtensionGroup(5);
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 5, windowId: 1, title: '', color: 'green' },
        ]),
      };
      chrome.tabs.query.mockResolvedValueOnce([{ id: 10, groupId: 5, windowId: 1 }]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 5, isSpecialGroup: false, pinned: false },
      };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(1);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith(10);
      expect(tabMeta[10].groupId).toBeNull();
    });

    it('should NOT dissolve a named group with one tab even if tracked', async () => {
      trackExtensionGroup(5);
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 5, windowId: 1, title: 'My Group', color: 'green' },
        ]),
      };

      const tabMeta = {};
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(0);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
      untrackExtensionGroup(5);
    });

    it('should NOT dissolve an unnamed group with multiple tabs', async () => {
      trackExtensionGroup(5);
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 5, windowId: 1, title: '', color: 'green' },
        ]),
      };
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 10, groupId: 5, windowId: 1 },
        { id: 11, groupId: 5, windowId: 1 },
      ]);

      const tabMeta = {};
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(0);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
      untrackExtensionGroup(5);
    });

    it('should NOT dissolve a user-created unnamed single-tab group', async () => {
      // Group 7 is NOT tracked as extension-created
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 7, windowId: 1, title: '', color: 'grey' },
        ]),
      };

      const tabMeta = {};
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(0);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it('should dissolve a group whose only title is an age suffix like "(1m)"', async () => {
      trackExtensionGroup(5);
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 5, windowId: 1, title: '(1m)', color: 'green' },
        ]),
      };
      chrome.tabs.query.mockResolvedValueOnce([{ id: 10, groupId: 5, windowId: 1 }]);

      const tabMeta = {
        10: { tabId: 10, windowId: 1, groupId: 5, isSpecialGroup: false, pinned: false },
      };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(1);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith(10);
      expect(tabMeta[10].groupId).toBeNull();
    });

    it('should dissolve a group with age suffix "(2h)" as title', async () => {
      trackExtensionGroup(6);
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 6, windowId: 1, title: '(2h)', color: 'yellow' },
        ]),
      };
      chrome.tabs.query.mockResolvedValueOnce([{ id: 11, groupId: 6, windowId: 1 }]);

      const tabMeta = {
        11: { tabId: 11, windowId: 1, groupId: 6, isSpecialGroup: false, pinned: false },
      };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(1);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith(11);
    });

    it('should NOT dissolve a named group even if it has an age suffix', async () => {
      trackExtensionGroup(5);
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 5, windowId: 1, title: 'My Group (3m)', color: 'green' },
        ]),
      };

      const tabMeta = {};
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(0);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
      untrackExtensionGroup(5);
    });

    it('should NOT dissolve special groups', async () => {
      chrome.tabGroups = {
        ...chrome.tabGroups,
        query: jest.fn(async () => [
          { id: 50, windowId: 1, title: '', color: 'yellow' },
        ]),
      };
      chrome.tabs.query.mockResolvedValueOnce([{ id: 10, groupId: 50, windowId: 1 }]);

      const tabMeta = {};
      const windowState = {
        1: { specialGroups: { yellow: 50, red: null }, groupZones: {} },
      };

      const result = await dissolveUnnamedSingleTabGroups(1, tabMeta, windowState);
      expect(result.dissolved).toBe(0);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });
  });
});
