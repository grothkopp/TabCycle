/**
 * Evaluates tab ages and determines lifecycle stage transitions.
 *
 * Each tab ages over time. When its age crosses a threshold, it transitions
 * to the next lifecycle stage: GREEN → YELLOW → RED → GONE.
 * Individual transitions can be disabled, which blocks all downstream transitions.
 */

import { TAB_LIFECYCLE_STAGE, AGE_CALCULATION_MODE } from '../shared/constants.js';

/**
 * Determines which lifecycle stage a tab should be in, given its age and thresholds.
 *
 * Each transition must be enabled for the tab to advance past that level.
 * If an earlier transition is disabled, all downstream transitions are also blocked.
 * For example, if greenToYellowEnabled is false, tabs stay GREEN forever.
 *
 * @param {number} tabAgeInMs - How old the tab is, in milliseconds
 * @param {object} thresholds - { greenToYellow, yellowToRed, redToGone } in ms
 * @param {object} [transitionToggles] - Which transitions are enabled
 * @returns {string} The lifecycle stage: 'green', 'yellow', 'red', or 'gone'
 */
export function determineLifecycleStage(tabAgeInMs, thresholds, transitionToggles) {
  const isGreenToYellowEnabled = transitionToggles?.greenToYellowEnabled !== false;
  const isYellowToRedEnabled = transitionToggles?.yellowToRedEnabled !== false;
  const isRedToGoneEnabled = transitionToggles?.redToGoneEnabled !== false;

  if (isGreenToYellowEnabled && tabAgeInMs >= thresholds.greenToYellow) {
    if (isYellowToRedEnabled && tabAgeInMs >= thresholds.yellowToRed) {
      if (isRedToGoneEnabled && tabAgeInMs >= thresholds.redToGone) {
        return TAB_LIFECYCLE_STAGE.GONE;
      }
      return TAB_LIFECYCLE_STAGE.RED;
    }
    return TAB_LIFECYCLE_STAGE.YELLOW;
  }
  return TAB_LIFECYCLE_STAGE.GREEN;
}

/**
 * Calculates how old a tab is in milliseconds, based on the configured time mode.
 *
 * In ACTIVE mode: age = (current active time) - (active time when tab was last refreshed)
 * In WALL_CLOCK mode: age = (current wall time) - (wall time when tab was last refreshed)
 *
 * @param {object} tabMetadata - The tab's metadata entry
 * @param {number} currentActiveTimeMs - Current total active time in ms
 * @param {object} settings - User settings (used to determine time mode)
 * @returns {number} The tab's age in milliseconds (minimum 0)
 */
export function calculateTabAgeInMs(tabMetadata, currentActiveTimeMs, settings) {
  let ageInMs;
  if (settings.timeMode === AGE_CALCULATION_MODE.WALL_CLOCK) {
    ageInMs = Date.now() - tabMetadata.refreshWallTime;
  } else {
    ageInMs = currentActiveTimeMs - tabMetadata.refreshActiveTime;
  }
  return Math.max(0, ageInMs);
}

/**
 * Evaluates all tracked tabs and returns which ones need to transition to a new lifecycle stage.
 * Only returns entries for tabs whose status actually changed.
 *
 * @param {object} allTabMetadata - All tab metadata entries keyed by tab ID
 * @param {number} currentActiveTimeMs - Current total active time in ms
 * @param {object} settings - User settings (thresholds, time mode, transition toggles)
 * @returns {object} Map of tabId → { oldStatus, newStatus } for tabs that changed
 */
export function findAllTabsNeedingStatusTransition(allTabMetadata, currentActiveTimeMs, settings) {
  const tabsWithChangedStatus = {};

  for (const [tabId, tabMetadata] of Object.entries(allTabMetadata)) {
    if (tabMetadata.pinned) continue;

    const tabAge = calculateTabAgeInMs(tabMetadata, currentActiveTimeMs, settings);
    const transitionToggles = {
      greenToYellowEnabled: settings.greenToYellowEnabled,
      yellowToRedEnabled: settings.yellowToRedEnabled,
      redToGoneEnabled: settings.redToGoneEnabled,
    };
    const newStage = determineLifecycleStage(tabAge, settings.thresholds, transitionToggles);

    if (newStage !== tabMetadata.status) {
      tabsWithChangedStatus[tabId] = {
        oldStatus: tabMetadata.status,
        newStatus: newStage,
      };
    }
  }

  return tabsWithChangedStatus;
}
