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

  it('should persist auto group naming settings toggle and delay', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: {
        greenToYellow: 14400000,
        yellowToRed: 28800000,
        redToGone: 86400000,
      },
      autoGroupNamingEnabled: false,
      autoGroupNamingDelayMinutes: 9,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS].autoGroupNamingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].autoGroupNamingDelayMinutes).toBe(9);
  });

  it('should still read settings object when auto naming values are invalid', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: {
        greenToYellow: 14400000,
        yellowToRed: 28800000,
        redToGone: 86400000,
      },
      autoGroupNamingEnabled: 'yes',
      autoGroupNamingDelayMinutes: 0,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS].autoGroupNamingEnabled).toBe('yes');
    expect(result[STORAGE_KEYS.SETTINGS].autoGroupNamingDelayMinutes).toBe(0);
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

  it('should write and read windowState groupNaming metadata', async () => {
    const now = Date.now();
    const windowState = {
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: { 12: 'green' },
        groupNaming: {
          12: {
            firstUnnamedSeenAt: now,
            lastAutoNamedAt: null,
            lastCandidate: 'Dev Tools',
            userEditLockUntil: now + 1000,
          },
        },
      },
    };

    await writeState({ [STORAGE_KEYS.WINDOW_STATE]: windowState });
    const result = await readState([STORAGE_KEYS.WINDOW_STATE]);
    expect(result[STORAGE_KEYS.WINDOW_STATE]).toEqual(windowState);
  });

  it('should allow cleanup of stale groupNaming entries by overwriting windowState', async () => {
    const now = Date.now();
    await writeState({
      [STORAGE_KEYS.WINDOW_STATE]: {
        1: {
          specialGroups: { yellow: null, red: null },
          groupZones: {},
          groupNaming: {
            12: {
              firstUnnamedSeenAt: now,
              lastAutoNamedAt: null,
              lastCandidate: 'Old Entry',
              userEditLockUntil: now + 1000,
            },
          },
        },
      },
    });

    const cleanedState = {
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: {},
        groupNaming: {},
      },
    };
    await batchWrite({ [STORAGE_KEYS.WINDOW_STATE]: cleanedState });

    const result = await readState([STORAGE_KEYS.WINDOW_STATE]);
    expect(result[STORAGE_KEYS.WINDOW_STATE]).toEqual(cleanedState);
  });

  // ── v2 toggle field persistence tests ──────────────────────────────────────

  it('should persist all v2 aging toggle fields', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      agingEnabled: false,
      tabSortingEnabled: false,
      tabgroupSortingEnabled: true,
      tabgroupColoringEnabled: false,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS].agingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].tabSortingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].tabgroupSortingEnabled).toBe(true);
    expect(result[STORAGE_KEYS.SETTINGS].tabgroupColoringEnabled).toBe(false);
  });

  it('should persist all v2 transition toggle fields', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      greenToYellowEnabled: false,
      yellowToRedEnabled: true,
      redToGoneEnabled: false,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS].greenToYellowEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].yellowToRedEnabled).toBe(true);
    expect(result[STORAGE_KEYS.SETTINGS].redToGoneEnabled).toBe(false);
  });

  it('should persist v2 group name fields including empty strings', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      yellowGroupName: '',
      redGroupName: 'Urgent',
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS].yellowGroupName).toBe('');
    expect(result[STORAGE_KEYS.SETTINGS].redGroupName).toBe('Urgent');
  });

  it('should persist autoGroupEnabled toggle', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      autoGroupEnabled: false,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS].autoGroupEnabled).toBe(false);
  });

  it('should persist complete v2 settings with all toggle combinations', async () => {
    const fullSettings = {
      timeMode: 'wallclock',
      thresholds: { greenToYellow: 5000, yellowToRed: 10000, redToGone: 20000 },
      agingEnabled: false,
      tabSortingEnabled: true,
      tabgroupSortingEnabled: false,
      tabgroupColoringEnabled: true,
      showGroupAge: true,
      greenToYellowEnabled: true,
      yellowToRedEnabled: false,
      redToGoneEnabled: true,
      yellowGroupName: 'Warming Up',
      redGroupName: '',
      bookmarkEnabled: false,
      bookmarkFolderName: 'Archive',
      autoGroupEnabled: false,
      autoGroupNamingEnabled: true,
      autoGroupNamingDelayMinutes: 15,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: fullSettings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    expect(result[STORAGE_KEYS.SETTINGS]).toEqual(fullSettings);
  });

  it('should persist disabled fields even when parent toggle is off', async () => {
    // Settings where agingEnabled is false but child toggles have non-default values
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      agingEnabled: false,
      tabSortingEnabled: false,
      tabgroupSortingEnabled: false,
      tabgroupColoringEnabled: false,
      greenToYellowEnabled: false,
      yellowToRedEnabled: false,
      redToGoneEnabled: false,
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: settings });
    const result = await readState([STORAGE_KEYS.SETTINGS]);

    // All disabled child values must be preserved (not reset to defaults)
    expect(result[STORAGE_KEYS.SETTINGS].agingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].tabSortingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].tabgroupSortingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].tabgroupColoringEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].greenToYellowEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].yellowToRedEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].redToGoneEnabled).toBe(false);
  });

  it('should overwrite v2 toggle values on subsequent writes', async () => {
    const initial = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      agingEnabled: true,
      yellowGroupName: 'Old Name',
    };

    await writeState({ [STORAGE_KEYS.SETTINGS]: initial });

    const updated = {
      ...initial,
      agingEnabled: false,
      yellowGroupName: 'New Name',
    };
    await writeState({ [STORAGE_KEYS.SETTINGS]: updated });

    const result = await readState([STORAGE_KEYS.SETTINGS]);
    expect(result[STORAGE_KEYS.SETTINGS].agingEnabled).toBe(false);
    expect(result[STORAGE_KEYS.SETTINGS].yellowGroupName).toBe('New Name');
  });
});
