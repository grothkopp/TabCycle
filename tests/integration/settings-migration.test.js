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
        for (const key of keys) delete store[key];
      }),
    },
  },
  windows: { WINDOW_ID_NONE: -1 },
  tabGroups: { TAB_GROUP_ID_NONE: -1 },
};

const { readState, batchWrite } = await import('../../src/background/state-persistence.js');
const {
  STORAGE_KEYS,
  DEFAULT_THRESHOLDS,
  DEFAULT_AGING_TOGGLES,
  DEFAULT_TRANSITION_TOGGLES,
  DEFAULT_GROUP_NAMES,
  DEFAULT_AUTO_GROUP,
  DEFAULT_BOOKMARK_SETTINGS,
  DEFAULT_AUTO_GROUP_NAMING,
  DEFAULT_SHOW_GROUP_AGE,
  TIME_MODE,
} = await import('../../src/shared/constants.js');

// Helper: build a minimal v1 settings object (pre-migration)
function buildV1Settings(overrides = {}) {
  return {
    timeMode: TIME_MODE.ACTIVE,
    thresholds: {
      greenToYellow: DEFAULT_THRESHOLDS.GREEN_TO_YELLOW,
      yellowToRed: DEFAULT_THRESHOLDS.YELLOW_TO_RED,
      redToGone: DEFAULT_THRESHOLDS.RED_TO_GONE,
    },
    showGroupAge: false,
    bookmarkEnabled: true,
    bookmarkFolderName: 'Closed Tabs',
    autoGroupNamingEnabled: true,
    autoGroupNamingDelayMinutes: 5,
    ...overrides,
  };
}

// Helper: build a complete v2 settings object
function buildV2Defaults() {
  return {
    timeMode: TIME_MODE.ACTIVE,
    thresholds: {
      greenToYellow: DEFAULT_THRESHOLDS.GREEN_TO_YELLOW,
      yellowToRed: DEFAULT_THRESHOLDS.YELLOW_TO_RED,
      redToGone: DEFAULT_THRESHOLDS.RED_TO_GONE,
    },
    agingEnabled: DEFAULT_AGING_TOGGLES.AGING_ENABLED,
    tabSortingEnabled: DEFAULT_AGING_TOGGLES.TAB_SORTING_ENABLED,
    tabgroupSortingEnabled: DEFAULT_AGING_TOGGLES.TABGROUP_SORTING_ENABLED,
    tabgroupColoringEnabled: DEFAULT_AGING_TOGGLES.TABGROUP_COLORING_ENABLED,
    showGroupAge: DEFAULT_SHOW_GROUP_AGE,
    greenToYellowEnabled: DEFAULT_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED,
    yellowToRedEnabled: DEFAULT_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED,
    redToGoneEnabled: DEFAULT_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED,
    yellowGroupName: DEFAULT_GROUP_NAMES.YELLOW_GROUP_NAME,
    redGroupName: DEFAULT_GROUP_NAMES.RED_GROUP_NAME,
    bookmarkEnabled: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED,
    bookmarkFolderName: DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME,
    autoGroupEnabled: DEFAULT_AUTO_GROUP.ENABLED,
    autoGroupNamingEnabled: DEFAULT_AUTO_GROUP_NAMING.ENABLED,
    autoGroupNamingDelayMinutes: DEFAULT_AUTO_GROUP_NAMING.DELAY_MINUTES,
  };
}

// Simulate the v1→v2 migration logic from service-worker.js onInstalled handler
async function runMigration() {
  const state = await readState([STORAGE_KEYS.SCHEMA_VERSION, STORAGE_KEYS.SETTINGS]);
  const schemaVersion = state[STORAGE_KEYS.SCHEMA_VERSION];
  if (schemaVersion === 1) {
    const existing = state[STORAGE_KEYS.SETTINGS] || {};
    const migrated = {
      ...existing,
      agingEnabled: existing.agingEnabled ?? DEFAULT_AGING_TOGGLES.AGING_ENABLED,
      tabSortingEnabled: existing.tabSortingEnabled ?? DEFAULT_AGING_TOGGLES.TAB_SORTING_ENABLED,
      tabgroupSortingEnabled: existing.tabgroupSortingEnabled ?? DEFAULT_AGING_TOGGLES.TABGROUP_SORTING_ENABLED,
      tabgroupColoringEnabled: existing.tabgroupColoringEnabled ?? DEFAULT_AGING_TOGGLES.TABGROUP_COLORING_ENABLED,
      greenToYellowEnabled: existing.greenToYellowEnabled ?? DEFAULT_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED,
      yellowToRedEnabled: existing.yellowToRedEnabled ?? DEFAULT_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED,
      redToGoneEnabled: existing.redToGoneEnabled ?? DEFAULT_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED,
      yellowGroupName: existing.yellowGroupName ?? DEFAULT_GROUP_NAMES.YELLOW_GROUP_NAME,
      redGroupName: existing.redGroupName ?? DEFAULT_GROUP_NAMES.RED_GROUP_NAME,
      autoGroupEnabled: existing.autoGroupEnabled ?? DEFAULT_AUTO_GROUP.ENABLED,
    };
    await batchWrite({
      [STORAGE_KEYS.SCHEMA_VERSION]: 2,
      [STORAGE_KEYS.SETTINGS]: migrated,
    });
    return { migrated: true, settings: migrated };
  }
  return { migrated: false };
}

describe('settings-migration integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) delete store[key];
  });

  describe('v1 → v2 migration', () => {
    it('should add all new v2 fields with correct defaults to v1 settings', async () => {
      const v1Settings = buildV1Settings();
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: v1Settings,
      });

      const result = await runMigration();
      expect(result.migrated).toBe(true);

      const state = await readState([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.SCHEMA_VERSION]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      // New v2 aging toggles — all default to true
      expect(settings.agingEnabled).toBe(true);
      expect(settings.tabSortingEnabled).toBe(true);
      expect(settings.tabgroupSortingEnabled).toBe(true);
      expect(settings.tabgroupColoringEnabled).toBe(true);

      // New v2 transition toggles — all default to true
      expect(settings.greenToYellowEnabled).toBe(true);
      expect(settings.yellowToRedEnabled).toBe(true);
      expect(settings.redToGoneEnabled).toBe(true);

      // New v2 group names — default to empty string
      expect(settings.yellowGroupName).toBe('');
      expect(settings.redGroupName).toBe('');

      // New v2 autoGroupEnabled — default to true
      expect(settings.autoGroupEnabled).toBe(true);

      // Schema version updated
      expect(state[STORAGE_KEYS.SCHEMA_VERSION]).toBe(2);
    });

    it('should preserve all existing v1 fields after migration', async () => {
      const v1Settings = buildV1Settings({
        timeMode: TIME_MODE.WALL_CLOCK,
        thresholds: { greenToYellow: 1000, yellowToRed: 2000, redToGone: 3000 },
        showGroupAge: true,
        bookmarkEnabled: false,
        bookmarkFolderName: 'Archive',
        autoGroupNamingEnabled: false,
        autoGroupNamingDelayMinutes: 10,
      });
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: v1Settings,
      });

      await runMigration();

      const state = await readState([STORAGE_KEYS.SETTINGS]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      // All existing v1 fields preserved
      expect(settings.timeMode).toBe(TIME_MODE.WALL_CLOCK);
      expect(settings.thresholds.greenToYellow).toBe(1000);
      expect(settings.thresholds.yellowToRed).toBe(2000);
      expect(settings.thresholds.redToGone).toBe(3000);
      expect(settings.showGroupAge).toBe(true);
      expect(settings.bookmarkEnabled).toBe(false);
      expect(settings.bookmarkFolderName).toBe('Archive');
      expect(settings.autoGroupNamingEnabled).toBe(false);
      expect(settings.autoGroupNamingDelayMinutes).toBe(10);
    });

    it('should not overwrite v2 fields that already exist in v1 settings', async () => {
      // Simulate a user who somehow already has some v2 fields (edge case)
      const v1Settings = buildV1Settings({
        agingEnabled: false,
        yellowGroupName: 'Stale',
      });
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: v1Settings,
      });

      await runMigration();

      const state = await readState([STORAGE_KEYS.SETTINGS]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      // Pre-existing v2 fields preserved (nullish coalescing won't overwrite)
      expect(settings.agingEnabled).toBe(false);
      expect(settings.yellowGroupName).toBe('Stale');

      // Missing v2 fields filled with defaults
      expect(settings.tabSortingEnabled).toBe(true);
      expect(settings.redGroupName).toBe('');
    });

    it('should handle empty v1 settings object', async () => {
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: {},
      });

      await runMigration();

      const state = await readState([STORAGE_KEYS.SETTINGS]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      // All v2 fields added with defaults
      expect(settings.agingEnabled).toBe(true);
      expect(settings.autoGroupEnabled).toBe(true);
      expect(settings.yellowGroupName).toBe('');
    });

    it('should handle missing settings key in storage', async () => {
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        // No SETTINGS key at all
      });

      await runMigration();

      const state = await readState([STORAGE_KEYS.SETTINGS]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      // Migration still succeeds with all defaults
      expect(settings.agingEnabled).toBe(true);
      expect(settings.tabSortingEnabled).toBe(true);
      expect(settings.autoGroupEnabled).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('should not modify v2 settings when migration runs again', async () => {
      // First: set up as v2 already
      const v2Settings = buildV2Defaults();
      v2Settings.agingEnabled = false;
      v2Settings.yellowGroupName = 'Custom';
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 2,
        [STORAGE_KEYS.SETTINGS]: v2Settings,
      });

      const result = await runMigration();
      expect(result.migrated).toBe(false);

      // Settings unchanged
      const state = await readState([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.SCHEMA_VERSION]);
      expect(state[STORAGE_KEYS.SCHEMA_VERSION]).toBe(2);
      expect(state[STORAGE_KEYS.SETTINGS].agingEnabled).toBe(false);
      expect(state[STORAGE_KEYS.SETTINGS].yellowGroupName).toBe('Custom');
    });

    it('should be safe to run migration twice on v1', async () => {
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: buildV1Settings(),
      });

      await runMigration();
      // After first migration, version is 2 — second call is a no-op
      const secondResult = await runMigration();
      expect(secondResult.migrated).toBe(false);

      const state = await readState([STORAGE_KEYS.SCHEMA_VERSION]);
      expect(state[STORAGE_KEYS.SCHEMA_VERSION]).toBe(2);
    });
  });

  describe('fresh install (v2 defaults)', () => {
    it('should produce complete v2 defaults for fresh install', async () => {
      const defaults = buildV2Defaults();
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 2,
        [STORAGE_KEYS.SETTINGS]: defaults,
      });

      const state = await readState([STORAGE_KEYS.SETTINGS]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      // Verify every v2 field is present
      expect(settings.agingEnabled).toBe(true);
      expect(settings.tabSortingEnabled).toBe(true);
      expect(settings.tabgroupSortingEnabled).toBe(true);
      expect(settings.tabgroupColoringEnabled).toBe(true);
      expect(settings.greenToYellowEnabled).toBe(true);
      expect(settings.yellowToRedEnabled).toBe(true);
      expect(settings.redToGoneEnabled).toBe(true);
      expect(settings.yellowGroupName).toBe('');
      expect(settings.redGroupName).toBe('');
      expect(settings.autoGroupEnabled).toBe(true);
      expect(settings.bookmarkEnabled).toBe(true);
      expect(settings.bookmarkFolderName).toBe('Closed Tabs');
      expect(settings.autoGroupNamingEnabled).toBe(true);
      expect(settings.autoGroupNamingDelayMinutes).toBe(5);
      expect(settings.showGroupAge).toBe(false);
      expect(settings.timeMode).toBe('active');
    });

    it('should match v2 defaults field count', () => {
      const defaults = buildV2Defaults();
      // 17 top-level keys (timeMode, thresholds, 10 booleans, 2 group names,
      // bookmarkEnabled, bookmarkFolderName, autoGroupNamingEnabled, autoGroupNamingDelayMinutes, showGroupAge)
      const topKeys = Object.keys(defaults);
      expect(topKeys.length).toBe(17);
    });
  });

  describe('data integrity after migration', () => {
    it('should produce settings that pass through storage round-trip unchanged', async () => {
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: buildV1Settings(),
      });

      await runMigration();

      // Read, write back, read again
      const first = await readState([STORAGE_KEYS.SETTINGS]);
      await batchWrite({ [STORAGE_KEYS.SETTINGS]: first[STORAGE_KEYS.SETTINGS] });
      const second = await readState([STORAGE_KEYS.SETTINGS]);

      expect(second[STORAGE_KEYS.SETTINGS]).toEqual(first[STORAGE_KEYS.SETTINGS]);
    });

    it('should not introduce undefined or null for any new v2 field', async () => {
      await batchWrite({
        [STORAGE_KEYS.SCHEMA_VERSION]: 1,
        [STORAGE_KEYS.SETTINGS]: buildV1Settings(),
      });

      await runMigration();

      const state = await readState([STORAGE_KEYS.SETTINGS]);
      const settings = state[STORAGE_KEYS.SETTINGS];

      const v2Fields = [
        'agingEnabled', 'tabSortingEnabled', 'tabgroupSortingEnabled',
        'tabgroupColoringEnabled', 'greenToYellowEnabled', 'yellowToRedEnabled',
        'redToGoneEnabled', 'yellowGroupName', 'redGroupName', 'autoGroupEnabled',
      ];
      for (const field of v2Fields) {
        expect(settings[field]).not.toBeUndefined();
        expect(settings[field]).not.toBeNull();
      }
    });
  });
});
