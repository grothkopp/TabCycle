/**
 * Constants that define the core configuration of the TabCycle extension.
 * Every value here controls some aspect of how tabs age, transition,
 * get grouped, get bookmarked, or get stored.
 */

/** The four stages a tab passes through during its lifecycle. */
export const TAB_LIFECYCLE_STAGE = Object.freeze({
  GREEN: 'green',
  YELLOW: 'yellow',
  RED: 'red',
  GONE: 'gone',
});

/** Default time thresholds (in milliseconds) that control when tabs transition between lifecycle stages. */
export const DEFAULT_AGING_THRESHOLDS = Object.freeze({
  GREEN_TO_YELLOW: 4 * 60 * 60 * 1000,   // 4 hours
  YELLOW_TO_RED: 8 * 60 * 60 * 1000,      // 8 hours
  RED_TO_GONE: 24 * 60 * 60 * 1000,       // 24 hours
});

/** Keys used to persist extension state in chrome.storage.local. */
export const STORAGE_KEYS = Object.freeze({
  SCHEMA_VERSION: 'v1_schemaVersion',
  SETTINGS: 'v1_settings',
  ACTIVE_TIME: 'v1_activeTime',
  TAB_META: 'v1_tabMeta',
  WINDOW_STATE: 'v1_windowState',
  BOOKMARK_STATE: 'v1_bookmarkState',
});

/** Name of the Chrome alarm that triggers the periodic evaluation cycle. */
export const EVALUATION_ALARM_NAME = 'tabcycle-eval';

/** How often (in minutes) the evaluation cycle alarm fires. 0.5 = every 30 seconds. */
export const EVALUATION_INTERVAL_MINUTES = 0.5;

/** Default settings for bookmarking tabs before they are closed. */
export const DEFAULT_BOOKMARK_SETTINGS = Object.freeze({
  BOOKMARK_ENABLED: true,
  BOOKMARK_FOLDER_NAME: 'Closed Tabs',
});

/** Default settings for automatically naming unnamed tab groups. */
export const DEFAULT_AUTO_NAMING_SETTINGS = Object.freeze({
  ENABLED: true,
  DELAY_MINUTES: 5,
});

/** Whether to show each group's age as a suffix in its title (e.g. "(2h)"). */
export const DEFAULT_SHOW_AGE_IN_GROUP_TITLES = false;

/** Default on/off state for aging-related features. */
export const DEFAULT_AGING_FEATURE_TOGGLES = Object.freeze({
  AGING_ENABLED: true,
  TAB_SORTING_ENABLED: true,
  TABGROUP_SORTING_ENABLED: true,
  TABGROUP_COLORING_ENABLED: true,
});

/** Default on/off state for each lifecycle transition. Disabling an earlier transition blocks all later ones. */
export const DEFAULT_STATUS_TRANSITION_TOGGLES = Object.freeze({
  GREEN_TO_YELLOW_ENABLED: true,
  YELLOW_TO_RED_ENABLED: true,
  RED_TO_GONE_ENABLED: true,
});

/** Default titles for the extension-managed yellow and red tab groups. Empty string means no visible title. */
export const DEFAULT_MANAGED_GROUP_NAMES = Object.freeze({
  YELLOW_GROUP_NAME: '',
  RED_GROUP_NAME: '',
});

/** Default settings for automatic tab grouping behavior. */
export const DEFAULT_AUTO_GROUPING_SETTINGS = Object.freeze({
  ENABLED: true,
});

/** URLs that should never be bookmarked (empty pages, new-tab, etc). */
export const URLS_EXCLUDED_FROM_BOOKMARKING = Object.freeze([
  '',
  'chrome://newtab',
  'chrome://newtab/',
  'about:blank',
]);

/** How tab age is calculated: either from active browser usage time, or from wall-clock time. */
export const AGE_CALCULATION_MODE = Object.freeze({
  ACTIVE: 'active',
  WALL_CLOCK: 'wallclock',
});

/** Structured error codes for logging and diagnostics. */
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

/** The two types of extension-managed tab groups: yellow (aging) and red (old). */
export const MANAGED_GROUP_TYPES = Object.freeze({
  YELLOW: 'yellow',
  RED: 'red',
});
