import { jest } from '@jest/globals';

// Mock chrome.storage.local with a real in-memory store
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
        for (const key of keys) {
          delete store[key];
        }
      }),
    },
  },
  windows: { WINDOW_ID_NONE: -1 },
  tabGroups: { TAB_GROUP_ID_NONE: -1 },
};

const { readState, writeState, batchWrite, removeKeys } = await import('../../src/background/state-persistence.js');
const { STORAGE_KEYS } = await import('../../src/shared/constants.js');

describe('storage-persistence integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) delete store[key];
  });

  it('should write and read back valid settings', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: {
        greenToYellow: 14400000,
        yellowToRed: 28800000,
        redToGone: 86400000,
      },
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS]).toEqual(settings);
  });

  it('should write and read back active time state', async () => {
    const activeTime = {
      accumulatedMs: 12345,
      focusStartTime: null,
      lastPersistedAt: Date.now(),
    };

    await writeState({ [STORAGE_KEYS.ACTIVE_TIME]: activeTime });
    const result = await readState([STORAGE_KEYS.ACTIVE_TIME]);

    expect(result[STORAGE_KEYS.ACTIVE_TIME].accumulatedMs).toBe(12345);
    expect(result[STORAGE_KEYS.ACTIVE_TIME].focusStartTime).toBeNull();
  });

  it('should batch write multiple keys atomically', async () => {
    const settings = {
      timeMode: 'wallclock',
      thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
    };
    const tabMeta = {
      1: {
        tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: Date.now(),
        status: 'green', groupId: null, isSpecialGroup: false, pinned: false,
      },
    };

    await batchWrite({
      [STORAGE_KEYS.SETTINGS]: settings,
      [STORAGE_KEYS.TAB_META]: tabMeta,
    });

    const result = await readState([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.TAB_META]);
    expect(result[STORAGE_KEYS.SETTINGS].timeMode).toBe('wallclock');
    expect(result[STORAGE_KEYS.TAB_META][1].tabId).toBe(1);
  });

  it('should handle reading non-existent keys gracefully', async () => {
    const result = await readState([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.TAB_META]);
    expect(result[STORAGE_KEYS.SETTINGS]).toBeUndefined();
    expect(result[STORAGE_KEYS.TAB_META]).toBeUndefined();
  });

  it('should remove keys from storage', async () => {
    await writeState({ [STORAGE_KEYS.TAB_META]: { 1: { tabId: 1 } } });
    await removeKeys([STORAGE_KEYS.TAB_META]);
    const result = await readState([STORAGE_KEYS.TAB_META]);
    expect(result[STORAGE_KEYS.TAB_META]).toBeUndefined();
  });

  it('should warn on invalid data read but still return it', async () => {
    store[STORAGE_KEYS.SETTINGS] = { timeMode: 'invalid' };
    const result = await readState([STORAGE_KEYS.SETTINGS]);
    expect(result[STORAGE_KEYS.SETTINGS].timeMode).toBe('invalid');
  });

  it('should skip batchWrite for empty changes', async () => {
    await batchWrite({});
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('should handle overwriting existing data', async () => {
    await writeState({ [STORAGE_KEYS.SCHEMA_VERSION]: 1 });
    await writeState({ [STORAGE_KEYS.SCHEMA_VERSION]: 2 });
    const result = await readState([STORAGE_KEYS.SCHEMA_VERSION]);
    expect(result[STORAGE_KEYS.SCHEMA_VERSION]).toBe(2);
  });
});
