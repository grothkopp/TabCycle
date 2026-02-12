import { jest } from '@jest/globals';

// Mock chrome with in-memory store for restart simulation
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
  tabGroups: { TAB_GROUP_ID_NONE: -1 },
};

const { STORAGE_KEYS } = await import('../../src/shared/constants.js');
const {
  initActiveTime,
  recoverActiveTime,
  handleFocusChange,
  getCurrentActiveTime,
  persistActiveTime,
} = await import('../../src/background/time-accumulator.js');
const { reconcileTabs } = await import('../../src/background/tab-tracker.js');

describe('service-worker restart integration', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) delete store[key];
    await initActiveTime();
  });

  it('should recover active time delta after simulated shutdown', async () => {
    // Simulate: user was active, then service worker shuts down
    handleFocusChange(1); // start focus
    await persistActiveTime();

    // Simulate 2 seconds passing during shutdown
    const stored = store[STORAGE_KEYS.ACTIVE_TIME];
    stored.lastPersistedAt = Date.now() - 2000;
    store[STORAGE_KEYS.ACTIVE_TIME] = stored;

    // Recover
    const recovered = await recoverActiveTime();
    expect(recovered.accumulatedMs).toBeGreaterThanOrEqual(1900);
    expect(recovered.accumulatedMs).toBeLessThanOrEqual(2200);
  });

  it('should not add delta when no window was focused before shutdown', async () => {
    await persistActiveTime();

    // Simulate time passing but focusStartTime is null
    const stored = store[STORAGE_KEYS.ACTIVE_TIME];
    stored.lastPersistedAt = Date.now() - 5000;
    store[STORAGE_KEYS.ACTIVE_TIME] = stored;

    const recovered = await recoverActiveTime();
    expect(recovered.accumulatedMs).toBe(0);
  });

  it('should reconcile tabs: retain existing, add missing, remove stale', () => {
    const storedMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 500, refreshWallTime: 1000,
        status: 'yellow', groupId: null, isSpecialGroup: false, pinned: false,
      },
      99: {
        tabId: 99, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0,
        status: 'green', groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    const chromeTabs = [
      { id: 1, windowId: 1, groupId: -1, pinned: false },
      { id: 2, windowId: 1, groupId: -1, pinned: false },
    ];

    const result = reconcileTabs(storedMeta, chromeTabs, 5000);

    // Tab 1: retained with original status
    expect(result[1].status).toBe('yellow');
    expect(result[1].refreshActiveTime).toBe(500);

    // Tab 2: added as fresh green
    expect(result[2].status).toBe('green');
    expect(result[2].refreshActiveTime).toBe(5000);

    // Tab 99: removed (not in Chrome)
    expect(result[99]).toBeUndefined();
  });

  it('should handle full recovery cycle: active time + tab reconciliation', async () => {
    // Setup: some tabs existed before shutdown
    store[STORAGE_KEYS.TAB_META] = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 100, refreshWallTime: Date.now() - 10000,
        status: 'yellow', groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    handleFocusChange(1);
    await persistActiveTime();

    // Simulate shutdown gap
    const stored = store[STORAGE_KEYS.ACTIVE_TIME];
    stored.lastPersistedAt = Date.now() - 3000;
    store[STORAGE_KEYS.ACTIVE_TIME] = stored;

    // Recover active time
    const recovered = await recoverActiveTime();
    expect(recovered.accumulatedMs).toBeGreaterThan(0);

    // Reconcile tabs
    const chromeTabs = [
      { id: 1, windowId: 1, groupId: -1, pinned: false },
      { id: 3, windowId: 2, groupId: -1, pinned: false },
    ];

    const tabMeta = store[STORAGE_KEYS.TAB_META];
    const activeTimeMs = getCurrentActiveTime();
    const reconciled = reconcileTabs(tabMeta, chromeTabs, activeTimeMs);

    expect(reconciled[1].status).toBe('yellow'); // retained
    expect(reconciled[3].status).toBe('green');   // new
    expect(reconciled[1].refreshActiveTime).toBe(100); // preserved
  });
});
