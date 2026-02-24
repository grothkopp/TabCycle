/**
 * Options page for the TabCycle extension.
 *
 * Loads user settings from chrome.storage.local into the form, validates
 * user input when saving, and manages the grey-out dependency tree that
 * disables child controls when a parent toggle is unchecked.
 */

import {
  STORAGE_KEYS,
  DEFAULT_AGING_THRESHOLDS,
  DEFAULT_BOOKMARK_SETTINGS,
  DEFAULT_AUTO_NAMING_SETTINGS,
  DEFAULT_SHOW_AGE_IN_GROUP_TITLES,
  DEFAULT_AGING_FEATURE_TOGGLES,
  DEFAULT_STATUS_TRANSITION_TOGGLES,
  DEFAULT_MANAGED_GROUP_NAMES,
  DEFAULT_AUTO_GROUPING_SETTINGS,
  AGE_CALCULATION_MODE,
  ERROR_CODES,
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('options');

// ─── Unit Conversion ─────────────────────────────────────────────────────────

/** Maps human-readable time unit names to their equivalent in milliseconds. */
const MILLISECONDS_PER_TIME_UNIT = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Converts a duration in milliseconds to the largest whole unit (days, hours, or minutes).
 *
 * @param {number} milliseconds - Duration in milliseconds
 * @returns {{ value: number, unit: string }} The converted value and its unit name
 */
function convertMillisecondsToHumanReadable(milliseconds) {
  if (milliseconds % MILLISECONDS_PER_TIME_UNIT.days === 0 && milliseconds >= MILLISECONDS_PER_TIME_UNIT.days) {
    return { value: milliseconds / MILLISECONDS_PER_TIME_UNIT.days, unit: 'days' };
  }
  if (milliseconds % MILLISECONDS_PER_TIME_UNIT.hours === 0 && milliseconds >= MILLISECONDS_PER_TIME_UNIT.hours) {
    return { value: milliseconds / MILLISECONDS_PER_TIME_UNIT.hours, unit: 'hours' };
  }
  return { value: milliseconds / MILLISECONDS_PER_TIME_UNIT.minutes, unit: 'minutes' };
}

/**
 * Converts a human-readable value + unit back to milliseconds.
 *
 * @param {number} value - The numeric value entered by the user
 * @param {string} unit - One of "minutes", "hours", or "days"
 * @returns {number} Equivalent duration in milliseconds
 */
function convertHumanReadableToMilliseconds(value, unit) {
  return value * (MILLISECONDS_PER_TIME_UNIT[unit] || MILLISECONDS_PER_TIME_UNIT.hours);
}

// ─── Error Display ───────────────────────────────────────────────────────────

/** Removes all visible validation errors and "invalid" styling from the form. */
function clearAllValidationErrors() {
  document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
  document.querySelectorAll('input.invalid').forEach((el) => { el.classList.remove('invalid'); });
}

/**
 * Shows a validation error message next to a specific form field.
 *
 * @param {string} fieldId - The DOM ID of the input field with the error
 * @param {string} message - The error message to display
 */
function showValidationErrorForField(fieldId, message) {
  const errorElement = document.getElementById(`${fieldId}-error`);
  const inputElement = document.getElementById(fieldId);
  if (errorElement) errorElement.textContent = message;
  if (inputElement) inputElement.classList.add('invalid');
}

/**
 * Briefly shows a status banner at the bottom of the form (e.g. "Settings saved").
 *
 * @param {string} message - The status message to display
 * @param {boolean} isError - True to style the message as an error
 */
function showTemporarySaveStatusBanner(message, isError) {
  const statusElement = document.getElementById('save-status');
  statusElement.textContent = message;
  statusElement.classList.toggle('error-status', isError);
  statusElement.classList.add('visible');
  setTimeout(() => statusElement.classList.remove('visible'), 2500);
}

// ─── Grey-out Dependency Tree ────────────────────────────────────────────────
// Static hierarchy per data-model.md. Each key is a toggle ID, value is an
// object describing which child controls should be disabled when the toggle
// is unchecked, and which parent toggle must also be checked.

const SETTINGS_TOGGLE_DEPENDENCY_TREE = {
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
 * Recursively checks whether a toggle and all of its ancestor toggles are checked.
 * A toggle is "effectively enabled" only if it's checked AND every parent up the
 * tree is also checked.
 *
 * @param {string} toggleId - The DOM ID of the checkbox toggle to check
 * @returns {boolean} True if the toggle and all ancestors are checked
 */
function isToggleAndAllAncestorsChecked(toggleId) {
  const checkboxElement = document.getElementById(toggleId);
  if (!checkboxElement) return true;
  if (!checkboxElement.checked) return false;
  const treeNode = SETTINGS_TOGGLE_DEPENDENCY_TREE[toggleId];
  if (treeNode && treeNode.parent) {
    return isToggleAndAllAncestorsChecked(treeNode.parent);
  }
  return true;
}

/**
 * Walks the dependency tree and disables/enables all child controls based on
 * whether their parent toggle (and its ancestors) are checked.
 * Called synchronously whenever any toggle checkbox changes.
 */
function disableControlsDependingOnUncheckedToggles() {
  for (const [toggleId, treeNode] of Object.entries(SETTINGS_TOGGLE_DEPENDENCY_TREE)) {
    const toggleIsEffectivelyEnabled = isToggleAndAllAncestorsChecked(toggleId);

    for (const childId of treeNode.children) {
      const childElement = document.getElementById(childId);
      if (childElement) {
        childElement.disabled = !toggleIsEffectivelyEnabled;
      }
    }

    // Also disable/enable all controls within data-parent containers
    const parentContainers = document.querySelectorAll(`[data-parent="${toggleId}"]`);
    for (const container of parentContainers) {
      if (toggleIsEffectivelyEnabled) {
        container.classList.remove('disabled-group');
      } else {
        container.classList.add('disabled-group');
      }
      // Disable all inputs/selects within the container
      const formControlsInContainer = container.querySelectorAll('input, select');
      for (const control of formControlsInContainer) {
        // Don't override if the control has its own toggle logic handled above
        if (control.id && SETTINGS_TOGGLE_DEPENDENCY_TREE[control.id]) {
          // This is a toggle — its disabled state is set by its own parent
          const ownTreeNode = SETTINGS_TOGGLE_DEPENDENCY_TREE[control.id];
          if (ownTreeNode.parent) {
            control.disabled = !isToggleAndAllAncestorsChecked(ownTreeNode.parent);
          } else {
            control.disabled = !toggleIsEffectivelyEnabled;
          }
        } else {
          control.disabled = !toggleIsEffectivelyEnabled;
        }
      }
    }
  }

  // Handle radio buttons for timeMode (they use name attribute, not id)
  const agingIsEnabled = isToggleAndAllAncestorsChecked('agingEnabled');
  document.querySelectorAll('input[name="timeMode"]').forEach((radioButton) => {
    radioButton.disabled = !agingIsEnabled;
  });
}

// ─── Bookmark folder rename tracking ─────────────────────────────────────────
let storedBookmarkFolderId = null;
let bookmarkFolderNameAtLastLoad = null;

// ─── Settings Load ───────────────────────────────────────────────────────────

/**
 * Loads all user settings from chrome.storage.local and populates the options form.
 * Falls back to default values for any setting that hasn't been saved yet.
 */
async function loadSettingsFromStorageIntoForm() {
  try {
    const storageResult = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = storageResult[STORAGE_KEYS.SETTINGS] || {};

    // Time mode
    const ageCalculationMode = settings.timeMode || AGE_CALCULATION_MODE.ACTIVE;
    const matchingTimeModeRadio = document.querySelector(`input[name="timeMode"][value="${ageCalculationMode}"]`);
    if (matchingTimeModeRadio) matchingTimeModeRadio.checked = true;

    // Thresholds
    const thresholds = settings.thresholds || {
      greenToYellow: DEFAULT_AGING_THRESHOLDS.GREEN_TO_YELLOW,
      yellowToRed: DEFAULT_AGING_THRESHOLDS.YELLOW_TO_RED,
      redToGone: DEFAULT_AGING_THRESHOLDS.RED_TO_GONE,
    };
    const greenToYellowReadable = convertMillisecondsToHumanReadable(thresholds.greenToYellow);
    document.getElementById('greenToYellow').value = greenToYellowReadable.value;
    document.getElementById('greenToYellowUnit').value = greenToYellowReadable.unit;
    const yellowToRedReadable = convertMillisecondsToHumanReadable(thresholds.yellowToRed);
    document.getElementById('yellowToRed').value = yellowToRedReadable.value;
    document.getElementById('yellowToRedUnit').value = yellowToRedReadable.unit;
    const redToGoneReadable = convertMillisecondsToHumanReadable(thresholds.redToGone);
    document.getElementById('redToGone').value = redToGoneReadable.value;
    document.getElementById('redToGoneUnit').value = redToGoneReadable.unit;

    // Aging feature toggles
    document.getElementById('agingEnabled').checked =
      settings.agingEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.AGING_ENABLED;
    document.getElementById('tabSortingEnabled').checked =
      settings.tabSortingEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.TAB_SORTING_ENABLED;
    document.getElementById('tabgroupSortingEnabled').checked =
      settings.tabgroupSortingEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.TABGROUP_SORTING_ENABLED;
    document.getElementById('tabgroupColoringEnabled').checked =
      settings.tabgroupColoringEnabled ?? DEFAULT_AGING_FEATURE_TOGGLES.TABGROUP_COLORING_ENABLED;
    document.getElementById('showGroupAge').checked =
      settings.showGroupAge ?? DEFAULT_SHOW_AGE_IN_GROUP_TITLES;

    // Status transition toggles
    document.getElementById('greenToYellowEnabled').checked =
      settings.greenToYellowEnabled ?? DEFAULT_STATUS_TRANSITION_TOGGLES.GREEN_TO_YELLOW_ENABLED;
    document.getElementById('yellowToRedEnabled').checked =
      settings.yellowToRedEnabled ?? DEFAULT_STATUS_TRANSITION_TOGGLES.YELLOW_TO_RED_ENABLED;
    document.getElementById('redToGoneEnabled').checked =
      settings.redToGoneEnabled ?? DEFAULT_STATUS_TRANSITION_TOGGLES.RED_TO_GONE_ENABLED;

    // Managed group names
    document.getElementById('yellowGroupName').value =
      settings.yellowGroupName ?? DEFAULT_MANAGED_GROUP_NAMES.YELLOW_GROUP_NAME;
    document.getElementById('redGroupName').value =
      settings.redGroupName ?? DEFAULT_MANAGED_GROUP_NAMES.RED_GROUP_NAME;

    // Bookmark settings
    document.getElementById('bookmarkEnabled').checked =
      settings.bookmarkEnabled ?? DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED;
    const bookmarkFolderName = settings.bookmarkFolderName || DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME;
    document.getElementById('bookmarkFolderName').value = bookmarkFolderName;
    bookmarkFolderNameAtLastLoad = bookmarkFolderName;

    // Auto-group settings (independent siblings)
    document.getElementById('autoGroupEnabled').checked =
      settings.autoGroupEnabled ?? DEFAULT_AUTO_GROUPING_SETTINGS.ENABLED;
    document.getElementById('autoGroupNamingEnabled').checked =
      settings.autoGroupNamingEnabled ?? DEFAULT_AUTO_NAMING_SETTINGS.ENABLED;
    document.getElementById('autoGroupNamingDelayMinutes').value =
      (Number.isInteger(settings.autoGroupNamingDelayMinutes) && settings.autoGroupNamingDelayMinutes > 0)
        ? settings.autoGroupNamingDelayMinutes
        : DEFAULT_AUTO_NAMING_SETTINGS.DELAY_MINUTES;

    // Load bookmark folder ID for rename operations
    const bookmarkStateResult = await chrome.storage.local.get(STORAGE_KEYS.BOOKMARK_STATE);
    const bookmarkState = bookmarkStateResult[STORAGE_KEYS.BOOKMARK_STATE];
    storedBookmarkFolderId = bookmarkState ? bookmarkState.folderId : null;

    // Apply grey-out based on loaded toggle states
    disableControlsDependingOnUncheckedToggles();

    logger.info('Settings loaded');
  } catch (error) {
    logger.error('Failed to load settings', { error: error.message });
    showTemporarySaveStatusBanner('Failed to load settings', true);
  }
}

// ─── Settings Save ───────────────────────────────────────────────────────────

/**
 * Validates the form inputs and saves all settings to chrome.storage.local.
 * Also renames the bookmark folder if the user changed its name.
 *
 * @param {Event} submitEvent - The form submit event
 */
async function validateAndSaveFormSettingsToStorage(submitEvent) {
  submitEvent.preventDefault();
  clearAllValidationErrors();

  const selectedAgeCalculationMode = document.querySelector('input[name="timeMode"]:checked')?.value || AGE_CALCULATION_MODE.ACTIVE;

  // Read threshold values from the form
  const greenToYellowInputValue = parseFloat(document.getElementById('greenToYellow').value);
  const greenToYellowSelectedUnit = document.getElementById('greenToYellowUnit').value;
  const yellowToRedInputValue = parseFloat(document.getElementById('yellowToRed').value);
  const yellowToRedSelectedUnit = document.getElementById('yellowToRedUnit').value;
  const redToGoneInputValue = parseFloat(document.getElementById('redToGone').value);
  const redToGoneSelectedUnit = document.getElementById('redToGoneUnit').value;

  let hasValidationError = false;

  if (!greenToYellowInputValue || greenToYellowInputValue <= 0) {
    showValidationErrorForField('greenToYellow', 'Must be a positive number');
    hasValidationError = true;
  }
  if (!yellowToRedInputValue || yellowToRedInputValue <= 0) {
    showValidationErrorForField('yellowToRed', 'Must be a positive number');
    hasValidationError = true;
  }
  if (!redToGoneInputValue || redToGoneInputValue <= 0) {
    showValidationErrorForField('redToGone', 'Must be a positive number');
    hasValidationError = true;
  }

  if (hasValidationError) return;

  const greenToYellowThresholdMs = convertHumanReadableToMilliseconds(greenToYellowInputValue, greenToYellowSelectedUnit);
  const yellowToRedThresholdMs = convertHumanReadableToMilliseconds(yellowToRedInputValue, yellowToRedSelectedUnit);
  const redToGoneThresholdMs = convertHumanReadableToMilliseconds(redToGoneInputValue, redToGoneSelectedUnit);

  // Threshold ordering validation (enforced even when transitions are disabled)
  if (greenToYellowThresholdMs >= yellowToRedThresholdMs) {
    showValidationErrorForField('greenToYellow', 'Must be less than Yellow → Red');
    showValidationErrorForField('yellowToRed', 'Must be greater than Green → Yellow');
    return;
  }
  if (yellowToRedThresholdMs >= redToGoneThresholdMs) {
    showValidationErrorForField('yellowToRed', 'Must be less than Red → Gone');
    showValidationErrorForField('redToGone', 'Must be greater than Yellow → Red');
    return;
  }

  // Auto-naming delay validation
  let autoGroupNamingDelayMinutes = Number.parseInt(
    document.getElementById('autoGroupNamingDelayMinutes').value, 10
  );
  const autoGroupNamingIsEnabled = document.getElementById('autoGroupNamingEnabled').checked;
  if (!Number.isInteger(autoGroupNamingDelayMinutes) || autoGroupNamingDelayMinutes <= 0) {
    if (autoGroupNamingIsEnabled) {
      showValidationErrorForField('autoGroupNamingDelayMinutes', 'Must be a positive whole number');
      return;
    }
    autoGroupNamingDelayMinutes = DEFAULT_AUTO_NAMING_SETTINGS.DELAY_MINUTES;
  }

  // Bookmark folder name validation
  const bookmarkFolderName = document.getElementById('bookmarkFolderName').value.trim();
  if (!bookmarkFolderName) {
    showValidationErrorForField('bookmarkFolderName', 'Folder name cannot be empty');
    return;
  }

  // Rename existing folder if name changed and folder ID is known
  if (bookmarkFolderName !== bookmarkFolderNameAtLastLoad && storedBookmarkFolderId) {
    try {
      await chrome.bookmarks.update(storedBookmarkFolderId, { title: bookmarkFolderName });
      logger.info('Bookmark folder renamed', {
        oldName: bookmarkFolderNameAtLastLoad,
        newName: bookmarkFolderName,
        folderId: storedBookmarkFolderId,
      });
    } catch (error) {
      logger.warn('Failed to rename bookmark folder', {
        error: error.message,
        errorCode: ERROR_CODES.ERR_BOOKMARK_RENAME,
        folderId: storedBookmarkFolderId,
      });
    }
  }

  // Collect ALL field values (including disabled/greyed-out fields)
  const settingsToSave = {
    timeMode: selectedAgeCalculationMode,
    thresholds: {
      greenToYellow: greenToYellowThresholdMs,
      yellowToRed: yellowToRedThresholdMs,
      redToGone: redToGoneThresholdMs,
    },
    // Aging feature toggles
    agingEnabled: document.getElementById('agingEnabled').checked,
    tabSortingEnabled: document.getElementById('tabSortingEnabled').checked,
    tabgroupSortingEnabled: document.getElementById('tabgroupSortingEnabled').checked,
    tabgroupColoringEnabled: document.getElementById('tabgroupColoringEnabled').checked,
    showGroupAge: document.getElementById('showGroupAge').checked,
    // Status transition toggles
    greenToYellowEnabled: document.getElementById('greenToYellowEnabled').checked,
    yellowToRedEnabled: document.getElementById('yellowToRedEnabled').checked,
    redToGoneEnabled: document.getElementById('redToGoneEnabled').checked,
    // Managed group names
    yellowGroupName: document.getElementById('yellowGroupName').value,
    redGroupName: document.getElementById('redGroupName').value,
    // Bookmark settings
    bookmarkEnabled: document.getElementById('bookmarkEnabled').checked,
    bookmarkFolderName,
    // Auto-group settings (independent siblings)
    autoGroupEnabled: document.getElementById('autoGroupEnabled').checked,
    autoGroupNamingEnabled: autoGroupNamingIsEnabled,
    autoGroupNamingDelayMinutes,
  };

  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settingsToSave });
    bookmarkFolderNameAtLastLoad = bookmarkFolderName;
    showTemporarySaveStatusBanner('Settings saved', false);
    logger.info('Settings saved');
  } catch (error) {
    logger.error('Failed to save settings', { error: error.message });
    showTemporarySaveStatusBanner('Failed to save settings', true);
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', loadSettingsFromStorageIntoForm);
document.getElementById('settings-form').addEventListener('submit', validateAndSaveFormSettingsToStorage);

// Wire up all toggle checkboxes that participate in the grey-out dependency tree
const allToggleIds = Object.keys(SETTINGS_TOGGLE_DEPENDENCY_TREE);
for (const toggleId of allToggleIds) {
  const toggleElement = document.getElementById(toggleId);
  if (toggleElement) {
    toggleElement.addEventListener('change', disableControlsDependingOnUncheckedToggles);
  }
}
