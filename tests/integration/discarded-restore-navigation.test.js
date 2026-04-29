import { jest } from '@jest/globals';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

const store = {};
const listeners = {};

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

async function loadServiceWorker() {
  jest.resetModules();
  jest.clearAllMocks();
  for (const key of Object.keys(store)) delete store[key];
  for (const key of Object.keys(listeners)) delete listeners[key];

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
      getAll: jest.fn(async () => [{ id: 1, type: 'normal' }]),
    },
    tabs: {
      onCreated: makeEvent('tabsOnCreated'),
      onRemoved: makeEvent('tabsOnRemoved'),
      onUpdated: makeEvent('tabsOnUpdated'),
      onMoved: makeEvent('tabsOnMoved'),
      onActivated: makeEvent('tabsOnActivated'),
      onDetached: makeEvent('tabsOnDetached'),
      onAttached: makeEvent('tabsOnAttached'),
      get: jest.fn(async () => ({ id: 0, windowId: 1, groupId: -1, discarded: false, status: 'complete' })),
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

  await import('../../src/background/service-worker.js');
}

describe('discarded restore navigation integration', () => {
  it('does not reset tab age on Chrome discard/restore auto-navigation', async () => {
    await loadServiceWorker();

    const tabId = 7;
    const originalRefreshWallTime = 12345;
    store[STORAGE_KEYS.TAB_META] = {
      [tabId]: {
        tabId,
        windowId: 1,
        refreshActiveTime: 1000,
        refreshWallTime: originalRefreshWallTime,
        status: 'yellow',
        groupId: null,
        isSpecialGroup: false,
        pinned: false,
      },
    };
    store[STORAGE_KEYS.WINDOW_STATE] = {};

    const restoredTab = {
      id: tabId,
      windowId: 1,
      groupId: -1,
      pinned: false,
      discarded: false,
      status: 'loading',
    };
    globalThis.chrome.tabs.get.mockResolvedValue(restoredTab);

    await listeners.tabsOnUpdated(tabId, { discarded: false }, restoredTab);
    await listeners.webNavigationOnCommitted({ tabId, frameId: 0 });

    const updated = store[STORAGE_KEYS.TAB_META][tabId];
    expect(updated.refreshWallTime).toBe(originalRefreshWallTime);
    expect(updated.status).toBe('yellow');
  });

  it('resets tab age on a real URL change even when live-state sync updates the stored URL first', async () => {
    await loadServiceWorker();

    const tabId = 8;
    const originalRefreshWallTime = 12345;
    store[STORAGE_KEYS.TAB_META] = {
      [tabId]: {
        tabId,
        windowId: 1,
        refreshActiveTime: 1000,
        refreshWallTime: originalRefreshWallTime,
        status: 'yellow',
        groupId: null,
        isSpecialGroup: false,
        managedGroupType: null,
        pinned: false,
        url: 'https://example.com',
      },
    };
    store[STORAGE_KEYS.WINDOW_STATE] = {};

    const navigatedTab = {
      id: tabId,
      windowId: 1,
      groupId: -1,
      pinned: false,
      discarded: false,
      status: 'complete',
      url: 'https://example.org',
    };
    globalThis.chrome.tabs.get.mockResolvedValue(navigatedTab);
    globalThis.chrome.tabs.query.mockResolvedValue([navigatedTab]);

    await listeners.webNavigationOnCommitted({ tabId, frameId: 0, url: 'https://example.org' });

    const updated = store[STORAGE_KEYS.TAB_META][tabId];
    expect(updated.refreshWallTime).not.toBe(originalRefreshWallTime);
    expect(updated.refreshActiveTime).toBe(5000);
    expect(updated.status).toBe('green');
    expect(updated.url).toBe('https://example.org');
    expect(globalThis.self.__lastNavigationResetDebug).toMatchObject({
      tabId,
      source: 'onCommitted',
      outcome: 'handled',
      navigatedToUrl: 'https://example.org',
      status: 'green',
      groupId: null,
      isSpecialGroup: false,
    });
  });
});
