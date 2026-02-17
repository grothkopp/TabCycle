export const STATUS = Object.freeze({
  GREEN: 'green',
  YELLOW: 'yellow',
  RED: 'red',
  GONE: 'gone',
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  GREEN_TO_YELLOW: 4 * 60 * 60 * 1000,   // 4 hours in ms
  YELLOW_TO_RED: 8 * 60 * 60 * 1000,      // 8 hours in ms
  RED_TO_GONE: 24 * 60 * 60 * 1000,       // 24 hours in ms
});

export const STORAGE_KEYS = Object.freeze({
  SCHEMA_VERSION: 'v1_schemaVersion',
  SETTINGS: 'v1_settings',
  ACTIVE_TIME: 'v1_activeTime',
  TAB_META: 'v1_tabMeta',
  WINDOW_STATE: 'v1_windowState',
  BOOKMARK_STATE: 'v1_bookmarkState',
});

export const ALARM_NAME = 'tabcycle-eval';
export const ALARM_PERIOD_MINUTES = 0.5; // 30 seconds

export const DEFAULT_BOOKMARK_SETTINGS = Object.freeze({
  BOOKMARK_ENABLED: true,
  BOOKMARK_FOLDER_NAME: 'Closed Tabs',
});

export const DEFAULT_AUTO_GROUP_NAMING = Object.freeze({
  ENABLED: true,
  DELAY_MINUTES: 5,
});

export const DEFAULT_SHOW_GROUP_AGE = false;

export const DEFAULT_AGING_TOGGLES = Object.freeze({
  AGING_ENABLED: true,
  TAB_SORTING_ENABLED: true,
  TABGROUP_SORTING_ENABLED: true,
  TABGROUP_COLORING_ENABLED: true,
});

export const DEFAULT_TRANSITION_TOGGLES = Object.freeze({
  GREEN_TO_YELLOW_ENABLED: true,
  YELLOW_TO_RED_ENABLED: true,
  RED_TO_GONE_ENABLED: true,
});

export const DEFAULT_GROUP_NAMES = Object.freeze({
  YELLOW_GROUP_NAME: '',
  RED_GROUP_NAME: '',
});

export const DEFAULT_AUTO_GROUP = Object.freeze({
  ENABLED: true,
});

export const BOOKMARK_BLOCKED_URLS = Object.freeze([
  '',
  'chrome://newtab',
  'chrome://newtab/',
  'about:blank',
]);

export const TIME_MODE = Object.freeze({
  ACTIVE: 'active',
  WALL_CLOCK: 'wallclock',
});

export const ERROR_CODES = Object.freeze({
  ERR_STORAGE_READ: 'ERR_STORAGE_READ',
  ERR_STORAGE_WRITE: 'ERR_STORAGE_WRITE',
  ERR_GROUP_CREATE: 'ERR_GROUP_CREATE',
  ERR_GROUP_MOVE: 'ERR_GROUP_MOVE',
  ERR_TAB_MOVE: 'ERR_TAB_MOVE',
  ERR_TAB_REMOVE: 'ERR_TAB_REMOVE',
  ERR_TAB_GROUP: 'ERR_TAB_GROUP',
  ERR_ALARM_CREATE: 'ERR_ALARM_CREATE',
  ERR_SCHEMA_VALIDATION: 'ERR_SCHEMA_VALIDATION',
  ERR_RECOVERY: 'ERR_RECOVERY',
  ERR_BOOKMARK_CREATE: 'ERR_BOOKMARK_CREATE',
  ERR_BOOKMARK_FOLDER: 'ERR_BOOKMARK_FOLDER',
  ERR_BOOKMARK_RENAME: 'ERR_BOOKMARK_RENAME',
});

export const SPECIAL_GROUP_TYPES = Object.freeze({
  YELLOW: 'yellow',
  RED: 'red',
});
