import {
  STORAGE_KEYS,
  DEFAULT_THRESHOLDS,
  DEFAULT_BOOKMARK_SETTINGS,
  DEFAULT_AUTO_GROUP_NAMING,
  DEFAULT_SHOW_GROUP_AGE,
  DEFAULT_AGING_TOGGLES,
  DEFAULT_TRANSITION_TOGGLES,
  DEFAULT_GROUP_NAMES,
  DEFAULT_AUTO_GROUP,
  TIME_MODE,
  ERROR_CODES,
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('options');

// ─── Unit Conversion ─────────────────────────────────────────────────────────

const UNIT_TO_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

function msToFriendly(ms) {
  if (ms % UNIT_TO_MS.days === 0 && ms >= UNIT_TO_MS.days) {
    return { value: ms / UNIT_TO_MS.days, unit: 'days' };
  }
  if (ms % UNIT_TO_MS.hours === 0 && ms >= UNIT_TO_MS.hours) {
    return { value: ms / UNIT_TO_MS.hours, unit: 'hours' };
  }
  return { value: ms / UNIT_TO_MS.minutes, unit: 'minutes' };
}

function friendlyToMs(value, unit) {
  return value * (UNIT_TO_MS[unit] || UNIT_TO_MS.hours);
}

// ─── Error Display ───────────────────────────────────────────────────────────

function clearErrors() {
  document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
  document.querySelectorAll('input.invalid').forEach((el) => { el.classList.remove('invalid'); });
}

function showError(fieldId, message) {
  const errorEl = document.getElementById(`${fieldId}-error`);
  const inputEl = document.getElementById(fieldId);
  if (errorEl) errorEl.textContent = message;
  if (inputEl) inputEl.classList.add('invalid');
}

function showSaveStatus(message, isError) {
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = message;
  statusEl.classList.toggle('error-status', isError);
  statusEl.classList.add('visible');
  setTimeout(() => statusEl.classList.remove('visible'), 2500);
}

// ─── Grey-out Dependency Tree ────────────────────────────────────────────────
// Static hierarchy per data-model.md. Each key is a toggle ID, value is an
// array of child element IDs (or data-parent containers) that should be
// disabled when the toggle is unchecked.

const DEPENDENCY_TREE = {
  agingEnabled: {
    children: [
      'timeMode', 'tabSortingEnabled', 'tabgroupSortingEnabled',
      'tabgroupColoringEnabled', 'showGroupAge', 'greenToYellowEnabled',
    ],
  },
  greenToYellowEnabled: {
    parent: 'agingEnabled',
    children: ['greenToYellow', 'greenToYellowUnit', 'yellowGroupName', 'yellowToRedEnabled'],
  },
  yellowToRedEnabled: {
    parent: 'greenToYellowEnabled',
    children: ['yellowToRed', 'yellowToRedUnit', 'redGroupName', 'redToGoneEnabled'],
  },
  redToGoneEnabled: {
    parent: 'yellowToRedEnabled',
    children: ['redToGone', 'redToGoneUnit', 'bookmarkEnabled'],
  },
  bookmarkEnabled: {
    parent: 'redToGoneEnabled',
    children: ['bookmarkFolderName'],
  },
  // Auto-tab-groups section: independent siblings, no parent
  autoGroupNamingEnabled: {
    children: ['autoGroupNamingDelayMinutes'],
  },
};

/**
 * Recursively compute whether a toggle is effectively enabled
 * (its own value AND all ancestors are enabled).
 */
function isEffectivelyEnabled(toggleId) {
  const el = document.getElementById(toggleId);
  if (!el) return true;
  if (!el.checked) return false;
  const node = DEPENDENCY_TREE[toggleId];
  if (node && node.parent) {
    return isEffectivelyEnabled(node.parent);
  }
  return true;
}

/**
 * Apply grey-out state for all controls based on the dependency tree.
 * Called synchronously on any toggle change.
 */
function applyGreyOut() {
  for (const [toggleId, node] of Object.entries(DEPENDENCY_TREE)) {
    const enabled = isEffectivelyEnabled(toggleId);

    for (const childId of node.children) {
      const childEl = document.getElementById(childId);
      if (childEl) {
        childEl.disabled = !enabled;
      }
    }

    // Also disable/enable all controls within data-parent containers
    const containers = document.querySelectorAll(`[data-parent="${toggleId}"]`);
    for (const container of containers) {
      if (enabled) {
        container.classList.remove('disabled-group');
      } else {
        container.classList.add('disabled-group');
      }
      // Disable all inputs/selects within the container
      const controls = container.querySelectorAll('input, select');
      for (const ctrl of controls) {
        // Don't override if the control has its own toggle logic handled above
        if (ctrl.id && DEPENDENCY_TREE[ctrl.id]) {
          // This is a toggle — its disabled state is set by its own parent
          const ownNode = DEPENDENCY_TREE[ctrl.id];
          if (ownNode.parent) {
            ctrl.disabled = !isEffectivelyEnabled(ownNode.parent);
          } else {
            ctrl.disabled = !enabled;
          }
        } else {
          ctrl.disabled = !enabled;
        }
      }
    }
  }

  // Handle radio buttons for timeMode (they use name attribute, not id)
  const agingOn = isEffectivelyEnabled('agingEnabled');
  document.querySelectorAll('input[name="timeMode"]').forEach((r) => {
    r.disabled = !agingOn;
  });
}

// ─── Bookmark folder rename tracking ─────────────────────────────────────────
let storedBookmarkFolderId = null;
let loadedBookmarkFolderName = null;

// ─── Settings Load ───────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = result[STORAGE_KEYS.SETTINGS] || {};

    // Time mode
    const timeMode = settings.timeMode || TIME_MODE.ACTIVE;
    const timeModeRadio = document.querySelector(`input[name="timeMode"][value="${timeMode}"]`);
    if (timeModeRadio) timeModeRadio.checked = true;

    // Thresholds
    const thresholds = settings.thresholds || {
      greenToYellow: DEFAULT_THRESHOLDS.GREEN_TO_YELLOW,
      yellowToRed: DEFAULT_THRESHOLDS.YELLOW_TO_RED,
      redToGone: DEFAULT_THRESHOLDS.RED_TO_GONE,
    };
    const g2y = msToFriendly(thresholds.greenToYellow);
    document.getElementById('greenToYellow').value = g2y.value;
    document.getElementById('greenToYellowUnit').value = g2y.unit;
    const y2r = msToFriendly(thresholds.yellowToRed);
    document.getElementById('yellowToRed').value = y2r.value;
    document.getElementById('yellowToRedUnit').value = y2r.unit;
    const r2g = msToFriendly(thresholds.redToGone);
    document.getElementById('redToGone').value = r2g.value;
    document.getElementById('redToGoneUnit').value = r2g.unit;

    // v2 aging toggles
    document.getElementById('agingEnabled').checked =
      settings.agingEnabled ?? DEFAULT_AGING_TOGGLES.AGING_ENABLED;
    document.getElementById('tabSortingEnabled').checked =
      settings.tabSortingEnabled ?? DEFAULT_AGING_TOGGLES.TAB_SORTING_ENABLED;
    document.getElementById('tabgroupSortingEnabled').checked =
      settings.tabgroupSortingEnabled ?? DEFAULT_AGING_TOGGLES.TABGROUP_SORTING_ENABLED;
    document.getElementById('tabgroupColoringEnabled').checked =
      settings.tabgroupColoringEnabled ?? DEFAULT_AGING_TOGGLES.TABGROUP_COLORING_ENABLED;
    document.getElementById('showGroupAge').checked =
      settings.showGroupAge ?? DEFAULT_SHOW_GROUP_AGE;

    // v2 transition toggles
    document.getElementById('greenToYellowEnabled').checked =
      settings.greenToYellowEnabled ?? DEFAULT_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED;
    document.getElementById('yellowToRedEnabled').checked =
      settings.yellowToRedEnabled ?? DEFAULT_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED;
    document.getElementById('redToGoneEnabled').checked =
      settings.redToGoneEnabled ?? DEFAULT_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED;

    // v2 group names
    document.getElementById('yellowGroupName').value =
      settings.yellowGroupName ?? DEFAULT_GROUP_NAMES.YELLOW_GROUP_NAME;
    document.getElementById('redGroupName').value =
      settings.redGroupName ?? DEFAULT_GROUP_NAMES.RED_GROUP_NAME;

    // Bookmark settings
    document.getElementById('bookmarkEnabled').checked =
      settings.bookmarkEnabled ?? DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED;
    const bookmarkFolderName = settings.bookmarkFolderName || DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME;
    document.getElementById('bookmarkFolderName').value = bookmarkFolderName;
    loadedBookmarkFolderName = bookmarkFolderName;

    // Auto-group settings (independent siblings)
    document.getElementById('autoGroupEnabled').checked =
      settings.autoGroupEnabled ?? DEFAULT_AUTO_GROUP.ENABLED;
    document.getElementById('autoGroupNamingEnabled').checked =
      settings.autoGroupNamingEnabled ?? DEFAULT_AUTO_GROUP_NAMING.ENABLED;
    document.getElementById('autoGroupNamingDelayMinutes').value =
      (Number.isInteger(settings.autoGroupNamingDelayMinutes) && settings.autoGroupNamingDelayMinutes > 0)
        ? settings.autoGroupNamingDelayMinutes
        : DEFAULT_AUTO_GROUP_NAMING.DELAY_MINUTES;

    // Load bookmark folder ID for rename operations
    const bmState = await chrome.storage.local.get(STORAGE_KEYS.BOOKMARK_STATE);
    const bookmarkState = bmState[STORAGE_KEYS.BOOKMARK_STATE];
    storedBookmarkFolderId = bookmarkState ? bookmarkState.folderId : null;

    // Apply grey-out based on loaded toggle states
    applyGreyOut();

    logger.info('Settings loaded');
  } catch (err) {
    logger.error('Failed to load settings', { error: err.message });
    showSaveStatus('Failed to load settings', true);
  }
}

// ─── Settings Save ───────────────────────────────────────────────────────────

async function saveSettings(event) {
  event.preventDefault();
  clearErrors();

  const timeMode = document.querySelector('input[name="timeMode"]:checked')?.value || TIME_MODE.ACTIVE;

  // Read threshold values
  const g2yValue = parseFloat(document.getElementById('greenToYellow').value);
  const g2yUnit = document.getElementById('greenToYellowUnit').value;
  const y2rValue = parseFloat(document.getElementById('yellowToRed').value);
  const y2rUnit = document.getElementById('yellowToRedUnit').value;
  const r2gValue = parseFloat(document.getElementById('redToGone').value);
  const r2gUnit = document.getElementById('redToGoneUnit').value;

  let hasError = false;

  if (!g2yValue || g2yValue <= 0) {
    showError('greenToYellow', 'Must be a positive number');
    hasError = true;
  }
  if (!y2rValue || y2rValue <= 0) {
    showError('yellowToRed', 'Must be a positive number');
    hasError = true;
  }
  if (!r2gValue || r2gValue <= 0) {
    showError('redToGone', 'Must be a positive number');
    hasError = true;
  }

  if (hasError) return;

  const greenToYellow = friendlyToMs(g2yValue, g2yUnit);
  const yellowToRed = friendlyToMs(y2rValue, y2rUnit);
  const redToGone = friendlyToMs(r2gValue, r2gUnit);

  // Threshold ordering validation (enforced even when transitions are disabled)
  if (greenToYellow >= yellowToRed) {
    showError('greenToYellow', 'Must be less than Yellow → Red');
    showError('yellowToRed', 'Must be greater than Green → Yellow');
    return;
  }
  if (yellowToRed >= redToGone) {
    showError('yellowToRed', 'Must be less than Red → Gone');
    showError('redToGone', 'Must be greater than Yellow → Red');
    return;
  }

  // Auto-naming delay validation
  let autoGroupNamingDelayMinutes = Number.parseInt(
    document.getElementById('autoGroupNamingDelayMinutes').value, 10
  );
  const autoGroupNamingEnabled = document.getElementById('autoGroupNamingEnabled').checked;
  if (!Number.isInteger(autoGroupNamingDelayMinutes) || autoGroupNamingDelayMinutes <= 0) {
    if (autoGroupNamingEnabled) {
      showError('autoGroupNamingDelayMinutes', 'Must be a positive whole number');
      return;
    }
    autoGroupNamingDelayMinutes = DEFAULT_AUTO_GROUP_NAMING.DELAY_MINUTES;
  }

  // Bookmark folder name validation
  const bookmarkFolderName = document.getElementById('bookmarkFolderName').value.trim();
  if (!bookmarkFolderName) {
    showError('bookmarkFolderName', 'Folder name cannot be empty');
    return;
  }

  // Rename existing folder if name changed and folder ID is known
  if (bookmarkFolderName !== loadedBookmarkFolderName && storedBookmarkFolderId) {
    try {
      await chrome.bookmarks.update(storedBookmarkFolderId, { title: bookmarkFolderName });
      logger.info('Bookmark folder renamed', {
        oldName: loadedBookmarkFolderName,
        newName: bookmarkFolderName,
        folderId: storedBookmarkFolderId,
      });
    } catch (err) {
      logger.warn('Failed to rename bookmark folder', {
        error: err.message,
        errorCode: ERROR_CODES.ERR_BOOKMARK_RENAME,
        folderId: storedBookmarkFolderId,
      });
    }
  }

  // Collect ALL field values (including disabled/greyed-out fields)
  const settings = {
    timeMode,
    thresholds: { greenToYellow, yellowToRed, redToGone },
    // Aging toggles
    agingEnabled: document.getElementById('agingEnabled').checked,
    tabSortingEnabled: document.getElementById('tabSortingEnabled').checked,
    tabgroupSortingEnabled: document.getElementById('tabgroupSortingEnabled').checked,
    tabgroupColoringEnabled: document.getElementById('tabgroupColoringEnabled').checked,
    showGroupAge: document.getElementById('showGroupAge').checked,
    // Transition toggles
    greenToYellowEnabled: document.getElementById('greenToYellowEnabled').checked,
    yellowToRedEnabled: document.getElementById('yellowToRedEnabled').checked,
    redToGoneEnabled: document.getElementById('redToGoneEnabled').checked,
    // Group names
    yellowGroupName: document.getElementById('yellowGroupName').value,
    redGroupName: document.getElementById('redGroupName').value,
    // Bookmark
    bookmarkEnabled: document.getElementById('bookmarkEnabled').checked,
    bookmarkFolderName,
    // Auto-group (independent siblings)
    autoGroupEnabled: document.getElementById('autoGroupEnabled').checked,
    autoGroupNamingEnabled,
    autoGroupNamingDelayMinutes,
  };

  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    loadedBookmarkFolderName = bookmarkFolderName;
    showSaveStatus('Settings saved', false);
    logger.info('Settings saved');
  } catch (err) {
    logger.error('Failed to save settings', { error: err.message });
    showSaveStatus('Failed to save settings', true);
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', loadSettings);
document.getElementById('settings-form').addEventListener('submit', saveSettings);

// Wire up all toggle checkboxes that participate in grey-out
const toggleIds = Object.keys(DEPENDENCY_TREE);
for (const id of toggleIds) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', applyGreyOut);
  }
}
