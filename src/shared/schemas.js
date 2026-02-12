import { STATUS, TIME_MODE } from './constants.js';

export function validateSettings(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Settings must be a non-null object'] };
  }
  if (obj.timeMode !== TIME_MODE.ACTIVE && obj.timeMode !== TIME_MODE.WALL_CLOCK) {
    errors.push(`timeMode must be "${TIME_MODE.ACTIVE}" or "${TIME_MODE.WALL_CLOCK}", got "${obj.timeMode}"`);
  }
  if (!obj.thresholds || typeof obj.thresholds !== 'object') {
    errors.push('thresholds must be a non-null object');
  } else {
    const { greenToYellow, yellowToRed, redToGone } = obj.thresholds;
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
  return { valid: errors.length === 0, errors };
}

export function validateActiveTime(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['ActiveTime must be a non-null object'] };
  }
  if (typeof obj.accumulatedMs !== 'number' || obj.accumulatedMs < 0) {
    errors.push('accumulatedMs must be a non-negative number');
  }
  if (obj.focusStartTime !== null && (typeof obj.focusStartTime !== 'number' || obj.focusStartTime <= 0)) {
    errors.push('focusStartTime must be null or a positive number (timestamp)');
  }
  if (typeof obj.lastPersistedAt !== 'number' || obj.lastPersistedAt <= 0) {
    errors.push('lastPersistedAt must be a positive number (timestamp)');
  }
  return { valid: errors.length === 0, errors };
}

export function validateTabMeta(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['TabMeta must be a non-null object'] };
  }
  for (const [key, entry] of Object.entries(obj)) {
    const prefix = `TabMeta[${key}]`;
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${prefix} must be a non-null object`);
      continue;
    }
    if (typeof entry.tabId !== 'number' || entry.tabId <= 0) {
      errors.push(`${prefix}.tabId must be a positive number`);
    }
    if (typeof entry.windowId !== 'number' || entry.windowId <= 0) {
      errors.push(`${prefix}.windowId must be a positive number`);
    }
    if (typeof entry.refreshActiveTime !== 'number' || entry.refreshActiveTime < 0) {
      errors.push(`${prefix}.refreshActiveTime must be a non-negative number`);
    }
    if (typeof entry.refreshWallTime !== 'number' || entry.refreshWallTime < 0) {
      errors.push(`${prefix}.refreshWallTime must be a non-negative number`);
    }
    const validStatuses = [STATUS.GREEN, STATUS.YELLOW, STATUS.RED];
    if (!validStatuses.includes(entry.status)) {
      errors.push(`${prefix}.status must be one of: ${validStatuses.join(', ')}`);
    }
    if (entry.groupId !== null && (typeof entry.groupId !== 'number')) {
      errors.push(`${prefix}.groupId must be null or a number`);
    }
    if (typeof entry.isSpecialGroup !== 'boolean') {
      errors.push(`${prefix}.isSpecialGroup must be a boolean`);
    }
    if (typeof entry.pinned !== 'boolean') {
      errors.push(`${prefix}.pinned must be a boolean`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateWindowState(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['WindowState must be a non-null object'] };
  }
  for (const [windowId, state] of Object.entries(obj)) {
    const prefix = `WindowState[${windowId}]`;
    if (typeof state !== 'object' || state === null) {
      errors.push(`${prefix} must be a non-null object`);
      continue;
    }
    if (!state.specialGroups || typeof state.specialGroups !== 'object') {
      errors.push(`${prefix}.specialGroups must be a non-null object`);
    } else {
      if (state.specialGroups.yellow !== null && typeof state.specialGroups.yellow !== 'number') {
        errors.push(`${prefix}.specialGroups.yellow must be null or a number`);
      }
      if (state.specialGroups.red !== null && typeof state.specialGroups.red !== 'number') {
        errors.push(`${prefix}.specialGroups.red must be null or a number`);
      }
    }
    if (!state.groupZones || typeof state.groupZones !== 'object') {
      errors.push(`${prefix}.groupZones must be a non-null object`);
    } else {
      const validZones = [STATUS.GREEN, STATUS.YELLOW, STATUS.RED];
      for (const [groupId, zone] of Object.entries(state.groupZones)) {
        if (!validZones.includes(zone)) {
          errors.push(`${prefix}.groupZones[${groupId}] must be one of: ${validZones.join(', ')}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
