import { STATUS, TIME_MODE } from '../shared/constants.js';

export function computeStatus(ageMs, thresholds) {
  if (ageMs >= thresholds.redToGone) return STATUS.GONE;
  if (ageMs >= thresholds.yellowToRed) return STATUS.RED;
  if (ageMs >= thresholds.greenToYellow) return STATUS.YELLOW;
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
    const newStatus = computeStatus(age, settings.thresholds);

    if (newStatus !== meta.status) {
      transitions[tabId] = {
        oldStatus: meta.status,
        newStatus,
      };
    }
  }

  return transitions;
}
