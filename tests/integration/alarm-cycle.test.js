import { jest } from '@jest/globals';

// Full in-memory Chrome mock for alarm cycle integration test
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

const { STORAGE_KEYS, DEFAULT_THRESHOLDS, TIME_MODE, STATUS } = await import('../../src/shared/constants.js');
const { evaluateAllTabs } = await import('../../src/background/status-evaluator.js');

describe('alarm-cycle integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) delete store[key];
  });

  it('should transition green tabs to yellow after greenToYellow threshold', () => {
    const settings = {
      timeMode: TIME_MODE.ACTIVE,
      thresholds: {
        greenToYellow: 1000,
        yellowToRed: 2000,
        redToGone: 3000,
      },
    };

    const tabMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0,
        status: STATUS.GREEN, groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    const transitions = evaluateAllTabs(tabMeta, 1500, settings);
    expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
  });

  it('should transition yellow tabs to red after yellowToRed threshold', () => {
    const settings = {
      timeMode: TIME_MODE.ACTIVE,
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
    };

    const tabMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0,
        status: STATUS.YELLOW, groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    const transitions = evaluateAllTabs(tabMeta, 2500, settings);
    expect(transitions[1]).toEqual({ oldStatus: 'yellow', newStatus: 'red' });
  });

  it('should transition red tabs to gone after redToGone threshold', () => {
    const settings = {
      timeMode: TIME_MODE.ACTIVE,
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
    };

    const tabMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0,
        status: STATUS.RED, groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    const transitions = evaluateAllTabs(tabMeta, 3500, settings);
    expect(transitions[1]).toEqual({ oldStatus: 'red', newStatus: 'gone' });
  });

  it('should not transition pinned tabs regardless of age', () => {
    const settings = {
      timeMode: TIME_MODE.ACTIVE,
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
    };

    const tabMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0,
        status: STATUS.GREEN, groupId: null, isSpecialGroup: false, pinned: true,
      },
    };

    const transitions = evaluateAllTabs(tabMeta, 100000, settings);
    expect(transitions[1]).toBeUndefined();
  });

  it('should handle multiple tabs with mixed statuses in one evaluation', () => {
    const settings = {
      timeMode: TIME_MODE.ACTIVE,
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
    };

    const tabMeta = {
      1: { tabId: 1, windowId: 1, refreshActiveTime: 500, refreshWallTime: 0, status: STATUS.GREEN, groupId: null, isSpecialGroup: false, pinned: false },
      2: { tabId: 2, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: STATUS.GREEN, groupId: null, isSpecialGroup: false, pinned: false },
      3: { tabId: 3, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: STATUS.YELLOW, groupId: null, isSpecialGroup: false, pinned: false },
    };

    const transitions = evaluateAllTabs(tabMeta, 1500, settings);
    // Tab 1: age=1000, green→yellow
    expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
    // Tab 2: age=1500, green→yellow
    expect(transitions[2]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
    // Tab 3: age=1500, yellow stays yellow (no transition)
    expect(transitions[3]).toBeUndefined();
  });

  it('should use wall clock mode when configured', () => {
    const settings = {
      timeMode: TIME_MODE.WALL_CLOCK,
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
    };

    const now = Date.now();
    const tabMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: now - 1500,
        status: STATUS.GREEN, groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    const transitions = evaluateAllTabs(tabMeta, 0, settings);
    expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
  });
});
