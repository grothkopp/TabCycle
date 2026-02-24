/**
 * Validation functions for all data structures persisted in chrome.storage.local.
 *
 * Each validator checks structural correctness and returns { valid, errors }.
 * These are used by state-persistence.js on every read and write to catch
 * data corruption or schema drift early.
 */

import { TAB_LIFECYCLE_STAGE, AGE_CALCULATION_MODE } from './constants.js';

/**
 * Validates the user-configurable settings object.
 * Checks time mode, thresholds ordering, boolean toggles, and string fields.
 */
export function validateSettings(settingsObject) {
  const errors = [];
  if (!settingsObject || typeof settingsObject !== 'object') {
    return { valid: false, errors: ['Settings must be a non-null object'] };
  }
  if (settingsObject.timeMode !== AGE_CALCULATION_MODE.ACTIVE && settingsObject.timeMode !== AGE_CALCULATION_MODE.WALL_CLOCK) {
    errors.push(`timeMode must be "${AGE_CALCULATION_MODE.ACTIVE}" or "${AGE_CALCULATION_MODE.WALL_CLOCK}", got "${settingsObject.timeMode}"`);
  }
  if (!settingsObject.thresholds || typeof settingsObject.thresholds !== 'object') {
    errors.push('thresholds must be a non-null object');
  } else {
    const { greenToYellow, yellowToRed, redToGone } = settingsObject.thresholds;
    if (typeof greenToYellow !== 'number' || greenToYellow <= 0) {
      errors.push('thresholds.greenToYellow must be a positive number');
    }
    if (typeof yellowToRed !== 'number' || yellowToRed <= 0) {
      errors.push('thresholds.yellowToRed must be a positive number');
    }
    if (typeof redToGone !== 'number' || redToGone <= 0) {
      errors.push('thresholds.redToGone must be a positive number');
    }
    if (typeof greenToYellow === 'number' && typeof yellowToRed === 'number' && greenToYellow >= yellowToRed) {
      errors.push('thresholds.greenToYellow must be less than thresholds.yellowToRed');
    }
    if (typeof yellowToRed === 'number' && typeof redToGone === 'number' && yellowToRed >= redToGone) {
      errors.push('thresholds.yellowToRed must be less than thresholds.redToGone');
    }
  }
  if (settingsObject.bookmarkEnabled !== undefined && typeof settingsObject.bookmarkEnabled !== 'boolean') {
    errors.push('bookmarkEnabled must be a boolean');
  }
  if (settingsObject.bookmarkFolderName !== undefined) {
    if (typeof settingsObject.bookmarkFolderName !== 'string' || settingsObject.bookmarkFolderName.length === 0) {
      errors.push('bookmarkFolderName must be a non-empty string');
    }
  }
  if (settingsObject.autoGroupNamingEnabled !== undefined && typeof settingsObject.autoGroupNamingEnabled !== 'boolean') {
    errors.push('autoGroupNamingEnabled must be a boolean');
  }
  if (settingsObject.autoGroupNamingDelayMinutes !== undefined) {
    if (!Number.isInteger(settingsObject.autoGroupNamingDelayMinutes) || settingsObject.autoGroupNamingDelayMinutes <= 0) {
      errors.push('autoGroupNamingDelayMinutes must be a positive whole number');
    }
  }

  const booleanToggleFields = [
    'agingEnabled',
    'tabSortingEnabled',
    'tabgroupSortingEnabled',
    'tabgroupColoringEnabled',
    'greenToYellowEnabled',
    'yellowToRedEnabled',
    'redToGoneEnabled',
    'autoGroupEnabled',
  ];
  for (const fieldName of booleanToggleFields) {
    if (settingsObject[fieldName] !== undefined && typeof settingsObject[fieldName] !== 'boolean') {
      errors.push(`${fieldName} must be a boolean`);
    }
  }

  if (settingsObject.yellowGroupName !== undefined && typeof settingsObject.yellowGroupName !== 'string') {
    errors.push('yellowGroupName must be a string');
  }
  if (settingsObject.redGroupName !== undefined && typeof settingsObject.redGroupName !== 'string') {
    errors.push('redGroupName must be a string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the bookmark folder state (tracks which folder holds closed-tab bookmarks).
 */
export function validateBookmarkState(bookmarkStateObject) {
  const errors = [];
  if (!bookmarkStateObject || typeof bookmarkStateObject !== 'object') {
    return { valid: false, errors: ['BookmarkState must be a non-null object'] };
  }
  if (bookmarkStateObject.folderId !== null && (typeof bookmarkStateObject.folderId !== 'string' || bookmarkStateObject.folderId.length === 0)) {
    errors.push('folderId must be null or a non-empty string');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates the active time accumulator state (tracks how long the browser has been actively used).
 */
export function validateActiveTime(activeTimeObject) {
  const errors = [];
  if (!activeTimeObject || typeof activeTimeObject !== 'object') {
    return { valid: false, errors: ['ActiveTime must be a non-null object'] };
  }
  if (typeof activeTimeObject.accumulatedMs !== 'number' || activeTimeObject.accumulatedMs < 0) {
    errors.push('accumulatedMs must be a non-negative number');
  }
  if (activeTimeObject.focusStartTime !== null && (typeof activeTimeObject.focusStartTime !== 'number' || activeTimeObject.focusStartTime <= 0)) {
    errors.push('focusStartTime must be null or a positive number (timestamp)');
  }
  if (typeof activeTimeObject.lastPersistedAt !== 'number' || activeTimeObject.lastPersistedAt <= 0) {
    errors.push('lastPersistedAt must be a positive number (timestamp)');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates the collection of per-tab metadata entries.
 * Each entry tracks a tab's lifecycle stage, refresh timestamps, group membership, etc.
 */
export function validateTabMeta(tabMetaCollection) {
  const errors = [];
  if (!tabMetaCollection || typeof tabMetaCollection !== 'object') {
    return { valid: false, errors: ['TabMeta must be a non-null object'] };
  }
  for (const [tabIdKey, tabEntry] of Object.entries(tabMetaCollection)) {
    const errorPrefix = `TabMeta[${tabIdKey}]`;
    if (typeof tabEntry !== 'object' || tabEntry === null) {
      errors.push(`${errorPrefix} must be a non-null object`);
      continue;
    }
    if (typeof tabEntry.tabId !== 'number' || tabEntry.tabId <= 0) {
      errors.push(`${errorPrefix}.tabId must be a positive number`);
    }
    if (typeof tabEntry.windowId !== 'number' || tabEntry.windowId <= 0) {
      errors.push(`${errorPrefix}.windowId must be a positive number`);
    }
    if (typeof tabEntry.refreshActiveTime !== 'number' || tabEntry.refreshActiveTime < 0) {
      errors.push(`${errorPrefix}.refreshActiveTime must be a non-negative number`);
    }
    if (typeof tabEntry.refreshWallTime !== 'number' || tabEntry.refreshWallTime < 0) {
      errors.push(`${errorPrefix}.refreshWallTime must be a non-negative number`);
    }
    const validStages = [TAB_LIFECYCLE_STAGE.GREEN, TAB_LIFECYCLE_STAGE.YELLOW, TAB_LIFECYCLE_STAGE.RED, TAB_LIFECYCLE_STAGE.GONE];
    if (!validStages.includes(tabEntry.status)) {
      errors.push(`${errorPrefix}.status must be one of: ${validStages.join(', ')}`);
    }
    if (tabEntry.groupId !== null && (typeof tabEntry.groupId !== 'number')) {
      errors.push(`${errorPrefix}.groupId must be null or a number`);
    }
    if (typeof tabEntry.isSpecialGroup !== 'boolean') {
      errors.push(`${errorPrefix}.isSpecialGroup must be a boolean`);
    }
    if (typeof tabEntry.pinned !== 'boolean') {
      errors.push(`${errorPrefix}.pinned must be a boolean`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates the per-window state (tracks managed groups, zone assignments, and naming metadata).
 */
export function validateWindowState(windowStateObject) {
  const errors = [];
  if (!windowStateObject || typeof windowStateObject !== 'object') {
    return { valid: false, errors: ['WindowState must be a non-null object'] };
  }
  for (const [windowIdKey, windowEntry] of Object.entries(windowStateObject)) {
    const errorPrefix = `WindowState[${windowIdKey}]`;
    if (typeof windowEntry !== 'object' || windowEntry === null) {
      errors.push(`${errorPrefix} must be a non-null object`);
      continue;
    }
    if (!windowEntry.specialGroups || typeof windowEntry.specialGroups !== 'object') {
      errors.push(`${errorPrefix}.specialGroups must be a non-null object`);
    } else {
      if (windowEntry.specialGroups.yellow !== null && typeof windowEntry.specialGroups.yellow !== 'number') {
        errors.push(`${errorPrefix}.specialGroups.yellow must be null or a number`);
      }
      if (windowEntry.specialGroups.red !== null && typeof windowEntry.specialGroups.red !== 'number') {
        errors.push(`${errorPrefix}.specialGroups.red must be null or a number`);
      }
    }
    if (!windowEntry.groupZones || typeof windowEntry.groupZones !== 'object') {
      errors.push(`${errorPrefix}.groupZones must be a non-null object`);
    } else {
      const validZones = [TAB_LIFECYCLE_STAGE.GREEN, TAB_LIFECYCLE_STAGE.YELLOW, TAB_LIFECYCLE_STAGE.RED, TAB_LIFECYCLE_STAGE.GONE];
      for (const [groupIdKey, zone] of Object.entries(windowEntry.groupZones)) {
        if (!validZones.includes(zone)) {
          errors.push(`${errorPrefix}.groupZones[${groupIdKey}] must be one of: ${validZones.join(', ')}`);
        }
      }
    }

    if (windowEntry.groupNaming !== undefined) {
      if (!windowEntry.groupNaming || typeof windowEntry.groupNaming !== 'object') {
        errors.push(`${errorPrefix}.groupNaming must be an object when present`);
      } else {
        for (const [groupIdKey, namingEntry] of Object.entries(windowEntry.groupNaming)) {
          const namingPrefix = `${errorPrefix}.groupNaming[${groupIdKey}]`;
          if (!namingEntry || typeof namingEntry !== 'object') {
            errors.push(`${namingPrefix} must be a non-null object`);
            continue;
          }
          if (!Number.isFinite(namingEntry.firstUnnamedSeenAt) || namingEntry.firstUnnamedSeenAt <= 0) {
            errors.push(`${namingPrefix}.firstUnnamedSeenAt must be a positive number`);
          }
          if (namingEntry.lastAutoNamedAt !== null
            && (!Number.isFinite(namingEntry.lastAutoNamedAt) || namingEntry.lastAutoNamedAt <= 0)) {
            errors.push(`${namingPrefix}.lastAutoNamedAt must be null or a positive number`);
          }
          if (namingEntry.lastCandidate !== null && namingEntry.lastCandidate !== undefined) {
            if (typeof namingEntry.lastCandidate !== 'string' || namingEntry.lastCandidate.trim().length === 0) {
              errors.push(`${namingPrefix}.lastCandidate must be null or a non-empty string`);
            } else {
              const words = namingEntry.lastCandidate.trim().split(/\s+/);
              if (words.length > 2) {
                errors.push(`${namingPrefix}.lastCandidate must be one or two words`);
              }
            }
          }
          if (!Number.isFinite(namingEntry.userEditLockUntil) || namingEntry.userEditLockUntil <= 0) {
            errors.push(`${namingPrefix}.userEditLockUntil must be a positive number`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
