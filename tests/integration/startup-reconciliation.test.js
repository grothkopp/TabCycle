import { jest } from '@jest/globals';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

const store = {};
const listeners = {};
let liveTabs = [];
let liveWindows = [{ id: 1, type: 'normal' }];
let liveGroups = [];
let recoverActiveTimeAfterRestartMock;
let updateActiveTimeOnWindowFocusChangeMock;
let saveActiveTimeToStorageMock;
let getCurrentTotalActiveTimeMsMock;
let getActiveTimeSnapshotMock;

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
    greenToYellowEnabled: true,
    yellowToRedEnabled: true,
    redToGoneEnabled: true,
    showGroupAge: false,
    bookmarkEnabled: false,
    autoGroupEnabled: true,
    autoGroupNamingEnabled: true,
    autoGroupNamingDelayMinutes: 5,
    yellowGroupName: 'Yellow',
    redGroupName: 'Red',
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getSpecialGroupsForWindow(windowId, windowState) {
  return windowState?.[windowId]?.specialGroups || windowState?.[String(windowId)]?.specialGroups || {};
}

async function waitFor(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition not reached in time');
}

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
    onCreated: makeEvent('windowsOnCreated'),
    onFocusChanged: makeEvent('windowsOnFocusChanged'),
    onRemoved: makeEvent('windowsOnRemoved'),
    getAll: jest.fn(async () => liveWindows),
    getLastFocused: jest.fn(async () => ({ id: 1, focused: true })),
  },
  tabs: {
    onCreated: makeEvent('tabsOnCreated'),
    onRemoved: makeEvent('tabsOnRemoved'),
    onUpdated: makeEvent('tabsOnUpdated'),
    onMoved: makeEvent('tabsOnMoved'),
    onActivated: makeEvent('tabsOnActivated'),
    onDetached: makeEvent('tabsOnDetached'),
    onAttached: makeEvent('tabsOnAttached'),
    get: jest.fn(async (tabId) => liveTabs.find((tab) => tab.id === tabId) || {
      id: tabId,
      windowId: 1,
      groupId: -1,
      pinned: false,
      url: '',
      discarded: false,
      status: 'complete',
    }),
    query: jest.fn(async (query) => {
      if (query?.windowId !== undefined) {
        return liveTabs.filter((tab) => tab.windowId === query.windowId);
      }
      if (query?.groupId !== undefined) {
        return liveTabs.filter((tab) => tab.groupId === query.groupId);
      }
      return liveTabs;
    }),
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
    query: jest.fn(async (query) => {
      if (query?.windowId !== undefined) {
        return liveGroups.filter((group) => group.windowId === query.windowId);
      }
      return liveGroups;
    }),
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
  isManagedAgingGroup: jest.fn((groupId, windowId, windowState) => {
    const specialGroups = getSpecialGroupsForWindow(windowId, windowState);
    return specialGroups.yellow === groupId || specialGroups.red === groupId;
  }),
  getManagedGroupType: jest.fn((groupId, windowId, windowState) => {
    const specialGroups = getSpecialGroupsForWindow(windowId, windowState);
    if (specialGroups.yellow === groupId) return 'yellow';
    if (specialGroups.red === groupId) return 'red';
    return null;
  }),
  removeManagedGroupIfEmpty: jest.fn(async () => {}),
  removeTabFromItsGroup: jest.fn(async () => {}),
  sortTabsAndGroupsByLifecycleZone: jest.fn(async () => {}),
  dissolveUnnamedGroupsWithOnlyOneTab: jest.fn(async () => ({ dissolved: 0 })),
  dissolveManagedGroupsInWindow: jest.fn(async () => ({ dissolved: 0 })),
  removeAgeSuffixFromTitle: jest.fn((title) => title),
  autoNameUnnamedGroupsWhenReady: jest.fn(async () => ({ named: 0, skipped: 0, attempted: 0 })),
  lockAutoNamingAfterUserEdit: jest.fn(() => ({ locked: true, userEditLockUntil: Date.now() + 15000 })),
  acknowledgeExtensionTitleChangeIfExpected: jest.fn(() => false),
  acknowledgeExtensionColorChangeIfExpected: jest.fn(() => false),
  appendAgeToAllGroupTitles: jest.fn(async () => {}),
  removeAgeSuffixFromAllGroupTitles: jest.fn(async () => {}),
}));

await jest.unstable_mockModule('../../src/background/time-accumulator.js', () => {
  recoverActiveTimeAfterRestartMock = jest.fn(async () => {});
  updateActiveTimeOnWindowFocusChangeMock = jest.fn(async () => null);
  saveActiveTimeToStorageMock = jest.fn(async () => {});
  getCurrentTotalActiveTimeMsMock = jest.fn(async () => 5000);
  getActiveTimeSnapshotMock = jest.fn(async () => ({ accumulatedMs: 5000, focusStartTime: null }));

  return {
    initializeActiveTimeInStorage: jest.fn(async () => {}),
    recoverActiveTimeAfterRestart: recoverActiveTimeAfterRestartMock,
    updateActiveTimeOnWindowFocusChange: updateActiveTimeOnWindowFocusChangeMock,
    saveActiveTimeToStorage: saveActiveTimeToStorageMock,
    getCurrentTotalActiveTimeMs: getCurrentTotalActiveTimeMsMock,
    getActiveTimeSnapshot: getActiveTimeSnapshotMock,
  };
});

await jest.unstable_mockModule('../../src/background/tab-placer.js', () => ({
  placeNewlyCreatedTabNearItsContext: jest.fn(async () => {}),
}));

await import('../../src/background/service-worker.js');

describe('startup reconciliation integration', () => {
  beforeEach(() => {
    self.__resetServiceWorkerDebugState();
    for (const key of Object.keys(store)) delete store[key];
    liveTabs = [];
    liveWindows = [{ id: 1, type: 'normal' }];
    liveGroups = [];
    chrome.storage.local.get.mockClear();
    chrome.storage.local.set.mockClear();
    chrome.storage.local.remove.mockClear();
    chrome.alarms.create.mockClear();
    chrome.alarms.get.mockClear();
    chrome.windows.getAll.mockClear();
    chrome.windows.getLastFocused.mockClear();
    chrome.windows.getLastFocused.mockResolvedValue({ id: 1, focused: true });
    chrome.tabs.get.mockClear();
    chrome.tabs.query.mockClear();
    chrome.tabs.move.mockClear();
    chrome.tabs.group.mockClear();
    chrome.tabs.remove.mockClear();
    chrome.tabs.ungroup.mockClear();
    chrome.tabGroups.query.mockClear();
    chrome.tabGroups.update.mockClear();
    chrome.tabGroups.move.mockClear();
    recoverActiveTimeAfterRestartMock.mockClear();
    recoverActiveTimeAfterRestartMock.mockImplementation(async () => {});
    updateActiveTimeOnWindowFocusChangeMock.mockClear();
    updateActiveTimeOnWindowFocusChangeMock.mockImplementation(async () => null);
    saveActiveTimeToStorageMock.mockClear();
    getCurrentTotalActiveTimeMsMock.mockClear();
    getCurrentTotalActiveTimeMsMock.mockImplementation(async () => 5000);
    getActiveTimeSnapshotMock.mockClear();
    getActiveTimeSnapshotMock.mockImplementation(async () => ({ accumulatedMs: 5000, focusStartTime: null }));
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();
    store[STORAGE_KEYS.WINDOW_STATE] = { 1: { specialGroups: { yellow: null, red: null }, groupZones: {}, groupNaming: {} } };
  });

  it('preserves stored age/status for restored tabs created during startup', async () => {
    store[STORAGE_KEYS.TAB_META] = {
      1: {
        tabId: 1,
        windowId: 9,
        refreshActiveTime: 111,
        refreshWallTime: 222,
        status: 'yellow',
        groupId: null,
        isSpecialGroup: false,
        pinned: false,
        url: 'https://kept.example',
      },
    };

    liveTabs = [{
      id: 101,
      windowId: 1,
      groupId: -1,
      pinned: false,
      url: 'https://kept.example',
      status: 'complete',
    }];

    const startupGate = deferred();
    recoverActiveTimeAfterRestartMock.mockImplementationOnce(() => startupGate.promise);

    const startupPromise = listeners.runtimeOnStartup();
    await Promise.resolve();
    await listeners.tabsOnCreated(liveTabs[0]);

    expect(store[STORAGE_KEYS.TAB_META][101]).toBeUndefined();

    startupGate.resolve();
    await startupPromise;

    const reconciled = store[STORAGE_KEYS.TAB_META];
    expect(reconciled[101]).toMatchObject({
      tabId: 101,
      windowId: 1,
      refreshActiveTime: 111,
      refreshWallTime: 222,
      status: 'yellow',
      groupId: null,
      isSpecialGroup: false,
      pinned: false,
      url: 'https://kept.example',
    });
    expect(reconciled[1]).toBeUndefined();
  });

  it('tracks tabs created after reconciliation snapshot but before startup completes', async () => {
    store[STORAGE_KEYS.TAB_META] = {};

    const evaluationGate = deferred();
    let evaluationStarted = false;
    saveActiveTimeToStorageMock.mockImplementationOnce(async () => {
      evaluationStarted = true;
      return evaluationGate.promise;
    });

    const startupPromise = listeners.runtimeOnStartup();
    await waitFor(() => evaluationStarted || self.__evaluationCycleRunning, 100);

    const newTab = {
      id: 202,
      windowId: 1,
      groupId: -1,
      pinned: false,
      url: 'https://new.example',
      status: 'complete',
    };
    liveTabs = [newTab];

    await listeners.tabsOnCreated(newTab);
    expect(store[STORAGE_KEYS.TAB_META][202]).toBeUndefined();

    evaluationGate.resolve();
    await startupPromise;

    const tracked = store[STORAGE_KEYS.TAB_META][202];
    expect(tracked).toMatchObject({
      tabId: 202,
      windowId: 1,
      status: 'green',
      groupId: null,
      isSpecialGroup: false,
      pinned: false,
      url: 'https://new.example',
    });
    expect(tracked.refreshActiveTime).toBe(5000);
    expect(typeof tracked.refreshWallTime).toBe('number');
  });

  it('defers reconciliation until delayed restored windows arrive and remaps managed groups', async () => {
    jest.useFakeTimers();

    try {
      store[STORAGE_KEYS.TAB_META] = {
        1: {
          tabId: 1,
          windowId: 9,
          refreshActiveTime: 111,
          refreshWallTime: 222,
          status: 'yellow',
          groupId: 77,
          isSpecialGroup: true,
          pinned: false,
          url: 'https://kept.example',
        },
      };
      store[STORAGE_KEYS.WINDOW_STATE] = {
        9: {
          specialGroups: { yellow: 77, red: null },
          groupZones: { 77: 'yellow' },
          groupNaming: {},
        },
      };

      liveWindows = [];
      liveTabs = [];

      await listeners.runtimeOnStartup();

      expect(store[STORAGE_KEYS.TAB_META][1]).toMatchObject({
        refreshActiveTime: 111,
        refreshWallTime: 222,
        status: 'yellow',
        groupId: 77,
      });

      const restoredTab = {
        id: 101,
        windowId: 1,
        groupId: 501,
        pinned: false,
        url: 'https://kept.example',
        status: 'complete',
      };
      liveWindows = [{ id: 1, type: 'normal' }];
      liveTabs = [restoredTab];
      liveGroups = [{ id: 501, windowId: 1, title: 'Yellow', color: 'yellow' }];

      await listeners.tabsOnCreated(restoredTab);
      expect(store[STORAGE_KEYS.TAB_META][101]).toBeUndefined();

      await jest.advanceTimersByTimeAsync(600);

      const reconciledTabMeta = store[STORAGE_KEYS.TAB_META];
      expect(reconciledTabMeta[101]).toMatchObject({
        tabId: 101,
        windowId: 1,
        refreshActiveTime: 111,
        refreshWallTime: 222,
        status: 'yellow',
        groupId: 501,
        isSpecialGroup: true,
        managedGroupType: 'yellow',
        pinned: false,
        url: 'https://kept.example',
      });
      expect(reconciledTabMeta[1]).toBeUndefined();

      expect(store[STORAGE_KEYS.WINDOW_STATE][1]).toMatchObject({
        specialGroups: { yellow: 501, red: null },
        groupZones: { 501: 'yellow' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('self-heals missing special-group tabs from tracked peers during evaluation', async () => {
    store[STORAGE_KEYS.SETTINGS] = {
      ...defaultSettings(),
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 100000 },
    };
    store[STORAGE_KEYS.WINDOW_STATE] = {
      1: { specialGroups: { yellow: null, red: 501 }, groupZones: { 501: 'red' }, groupNaming: {} },
    };
    store[STORAGE_KEYS.TAB_META] = {
      101: {
        tabId: 101,
        windowId: 1,
        refreshActiveTime: 0,
        refreshWallTime: 100,
        status: 'red',
        groupId: 501,
        isSpecialGroup: true,
        managedGroupType: 'red',
        pinned: false,
        url: 'https://red-one.example',
      },
    };

    liveGroups = [{ id: 501, windowId: 1, title: 'Red', color: 'red' }];
    liveTabs = [
      { id: 101, windowId: 1, groupId: 501, pinned: false, url: 'https://red-one.example', status: 'complete' },
      { id: 102, windowId: 1, groupId: 501, pinned: false, url: 'https://red-two.example', status: 'complete' },
    ];

    await self.__runEvaluationCycle('test-self-heal-managed');

    expect(store[STORAGE_KEYS.TAB_META][102]).toMatchObject({
      tabId: 102,
      windowId: 1,
      refreshActiveTime: 0,
      refreshWallTime: 100,
      status: 'red',
      groupId: 501,
      isSpecialGroup: true,
      managedGroupType: 'red',
      pinned: false,
      url: 'https://red-two.example',
    });
  });

  it('self-heals grouped tabs from stored zone state and clears stale special-group ids', async () => {
    store[STORAGE_KEYS.SETTINGS] = defaultSettings();
    store[STORAGE_KEYS.WINDOW_STATE] = {
      1: {
        specialGroups: { yellow: 999, red: null },
        groupZones: { 61: 'yellow', 999: 'yellow' },
        groupNaming: {
          999: {
            firstUnnamedSeenAt: 1,
            lastAutoNamedAt: null,
            lastCandidate: null,
            userEditLockUntil: 1,
          },
        },
      },
    };
    store[STORAGE_KEYS.TAB_META] = {};

    liveGroups = [{ id: 61, windowId: 1, title: 'Work', color: 'yellow' }];
    liveTabs = [
      { id: 201, windowId: 1, groupId: 61, pinned: false, url: 'https://zone.example', status: 'complete' },
    ];

    await self.__runEvaluationCycle('test-self-heal-zone');

    expect(store[STORAGE_KEYS.TAB_META][201]).toMatchObject({
      tabId: 201,
      windowId: 1,
      status: 'yellow',
      groupId: 61,
      isSpecialGroup: false,
      managedGroupType: null,
      pinned: false,
      url: 'https://zone.example',
    });
    expect(store[STORAGE_KEYS.WINDOW_STATE][1]).toMatchObject({
      specialGroups: { yellow: null, red: null },
      groupZones: { 61: 'yellow' },
      groupNaming: {},
    });
  });
});
