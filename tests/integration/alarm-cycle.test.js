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

const { STORAGE_KEYS, DEFAULT_THRESHOLDS, TIME_MODE, STATUS } = await import('../../src/shared/constants.js');
const { evaluateAllTabs } = await import('../../src/background/status-evaluator.js');
const { autoNameEligibleGroups } = await import('../../src/background/group-manager.js');

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

  it('should skip auto-naming before the configured delay is reached', async () => {
    const now = Date.now();
    chrome.tabGroups.query.mockResolvedValueOnce([
      { id: 401, windowId: 1, title: '' },
    ]);

    const windowState = {
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: {},
        groupNaming: {
          401: {
            firstUnnamedSeenAt: now - (4 * 60 * 1000),
            lastAutoNamedAt: null,
            lastCandidate: null,
            userEditLockUntil: now - 1000,
          },
        },
      },
    };

    const result = await autoNameEligibleGroups(1, {}, windowState, {
      enabled: true,
      delayMinutes: 5,
      nowMs: now,
    });

    expect(result.named).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });

  it('should auto-name age-only titled groups after delay with 1-2 words', async () => {
    const now = Date.now();
    chrome.tabGroups.query.mockResolvedValueOnce([
      { id: 402, windowId: 1, title: '(8m)' },
    ]);
    chrome.tabs.query.mockResolvedValueOnce([
      { id: 1, groupId: 402, title: 'React Testing Library', url: 'https://react.dev/learn', pinned: false },
      { id: 2, groupId: 402, title: 'React Hooks Guide', url: 'https://react.dev/reference', pinned: false },
    ]);
    chrome.tabGroups.get.mockResolvedValueOnce({ id: 402, windowId: 1, title: '(8m)' });

    const windowState = {
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: {},
        groupNaming: {
          402: {
            firstUnnamedSeenAt: now - (6 * 60 * 1000),
            lastAutoNamedAt: null,
            lastCandidate: null,
            userEditLockUntil: now - 1000,
          },
        },
      },
    };

    const result = await autoNameEligibleGroups(1, {}, windowState, {
      enabled: true,
      delayMinutes: 5,
      nowMs: now,
    });

    expect(result.named).toBe(1);
    const call = chrome.tabGroups.update.mock.calls.find(([groupId]) => groupId === 402);
    expect(call).toBeDefined();
    const writtenTitle = call[1].title;
    expect(writtenTitle).toMatch(/\(\d+[mhd]\)$/);
    const base = writtenTitle.replace(/\s?\(\d+[mhd]\)$/, '');
    expect(base.length).toBeGreaterThan(0);
    expect(base.split(/\s+/).length).toBeLessThanOrEqual(2);
  });

  it('should skip auto-naming when a user edit lock is active', async () => {
    const now = Date.now();
    chrome.tabGroups.query.mockResolvedValueOnce([
      { id: 403, windowId: 1, title: '' },
    ]);

    const windowState = {
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: {},
        groupNaming: {
          403: {
            firstUnnamedSeenAt: now - (10 * 60 * 1000),
            lastAutoNamedAt: null,
            lastCandidate: null,
            userEditLockUntil: now + 10_000,
          },
        },
      },
    };

    const result = await autoNameEligibleGroups(1, {}, windowState, {
      enabled: true,
      delayMinutes: 5,
      nowMs: now,
    });

    expect(result.named).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });

  it('should abort auto-naming if group becomes user-named before update', async () => {
    const now = Date.now();
    chrome.tabGroups.query.mockResolvedValueOnce([
      { id: 404, windowId: 1, title: '' },
    ]);
    chrome.tabs.query.mockResolvedValueOnce([
      { id: 11, groupId: 404, title: 'Team Notes', url: 'https://docs.example.com', pinned: false },
    ]);
    chrome.tabGroups.get.mockResolvedValueOnce({ id: 404, windowId: 1, title: 'Manual Name' });

    const windowState = {
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: {},
        groupNaming: {
          404: {
            firstUnnamedSeenAt: now - (10 * 60 * 1000),
            lastAutoNamedAt: null,
            lastCandidate: null,
            userEditLockUntil: now - 1000,
          },
        },
      },
    };

    const result = await autoNameEligibleGroups(1, {}, windowState, {
      enabled: true,
      delayMinutes: 5,
      nowMs: now,
    });

    expect(result.named).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });
});
