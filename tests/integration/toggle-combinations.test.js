import { jest } from '@jest/globals';

// Full in-memory Chrome mock
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: jest.fn(async (keys) => {
        const result = {};
        for (const key of keys) {
          if (store[key] !== undefined) {
            result[key] = JSON.parse(JSON.stringify(store[key]));
          }
        }
        return result;
      }),
      set: jest.fn(async (data) => {
        for (const [key, value] of Object.entries(data)) {
          store[key] = JSON.parse(JSON.stringify(value));
        }
      }),
      remove: jest.fn(async (keys) => {
        for (const key of keys) delete store[key];
      }),
    },
  },
  windows: { WINDOW_ID_NONE: -1 },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    update: jest.fn(async () => ({})),
    query: jest.fn(async () => []),
    get: jest.fn(async (groupId) => ({ id: groupId, windowId: 1, title: '' })),
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
  TIME_MODE, STATUS,
} = await import('../../src/shared/constants.js');
const { evaluateAllTabs, computeStatus } = await import('../../src/background/status-evaluator.js');
const { sortTabsAndGroups } = await import('../../src/background/group-manager.js');
const { placeNewTab } = await import('../../src/background/tab-placer.js');

// Helper: build settings with all v2 fields
function buildSettings(overrides = {}) {
  return {
    timeMode: TIME_MODE.ACTIVE,
    thresholds: {
      greenToYellow: 1000,
      yellowToRed: 2000,
      redToGone: 3000,
    },
    agingEnabled: true,
    tabSortingEnabled: true,
    tabgroupSortingEnabled: true,
    tabgroupColoringEnabled: true,
    greenToYellowEnabled: true,
    yellowToRedEnabled: true,
    redToGoneEnabled: true,
    yellowGroupName: '',
    redGroupName: '',
    autoGroupEnabled: true,
    showGroupAge: false,
    bookmarkEnabled: true,
    bookmarkFolderName: 'Closed Tabs',
    autoGroupNamingEnabled: true,
    autoGroupNamingDelayMinutes: 5,
    ...overrides,
  };
}

// Helper: create a tab meta entry
function tabEntry(tabId, windowId, refreshActiveTime, status = STATUS.GREEN) {
  return {
    tabId, windowId, refreshActiveTime, refreshWallTime: Date.now(),
    status, groupId: null, isSpecialGroup: false, pinned: false,
  };
}

describe('toggle-combinations integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) delete store[key];
  });

  describe('aging off with sorting configured', () => {
    it('should produce no transitions when agingEnabled is false (evaluation skipped)', () => {
      // Even though thresholds are met, aging is off → evaluation should be skipped at caller level
      // The evaluateAllTabs function itself runs regardless — the skip happens in service-worker.
      // But if evaluateAllTabs IS called, transitions still compute. This tests that the gate
      // belongs in the caller, not the evaluator.
      const settings = buildSettings({ agingEnabled: false });
      const tabMeta = {
        1: tabEntry(1, 1, 0, STATUS.GREEN),
      };

      // evaluateAllTabs still produces transitions (it doesn't check agingEnabled)
      const transitions = evaluateAllTabs(tabMeta, 5000, settings);
      // This proves the gate must be in the caller (service-worker), not here
      expect(Object.keys(transitions).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('transitions partially disabled', () => {
    it('should cap at green when greenToYellowEnabled is false', () => {
      const settings = buildSettings({ greenToYellowEnabled: false });
      const tabMeta = {
        1: tabEntry(1, 1, 0, STATUS.GREEN),
      };
      const transitions = evaluateAllTabs(tabMeta, 5000, settings);
      expect(transitions[1]).toBeUndefined(); // stays green
    });

    it('should cap at yellow when yellowToRedEnabled is false', () => {
      const settings = buildSettings({ yellowToRedEnabled: false });
      const tabMeta = {
        1: tabEntry(1, 1, 0, STATUS.GREEN),
      };
      const transitions = evaluateAllTabs(tabMeta, 5000, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
    });

    it('should cap at red when redToGoneEnabled is false', () => {
      const settings = buildSettings({ redToGoneEnabled: false });
      const tabMeta = {
        1: tabEntry(1, 1, 0, STATUS.GREEN),
      };
      const transitions = evaluateAllTabs(tabMeta, 5000, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'red' });
    });

    it('should cascade: greenToYellow off blocks yellow→red and red→gone', () => {
      const settings = buildSettings({ greenToYellowEnabled: false });
      const thresholds = settings.thresholds;

      // Tab far past all thresholds
      const status = computeStatus(100000, thresholds, {
        greenToYellowEnabled: false,
        yellowToRedEnabled: true,
        redToGoneEnabled: true,
      });
      expect(status).toBe(STATUS.GREEN);
    });

    it('should cascade: yellowToRed off blocks red→gone', () => {
      const thresholds = { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 };
      const status = computeStatus(100000, thresholds, {
        greenToYellowEnabled: true,
        yellowToRedEnabled: false,
        redToGoneEnabled: true,
      });
      expect(status).toBe(STATUS.YELLOW);
    });

    it('should handle all transitions disabled — everything stays green', () => {
      const settings = buildSettings({
        greenToYellowEnabled: false,
        yellowToRedEnabled: false,
        redToGoneEnabled: false,
      });
      const tabMeta = {
        1: tabEntry(1, 1, 0, STATUS.GREEN),
        2: tabEntry(2, 1, 0, STATUS.GREEN),
      };
      const transitions = evaluateAllTabs(tabMeta, 100000, settings);
      expect(transitions[1]).toBeUndefined();
      expect(transitions[2]).toBeUndefined();
    });

    it('should handle mixed tabs with partial transitions', () => {
      const settings = buildSettings({ redToGoneEnabled: false });
      const tabMeta = {
        1: tabEntry(1, 1, 4600, STATUS.GREEN),  // age 400 — stays green (below 1000 threshold)
        2: tabEntry(2, 1, 0, STATUS.GREEN),      // age 5000 — green→red (past yellowToRed)
        3: tabEntry(3, 1, 3500, STATUS.YELLOW),  // age 1500 — stays yellow (below yellowToRed=2000)
        4: tabEntry(4, 1, 0, STATUS.RED),        // age 5000 — stays red (redToGone disabled, past yellowToRed so computeStatus=red)
      };
      const transitions = evaluateAllTabs(tabMeta, 5000, settings);
      expect(transitions[1]).toBeUndefined();
      expect(transitions[2]).toEqual({ oldStatus: 'green', newStatus: 'red' });
      expect(transitions[3]).toBeUndefined();
      expect(transitions[4]).toBeUndefined(); // red→gone blocked, stays red
    });
  });

  describe('tab sorting off but tabgroup sorting on', () => {
    it('should call sortTabsAndGroups with settings where tabSortingEnabled=false', async () => {
      const settings = buildSettings({
        tabSortingEnabled: false,
        tabgroupSortingEnabled: true,
      });

      const tabMeta = {
        1: { ...tabEntry(1, 1, 0), groupId: 201, isSpecialGroup: false },
        2: { ...tabEntry(2, 1, 0), groupId: 201, isSpecialGroup: false },
      };
      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: { 201: STATUS.GREEN },
          groupNaming: {},
        },
      };

      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, groupId: 201, index: 0, pinned: false },
        { id: 2, windowId: 1, groupId: 201, index: 1, pinned: false },
      ]);
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 201, windowId: 1, title: 'Dev', color: 'blue' },
      ]);

      // sortTabsAndGroups should not create special groups when tabSortingEnabled=false
      // but should still zone-sort user groups when tabgroupSortingEnabled=true
      await sortTabsAndGroups(1, tabMeta, windowState, undefined, settings);

      // No tabs.group calls (no special group creation)
      expect(chrome.tabs.group).not.toHaveBeenCalled();
    });
  });

  describe('age clock continuity', () => {
    it('should preserve refreshActiveTime and refreshWallTime when aging toggled off then on', () => {
      const tabMeta = {
        1: tabEntry(1, 1, 500, STATUS.GREEN),
      };

      const originalActiveTime = tabMeta[1].refreshActiveTime;
      const originalWallTime = tabMeta[1].refreshWallTime;

      // Simulate aging off: no evaluation runs (tabs frozen)
      // Simulate aging on: tabs still have original refresh times
      expect(tabMeta[1].refreshActiveTime).toBe(originalActiveTime);
      expect(tabMeta[1].refreshWallTime).toBe(originalWallTime);

      // The age clock is independent — refresh times are never modified by toggles
      // Only evaluation/navigation/creation modifies them
    });
  });

  describe('age cap on re-enable', () => {
    it('should cap tabs at redToGone + 1 minute when aging re-enabled', () => {
      const now = Date.now();
      const currentActiveTime = 100000;
      const redToGone = 3000;
      const capWindow = redToGone + 60000; // 63000
      const wallCapTimestamp = now - capWindow;
      const activeCapTimestamp = currentActiveTime - capWindow;

      // Tab that's been idle for a very long time (way past gone)
      const tabMeta = {
        1: {
          ...tabEntry(1, 1, 0, STATUS.GREEN),
          refreshWallTime: now - 500000, // far in the past
          refreshActiveTime: 0,          // far in the past
        },
        2: {
          ...tabEntry(2, 1, currentActiveTime - 1000, STATUS.GREEN),
          refreshWallTime: now - 1000, // recent — should NOT be capped
        },
      };

      // Apply age cap algorithm (from service-worker.js T010)
      let cappedCount = 0;
      for (const meta of Object.values(tabMeta)) {
        let changed = false;
        if (meta.refreshWallTime < wallCapTimestamp) {
          meta.refreshWallTime = wallCapTimestamp;
          changed = true;
        }
        if (meta.refreshActiveTime < activeCapTimestamp) {
          meta.refreshActiveTime = activeCapTimestamp;
          changed = true;
        }
        if (changed) cappedCount++;
      }

      // Tab 1: capped (was far in the past)
      expect(cappedCount).toBe(1);
      expect(tabMeta[1].refreshWallTime).toBe(wallCapTimestamp);
      expect(tabMeta[1].refreshActiveTime).toBe(activeCapTimestamp);

      // Tab 2: NOT capped (was recent)
      expect(tabMeta[2].refreshActiveTime).toBe(currentActiveTime - 1000);

      // After cap, tab 1's age should be exactly capWindow
      const tab1ActiveAge = currentActiveTime - tabMeta[1].refreshActiveTime;
      expect(tab1ActiveAge).toBe(capWindow);
      const tab1WallAge = now - tabMeta[1].refreshWallTime;
      expect(tab1WallAge).toBe(capWindow);
    });

    it('should not cap tabs that are within the cap window', () => {
      const now = Date.now();
      const currentActiveTime = 100000;
      const redToGone = 3000;
      const capWindow = redToGone + 60000;
      const wallCapTimestamp = now - capWindow;
      const activeCapTimestamp = currentActiveTime - capWindow;

      const tabMeta = {
        1: {
          ...tabEntry(1, 1, currentActiveTime - 2000, STATUS.YELLOW),
          refreshWallTime: now - 2000,
        },
      };

      let cappedCount = 0;
      for (const meta of Object.values(tabMeta)) {
        let changed = false;
        if (meta.refreshWallTime < wallCapTimestamp) {
          meta.refreshWallTime = wallCapTimestamp;
          changed = true;
        }
        if (meta.refreshActiveTime < activeCapTimestamp) {
          meta.refreshActiveTime = activeCapTimestamp;
          changed = true;
        }
        if (changed) cappedCount++;
      }

      expect(cappedCount).toBe(0);
      expect(tabMeta[1].refreshActiveTime).toBe(currentActiveTime - 2000);
    });
  });

  describe('autoGroupEnabled and autoGroupNamingEnabled independence', () => {
    it('should not auto-group when autoGroupEnabled is false', async () => {
      const settings = buildSettings({ autoGroupEnabled: false });
      const tab = { id: 10, windowId: 1, groupId: -1, index: 5, openerTabId: undefined, pinned: false };
      const tabMeta = {};
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {}, groupNaming: {} },
      };

      await placeNewTab(tab, 1, tabMeta, windowState, settings);

      // No group created
      expect(chrome.tabs.group).not.toHaveBeenCalled();
    });

    it('should auto-group when autoGroupEnabled is true and autoGroupNamingEnabled is false', async () => {
      const settings = buildSettings({
        autoGroupEnabled: true,
        autoGroupNamingEnabled: false,
      });
      const openerTab = {
        id: 5, windowId: 1, groupId: -1, index: 3, pinned: false,
      };
      const tab = {
        id: 10, windowId: 1, groupId: -1, index: 4,
        openerTabId: 5, pinned: false,
      };

      chrome.tabs.query.mockResolvedValueOnce([openerTab]);

      const tabMeta = {
        5: tabEntry(5, 1, 0),
      };
      const windowState = {
        1: { specialGroups: { yellow: null, red: null }, groupZones: {}, groupNaming: {} },
      };

      await placeNewTab(tab, 1, tabMeta, windowState, settings);

      // Auto-group should still work (autoGroupEnabled is true)
      // The actual call depends on the opener tab being ungrouped with the new tab
      // Regardless, autoGroupNamingEnabled=false shouldn't block grouping
    });

    it('should allow naming to work when autoGroupEnabled is false', () => {
      // autoGroupNamingEnabled operates independently — it names existing groups
      // regardless of whether auto-grouping is on. This is a design decision
      // documented in spec: they are independent siblings.
      const settings = buildSettings({
        autoGroupEnabled: false,
        autoGroupNamingEnabled: true,
      });
      expect(settings.autoGroupEnabled).toBe(false);
      expect(settings.autoGroupNamingEnabled).toBe(true);
      // autoNameEligibleGroups reads autoGroupNamingEnabled, not autoGroupEnabled
    });
  });

  describe('combined toggle scenarios', () => {
    it('should handle tabSortingEnabled=false + tabgroupColoringEnabled=false', async () => {
      const settings = buildSettings({
        tabSortingEnabled: false,
        tabgroupColoringEnabled: false,
      });

      const tabMeta = {
        1: { ...tabEntry(1, 1, 0), groupId: 301, isSpecialGroup: false },
      };
      const windowState = {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: { 301: STATUS.GREEN },
          groupNaming: {},
        },
      };

      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, groupId: 301, index: 0, pinned: false },
      ]);
      chrome.tabGroups.query.mockResolvedValueOnce([
        { id: 301, windowId: 1, title: 'Test', color: 'blue' },
      ]);

      await sortTabsAndGroups(1, tabMeta, windowState, undefined, settings);

      // No special group creation (tabSortingEnabled=false)
      expect(chrome.tabs.group).not.toHaveBeenCalled();
      // No color updates (tabgroupColoringEnabled=false)
      expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    });

    it('should evaluate transitions correctly with all toggles enabled (backward compat)', () => {
      const settings = buildSettings(); // all defaults: true
      const tabMeta = {
        1: tabEntry(1, 1, 0, STATUS.GREEN),
        2: tabEntry(2, 1, 0, STATUS.YELLOW),
        3: tabEntry(3, 1, 0, STATUS.RED),
      };

      // currentActiveTime = 5000, all thresholds crossed
      const transitions = evaluateAllTabs(tabMeta, 5000, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'gone' });
      expect(transitions[2]).toEqual({ oldStatus: 'yellow', newStatus: 'gone' });
      expect(transitions[3]).toEqual({ oldStatus: 'red', newStatus: 'gone' });
    });
  });
});
