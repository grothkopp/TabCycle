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
  },
};

const {
  createTabEntry,
  handleNavigation,
  reconcileTabs,
} = await import('../../src/background/tab-tracker.js');

describe('tab-tracker', () => {
  describe('createTabEntry', () => {
    it('should create a green entry with correct refresh times', () => {
      const tab = { id: 1, windowId: 1, groupId: -1, pinned: false };
      const activeTimeMs = 5000;
      const now = Date.now();

      const entry = createTabEntry(tab, activeTimeMs);

      expect(entry.tabId).toBe(1);
      expect(entry.windowId).toBe(1);
      expect(entry.refreshActiveTime).toBe(5000);
      expect(entry.refreshWallTime).toBeGreaterThanOrEqual(now - 10);
      expect(entry.refreshWallTime).toBeLessThanOrEqual(now + 10);
      expect(entry.status).toBe('green');
      expect(entry.groupId).toBeNull();
      expect(entry.isSpecialGroup).toBe(false);
      expect(entry.pinned).toBe(false);
    });

    it('should set groupId when tab is in a group', () => {
      const tab = { id: 2, windowId: 1, groupId: 5, pinned: false };
      const entry = createTabEntry(tab, 0);
      expect(entry.groupId).toBe(5);
    });

    it('should mark pinned tabs', () => {
      const tab = { id: 3, windowId: 1, groupId: -1, pinned: true };
      const entry = createTabEntry(tab, 0);
      expect(entry.pinned).toBe(true);
    });
  });

  describe('handleNavigation', () => {
    it('should reset refresh times and set status to green', () => {
      const existing = {
        tabId: 1,
        windowId: 1,
        refreshActiveTime: 1000,
        refreshWallTime: 1000,
        status: 'yellow',
        groupId: null,
        isSpecialGroup: false,
        pinned: false,
      };
      const activeTimeMs = 5000;
      const now = Date.now();

      const updated = handleNavigation(existing, activeTimeMs);

      expect(updated.refreshActiveTime).toBe(5000);
      expect(updated.refreshWallTime).toBeGreaterThanOrEqual(now - 10);
      expect(updated.status).toBe('green');
      // Other fields should be unchanged
      expect(updated.tabId).toBe(1);
      expect(updated.windowId).toBe(1);
    });

    it('should reset a red tab back to green on navigation', () => {
      const existing = {
        tabId: 5,
        windowId: 2,
        refreshActiveTime: 0,
        refreshWallTime: 0,
        status: 'red',
        groupId: 10,
        isSpecialGroup: true,
        pinned: false,
      };

      const updated = handleNavigation(existing, 50000);
      expect(updated.status).toBe('green');
      expect(updated.refreshActiveTime).toBe(50000);
    });
  });

  describe('reconcileTabs', () => {
    it('should retain existing tabs that are still in Chrome', () => {
      const storedMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 1000, refreshWallTime: 1000, status: 'yellow', groupId: null, isSpecialGroup: false, pinned: false },
      };
      const chromeTabs = [
        { id: 1, windowId: 1, groupId: -1, pinned: false },
      ];

      const result = reconcileTabs(storedMeta, chromeTabs, 5000);
      expect(result[1].status).toBe('yellow');
      expect(result[1].refreshActiveTime).toBe(1000);
    });

    it('should add new tabs as fresh green', () => {
      const storedMeta = {};
      const chromeTabs = [
        { id: 2, windowId: 1, groupId: -1, pinned: false },
      ];

      const result = reconcileTabs(storedMeta, chromeTabs, 5000);
      expect(result[2].status).toBe('green');
      expect(result[2].refreshActiveTime).toBe(5000);
    });

    it('should remove stale entries not in Chrome', () => {
      const storedMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', groupId: null, isSpecialGroup: false, pinned: false },
        99: { tabId: 99, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', groupId: null, isSpecialGroup: false, pinned: false },
      };
      const chromeTabs = [
        { id: 1, windowId: 1, groupId: -1, pinned: false },
      ];

      const result = reconcileTabs(storedMeta, chromeTabs, 5000);
      expect(result[1]).toBeDefined();
      expect(result[99]).toBeUndefined();
    });

    it('should skip pinned tabs', () => {
      const storedMeta = {};
      const chromeTabs = [
        { id: 1, windowId: 1, groupId: -1, pinned: true },
      ];

      const result = reconcileTabs(storedMeta, chromeTabs, 0);
      expect(result[1]).toBeUndefined();
    });

    it('should update windowId and groupId for existing tabs', () => {
      const storedMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 1000, refreshWallTime: 1000, status: 'yellow', groupId: null, isSpecialGroup: false, pinned: false },
      };
      const chromeTabs = [
        { id: 1, windowId: 2, groupId: 5, pinned: false },
      ];

      const result = reconcileTabs(storedMeta, chromeTabs, 5000);
      expect(result[1].windowId).toBe(2);
      expect(result[1].groupId).toBe(5);
      // But preserve refresh times and status
      expect(result[1].status).toBe('yellow');
      expect(result[1].refreshActiveTime).toBe(1000);
    });
  });
});
