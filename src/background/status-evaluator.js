import { STATUS, TIME_MODE } from '../shared/constants.js';

/**
 * Compute the status for a tab given its age and threshold configuration.
 *
 * @param {number} ageMs - The tab's age in milliseconds
 * @param {object} thresholds - Threshold values { greenToYellow, yellowToRed, redToGone }
 * @param {object} [transitionToggles] - Optional transition toggles
 * @param {boolean} [transitionToggles.greenToYellowEnabled=true]
 * @param {boolean} [transitionToggles.yellowToRedEnabled=true]
 * @param {boolean} [transitionToggles.redToGoneEnabled=true]
 * @returns {string} STATUS.GREEN | STATUS.YELLOW | STATUS.RED | STATUS.GONE
 */
export function computeStatus(ageMs, thresholds, transitionToggles) {
  const greenToYellowEnabled = transitionToggles?.greenToYellowEnabled !== false;
  const yellowToRedEnabled = transitionToggles?.yellowToRedEnabled !== false;
  const redToGoneEnabled = transitionToggles?.redToGoneEnabled !== false;

  // Each transition must be enabled for the status to advance past that level.
  // If an earlier transition is disabled, all downstream transitions are also blocked.
  if (greenToYellowEnabled && ageMs >= thresholds.greenToYellow) {
    if (yellowToRedEnabled && ageMs >= thresholds.yellowToRed) {
      if (redToGoneEnabled && ageMs >= thresholds.redToGone) {
        return STATUS.GONE;
      }
      return STATUS.RED;
    }
    return STATUS.YELLOW;
  }
  return STATUS.GREEN;
}

export function computeAge(tabMeta, activeTimeMs, settings) {
  let age;
  if (settings.timeMode === TIME_MODE.WALL_CLOCK) {
    age = Date.now() - tabMeta.refreshWallTime;
  } else {
    age = activeTimeMs - tabMeta.refreshActiveTime;
  }
  return Math.max(0, age);
}

export function evaluateAllTabs(tabMeta, activeTimeMs, settings) {
  const transitions = {};

  for (const [tabId, meta] of Object.entries(tabMeta)) {
    if (meta.pinned) continue;

    const age = computeAge(meta, activeTimeMs, settings);
    const transitionToggles = {
      greenToYellowEnabled: settings.greenToYellowEnabled,
      yellowToRedEnabled: settings.yellowToRedEnabled,
      redToGoneEnabled: settings.redToGoneEnabled,
    };
    const newStatus = computeStatus(age, settings.thresholds, transitionToggles);

    if (newStatus !== meta.status) {
      transitions[tabId] = {
        oldStatus: meta.status,
        newStatus,
      };
    }
  }

  return transitions;
}
