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
    query: jest.fn(async (query) => (
      mockGroups.filter((g) => (query?.windowId === undefined ? true : g.windowId === query.windowId))
    )),
    get: jest.fn(async (groupId) => {
      const group = mockGroups.find((g) => g.id === groupId);
      if (!group) throw new Error(`No group with id: ${groupId}`);
      return group;
    }),
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
  parseGroupTitle,
  composeGroupTitle,
  isBaseGroupNameEmpty,
  stripAgeSuffix,
  autoNameEligibleGroups,
  applyUserEditLock,
  consumeExpectedExtensionTitleUpdate,
  trackExtensionGroup,
  untrackExtensionGroup,
} = await import('../../src/background/group-manager.js');

describe('group-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGroups.length = 0;
    mockTabs.length = 0;
    mockGroupIdCounter = 100;
    chrome.tabGroups.query = jest.fn(async (query) => (
      mockGroups.filter((g) => (query?.windowId === undefined ? true : g.windowId === query.windowId))
    ));
    chrome.tabGroups.get = jest.fn(async (groupId) => {
      const group = mockGroups.find((g) => g.id === groupId);
      if (!group) throw new Error(`No group with id: ${groupId}`);
      return group;
    });
    chrome.tabGroups.update = jest.fn(async (groupId, props) => {
      const group = mockGroups.find((g) => g.id === groupId);
      if (group) Object.assign(group, props);
      return group;
    });
    chrome.tabs.query = jest.fn(async (query) => (
      mockTabs.filter((t) => {
        if (query.groupId !== undefined && t.groupId !== query.groupId) return false;
        if (query.windowId !== undefined && t.windowId !== query.windowId) return false;
        return true;
      })
    ));
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

    it('should recreate special group when stored id is stale', async () => {
      const windowState = {
        1: { specialGroups: { yellow: 5, red: null }, groupZones: {} },
      };

      chrome.tabs.query.mockImplementation(async (query) => {
        if (query.groupId === 5) throw new Error('No group with id: 5.');
        return [];
      });
      chrome.tabs.group.mockResolvedValueOnce(200);
      chrome.tabGroups.update.mockResolvedValueOnce({ id: 200, title: 'Yellow', color: 'yellow' });

      const result = await moveTabToSpecialGroup(42, 'yellow', 1, windowState);

      expect(result).toEqual({ success: true, groupId: 200 });
      expect(windowState[1].specialGroups.yellow).toBe(200);
      expect(chrome.tabs.group).toHaveBeenCalledWith({
        tabIds: [42],
        createProperties: { windowId: 1 },
      });
      expect(chrome.tabs.group).not.toHaveBeenCalledWith(expect.objectContaining({
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

  describe('auto-name metadata and user-edit lock', () => {
    it('should set a user edit lock for unnamed groups', () => {
      const now = Date.now();
      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            7: {
              firstUnnamedSeenAt: now - 6000,
              lastAutoNamedAt: null,
              lastCandidate: null,
              userEditLockUntil: now - 1000,
            },
          },
        },
      };

      const result = applyUserEditLock(1, { id: 7, title: '(2m)' }, windowState, 15_000, now);
      expect(result.locked).toBe(true);
      expect(windowState[1].groupNaming[7].firstUnnamedSeenAt).toBe(now - 6000);
      expect(windowState[1].groupNaming[7].userEditLockUntil).toBeGreaterThan(now);
    });

    it('should clear naming metadata when group gets a base name', () => {
      const now = Date.now();
      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            8: {
              firstUnnamedSeenAt: now - 10_000,
              lastAutoNamedAt: null,
              lastCandidate: null,
              userEditLockUntil: now + 5000,
            },
          },
        },
      };

      const result = applyUserEditLock(1, { id: 8, title: 'My Group (2m)' }, windowState, 15_000, now);
      expect(result.locked).toBe(false);
      expect(windowState[1].groupNaming[8]).toBeUndefined();
    });
  });

  describe('autoNameEligibleGroups', () => {
    it('should auto-name an eligible unnamed group after delay and preserve age suffix', async () => {
      const now = Date.now();
      mockGroups.push({ id: 30, windowId: 1, title: '(6m)', color: 'green' });
      mockTabs.push(
        { id: 101, windowId: 1, groupId: 30, title: 'React Testing Library', url: 'https://react.dev/learn', pinned: false },
        { id: 102, windowId: 1, groupId: 30, title: 'React Hooks Guide', url: 'https://react.dev/reference', pinned: false }
      );

      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            30: {
              firstUnnamedSeenAt: now - (6 * 60 * 1000),
              lastAutoNamedAt: null,
              lastCandidate: null,
              userEditLockUntil: now - 1000,
            },
          },
        },
      };

      const summary = await autoNameEligibleGroups(1, {}, windowState, {
        enabled: true,
        delayMinutes: 5,
        nowMs: now,
      });

      expect(summary.named).toBe(1);
      const group = mockGroups.find((g) => g.id === 30);
      expect(group.title).toMatch(/\(\d+[mhd]\)$/);
      const baseName = stripAgeSuffix(group.title);
      expect(baseName.length).toBeGreaterThan(0);
      expect(baseName.split(/\s+/).length).toBeLessThanOrEqual(2);
    });

    it('should skip auto-naming while user edit lock is active', async () => {
      const now = Date.now();
      mockGroups.push({ id: 31, windowId: 1, title: '', color: 'green' });
      mockTabs.push(
        { id: 111, windowId: 1, groupId: 31, title: 'Kubernetes Docs', url: 'https://kubernetes.io/docs', pinned: false },
      );

      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            31: {
              firstUnnamedSeenAt: now - (10 * 60 * 1000),
              lastAutoNamedAt: null,
              lastCandidate: null,
              userEditLockUntil: now + 10_000,
            },
          },
        },
      };

      const summary = await autoNameEligibleGroups(1, {}, windowState, {
        enabled: true,
        delayMinutes: 5,
        nowMs: now,
      });

      expect(summary.named).toBe(0);
      expect(summary.skipped).toBeGreaterThan(0);
      expect(chrome.tabGroups.update).not.toHaveBeenCalledWith(31, expect.any(Object));
    });

    it('should abort if group gets a user name before write', async () => {
      const now = Date.now();
      mockGroups.push({ id: 32, windowId: 1, title: '', color: 'green' });
      mockTabs.push(
        { id: 121, windowId: 1, groupId: 32, title: 'Design Review', url: 'https://figma.com/file/abc', pinned: false },
      );

      const originalGet = chrome.tabGroups.get;
      chrome.tabGroups.get = jest.fn(async () => ({ id: 32, windowId: 1, title: 'User Name' }));

      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            32: {
              firstUnnamedSeenAt: now - (8 * 60 * 1000),
              lastAutoNamedAt: null,
              lastCandidate: null,
              userEditLockUntil: now - 1000,
            },
          },
        },
      };

      try {
        const summary = await autoNameEligibleGroups(1, {}, windowState, {
          enabled: true,
          delayMinutes: 5,
          nowMs: now,
        });

        expect(summary.named).toBe(0);
        expect(summary.skipped).toBeGreaterThan(0);
        expect(chrome.tabGroups.update).not.toHaveBeenCalledWith(32, expect.any(Object));
      } finally {
        chrome.tabGroups.get = originalGet;
      }
    });

    it('should expose extension title-update markers for user-edit filtering', async () => {
      const now = Date.now();
      mockGroups.push({ id: 33, windowId: 1, title: '', color: 'green' });
      mockTabs.push(
        { id: 131, windowId: 1, groupId: 33, title: 'Postgres Query Plans', url: 'https://postgresql.org/docs/current', pinned: false },
      );

      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            33: {
              firstUnnamedSeenAt: now - (9 * 60 * 1000),
              lastAutoNamedAt: null,
              lastCandidate: null,
              userEditLockUntil: now - 1000,
            },
          },
        },
      };

      await autoNameEligibleGroups(1, {}, windowState, {
        enabled: true,
        delayMinutes: 5,
        nowMs: now,
      });

      const group = mockGroups.find((g) => g.id === 33);
      expect(group).toBeDefined();
      expect(consumeExpectedExtensionTitleUpdate(33, group.title)).toBe(true);
      expect(consumeExpectedExtensionTitleUpdate(33, group.title)).toBe(false);
    });
  });

  describe('group title parsing and composition', () => {
    it('should parse base name and age suffix from titled groups', () => {
      expect(parseGroupTitle('News (23m)')).toEqual({ baseName: 'News', ageSuffix: '(23m)' });
    });

    it('should treat age-only title as empty base name', () => {
      expect(parseGroupTitle('(5m)')).toEqual({ baseName: '', ageSuffix: '(5m)' });
      expect(isBaseGroupNameEmpty('(5m)')).toBe(true);
    });

    it('should keep non-age titles intact', () => {
      expect(parseGroupTitle('Project Alpha')).toEqual({ baseName: 'Project Alpha', ageSuffix: '' });
      expect(isBaseGroupNameEmpty('Project Alpha')).toBe(false);
    });

    it('should compose titles deterministically from base + suffix', () => {
      expect(composeGroupTitle('News', '(2h)')).toBe('News (2h)');
      expect(composeGroupTitle('', '(2h)')).toBe('(2h)');
      expect(composeGroupTitle('News', '')).toBe('News');
    });

    it('should be idempotent for parse + compose', () => {
      const original = 'Engineering (3d)';
      const parsed = parseGroupTitle(original);
      const rebuilt = composeGroupTitle(parsed.baseName, parsed.ageSuffix);
      expect(rebuilt).toBe(original);
      expect(stripAgeSuffix(rebuilt)).toBe('Engineering');
    });
  });
});
