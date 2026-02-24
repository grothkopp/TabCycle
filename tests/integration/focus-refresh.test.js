import { jest } from '@jest/globals';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

const store = {};
const listeners = {};
let groupManager;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeEvent(name) {
  return {
    addListener: jest.fn((fn) => {
      listeners[name] = fn;
    }),
  };
}

function defaultSettings() {
  return {
    timeMode: 'active',
    thresholds: { greenToYellow: 4000, yellowToRed: 8000, redToGone: 24000 },
    agingEnabled: true,
    tabSortingEnabled: true,
    tabgroupSortingEnabled: true,
    tabgroupColoringEnabled: true,
  };
}

function makeTabMeta(tabId, overrides = {}) {
  return {
    tabId,
    windowId: 1,
    refreshActiveTime: 100,
    refreshWallTime: 1000,
    status: 'yellow',
    groupId: null,
    isSpecialGroup: false,
    pinned: false,
    url: 'https://example.com',
    ...overrides,
  };
}

// Load the service worker once — the Object.defineProperty calls in the service
// worker are not configurable, so re-importing would fail.
globalThis.self = globalThis;
globalThis.chrome = {
  storage: {
    local: {
      get: jest.fn(async (keys) => {
        if (typeof keys === 'string') {
          return store[keys] === undefined ? {} : { [keys]: clone(store[keys]) };
        }
        if (Array.isArray(keys)) {
          const result = {};
          for (const key of keys) {
            if (store[key] !== undefined) result[key] = clone(store[key]);
          }
          return result;
        }
        const result = {};
        for (const [key, defaultValue] of Object.entries(keys || {})) {
          result[key] = store[key] === undefined ? defaultValue : clone(store[key]);
        }
        return result;
      }),
      set: jest.fn(async (data) => {
        for (const [key, value] of Object.entries(data || {})) {
          store[key] = clone(value);
        }
      }),
      remove: jest.fn(async (keys) => {
        const toRemove = Array.isArray(keys) ? keys : [keys];
        for (const key of toRemove) delete store[key];
      }),
    },
    onChanged: makeEvent('storageOnChanged'),
  },
  runtime: {
    onInstalled: makeEvent('runtimeOnInstalled'),
    onStartup: makeEvent('runtimeOnStartup'),
  },
  alarms: {
    create: jest.fn(async () => {}),
    get: jest.fn(async () => null),
    onAlarm: makeEvent('alarmsOnAlarm'),
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: makeEvent('windowsOnFocusChanged'),
    onRemoved: makeEvent('windowsOnRemoved'),
    getAll: jest.fn(async () => []),
  },
  tabs: {
    onCreated: makeEvent('tabsOnCreated'),
    onRemoved: makeEvent('tabsOnRemoved'),
    onUpdated: makeEvent('tabsOnUpdated'),
    onMoved: makeEvent('tabsOnMoved'),
    onActivated: makeEvent('tabsOnActivated'),
    onDetached: makeEvent('tabsOnDetached'),
    onAttached: makeEvent('tabsOnAttached'),
    get: jest.fn(async () => ({ id: 0, windowId: 1, groupId: -1, discarded: false, status: 'complete', pinned: false })),
    query: jest.fn(async () => []),
    move: jest.fn(async () => {}),
    group: jest.fn(async () => 1),
    remove: jest.fn(async () => {}),
    ungroup: jest.fn(async () => {}),
    update: jest.fn(async () => {}),
    discard: jest.fn(async () => {}),
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    onRemoved: makeEvent('tabGroupsOnRemoved'),
    onUpdated: makeEvent('tabGroupsOnUpdated'),
    query: jest.fn(async () => []),
    update: jest.fn(async () => {}),
    move: jest.fn(async () => {}),
    get: jest.fn(async () => ({ id: 1, windowId: 1 })),
  },
  webNavigation: {
    onCommitted: makeEvent('webNavigationOnCommitted'),
    onHistoryStateUpdated: makeEvent('webNavigationOnHistoryStateUpdated'),
  },
};

await jest.unstable_mockModule('../../src/background/group-manager.js', () => ({
  isManagedAgingGroup: jest.fn(() => false),
  getManagedGroupType: jest.fn(() => null),
  removeManagedGroupIfEmpty: jest.fn(async () => {}),
  removeTabFromItsGroup: jest.fn(async () => {}),
  determineFreshestStatusInGroup: jest.fn(() => null),
  updateGroupColorToMatchStatus: jest.fn(async () => {}),
  sortTabsAndGroupsByLifecycleZone: jest.fn(async () => {}),
  dissolveUnnamedGroupsWithOnlyOneTab: jest.fn(async () => ({ dissolved: 0 })),
  dissolveManagedGroupsInWindow: jest.fn(async () => ({ dissolved: 0 })),
  autoNameUnnamedGroupsWhenReady: jest.fn(async () => ({ named: 0, skipped: 0, attempted: 0 })),
  lockAutoNamingAfterUserEdit: jest.fn(() => ({ locked: true, userEditLockUntil: Date.now() + 15000 })),
  acknowledgeExtensionTitleChangeIfExpected: jest.fn(() => false),
  acknowledgeExtensionColorChangeIfExpected: jest.fn(() => false),
  removeAgeSuffixFromTitle: jest.fn((title) => title),
  formatAgeAsShortString: jest.fn(() => ''),
  calculateAgeOfFreshestTabInGroup: jest.fn(() => 0),
  appendAgeToAllGroupTitles: jest.fn(async () => {}),
  removeAgeSuffixFromAllGroupTitles: jest.fn(async () => {}),
}));

await jest.unstable_mockModule('../../src/background/time-accumulator.js', () => ({
  initializeActiveTimeInStorage: jest.fn(async () => {}),
  recoverActiveTimeAfterRestart: jest.fn(async () => {}),
  updateActiveTimeOnWindowFocusChange: jest.fn(async () => null),
  saveActiveTimeToStorage: jest.fn(async () => {}),
  getCurrentTotalActiveTimeMs: jest.fn(async () => 5000),
  getActiveTimeSnapshot: jest.fn(async () => ({ accumulatedMs: 5000, focusStartTime: null })),
}));

await jest.unstable_mockModule('../../src/background/tab-placer.js', () => ({
  placeNewlyCreatedTabNearItsContext: jest.fn(async () => {}),
}));

groupManager = await import('../../src/background/group-manager.js');
await import('../../src/background/service-worker.js');

describe('focus-based refresh integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    for (const key of Object.keys(store)) delete store[key];
    // Clear call history but keep mock implementations
    chrome.tabs.get.mockClear();
    chrome.tabs.move.mockClear();
    groupManager.removeTabFromItsGroup.mockClear();
    groupManager.getManagedGroupType.mockClear();
    groupManager.getManagedGroupType.mockReturnValue(null);
    groupManager.removeManagedGroupIfEmpty.mockClear();
    groupManager.sortTabsAndGroupsByLifecycleZone.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resets tab age to green after 15 seconds of focus', async () => {
    const tabId = 5;
    store[STORAGE_KEYS.TAB_META] = { [tabId]: makeTabMeta(tabId) };
    store[STORAGE_KEYS.WINDOW_STATE] = {};
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    chrome.tabs.get.mockResolvedValue({
      id: tabId, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete',
    });

    listeners.tabsOnActivated({ tabId, windowId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    const updated = store[STORAGE_KEYS.TAB_META][tabId];
    expect(updated.status).toBe('green');
    expect(updated.refreshActiveTime).toBe(5000);
    expect(updated.refreshWallTime).toBeGreaterThan(1000);
  });

  it('refreshes a red tab back to green', async () => {
    const tabId = 7;
    store[STORAGE_KEYS.TAB_META] = {
      [tabId]: makeTabMeta(tabId, { status: 'red', refreshActiveTime: 0, refreshWallTime: 500 }),
    };
    store[STORAGE_KEYS.WINDOW_STATE] = {};
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    chrome.tabs.get.mockResolvedValue({
      id: tabId, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete',
    });

    listeners.tabsOnActivated({ tabId, windowId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    const updated = store[STORAGE_KEYS.TAB_META][tabId];
    expect(updated.status).toBe('green');
    expect(updated.refreshActiveTime).toBe(5000);
  });

  it('does not reset age when tab switches before 15 seconds', async () => {
    const tabA = 5;
    const tabB = 6;
    store[STORAGE_KEYS.TAB_META] = {
      [tabA]: makeTabMeta(tabA),
      [tabB]: makeTabMeta(tabB, { url: 'https://other.com' }),
    };
    store[STORAGE_KEYS.WINDOW_STATE] = {};
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    // Activate tab A
    listeners.tabsOnActivated({ tabId: tabA, windowId: 1 });
    // Wait only 10 seconds — not enough to trigger refresh
    await jest.advanceTimersByTimeAsync(10_000);
    // Switch to tab B — clears tab A's pending timer
    listeners.tabsOnActivated({ tabId: tabB, windowId: 1 });
    // Advance past original 15s mark — tab A's timer was already cleared
    await jest.advanceTimersByTimeAsync(5_000);

    // Tab A should NOT have been refreshed
    const updatedA = store[STORAGE_KEYS.TAB_META][tabA];
    expect(updatedA.status).toBe('yellow');
    expect(updatedA.refreshWallTime).toBe(1000);
    expect(updatedA.refreshActiveTime).toBe(100);
  });

  it('skips pinned tabs', async () => {
    const tabId = 5;
    store[STORAGE_KEYS.TAB_META] = { [tabId]: makeTabMeta(tabId, { pinned: true }) };
    store[STORAGE_KEYS.WINDOW_STATE] = {};
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    chrome.tabs.get.mockResolvedValue({
      id: tabId, windowId: 1, groupId: -1, pinned: true, discarded: false, status: 'complete',
    });

    listeners.tabsOnActivated({ tabId, windowId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    const updated = store[STORAGE_KEYS.TAB_META][tabId];
    expect(updated.status).toBe('yellow');
    expect(updated.refreshWallTime).toBe(1000);
  });

  it('skips tabs not tracked in tabMeta', async () => {
    const tabId = 99;
    store[STORAGE_KEYS.TAB_META] = {};
    store[STORAGE_KEYS.WINDOW_STATE] = {};
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    chrome.tabs.get.mockResolvedValue({
      id: tabId, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete',
    });

    listeners.tabsOnActivated({ tabId, windowId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    expect(store[STORAGE_KEYS.TAB_META]).toEqual({});
  });

  it('ungroups tab from special group on focus refresh', async () => {
    const tabId = 5;
    const specialGroupId = 50;
    store[STORAGE_KEYS.TAB_META] = {
      [tabId]: makeTabMeta(tabId, { groupId: specialGroupId, isSpecialGroup: true }),
    };
    store[STORAGE_KEYS.WINDOW_STATE] = {
      1: {
        specialGroups: { yellow: specialGroupId, red: null },
        groupZones: {},
        groupNaming: {},
      },
    };
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    chrome.tabs.get.mockResolvedValue({
      id: tabId, windowId: 1, groupId: specialGroupId, pinned: false, discarded: false, status: 'complete',
    });

    groupManager.getManagedGroupType.mockReturnValue('yellow');

    listeners.tabsOnActivated({ tabId, windowId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    const updated = store[STORAGE_KEYS.TAB_META][tabId];
    expect(updated.status).toBe('green');
    expect(updated.groupId).toBe(null);
    expect(updated.isSpecialGroup).toBe(false);
    expect(groupManager.removeTabFromItsGroup).toHaveBeenCalledWith(tabId);
    expect(chrome.tabs.move).toHaveBeenCalledWith(tabId, { index: 0 });
    expect(groupManager.removeManagedGroupIfEmpty).toHaveBeenCalled();
  });

  it('gracefully handles tab removed before timer fires', async () => {
    store[STORAGE_KEYS.TAB_META] = {};
    store[STORAGE_KEYS.WINDOW_STATE] = {};
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();

    chrome.tabs.get.mockRejectedValue(new Error('No tab with id: 5'));

    listeners.tabsOnActivated({ tabId: 5, windowId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    expect(store[STORAGE_KEYS.TAB_META]).toEqual({});
  });
});
