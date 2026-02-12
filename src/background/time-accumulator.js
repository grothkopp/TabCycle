import { STORAGE_KEYS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { readState, batchWrite } from './state-persistence.js';

const logger = createLogger('background');

let cachedActiveTime = null;

export function createDefaultActiveTime() {
  return {
    accumulatedMs: 0,
    focusStartTime: null,
    lastPersistedAt: Date.now(),
  };
}

export async function initActiveTime() {
  const defaultState = createDefaultActiveTime();
  await batchWrite({ [STORAGE_KEYS.ACTIVE_TIME]: defaultState });
  cachedActiveTime = defaultState;
  return defaultState;
}

export async function loadActiveTime() {
  const result = await readState([STORAGE_KEYS.ACTIVE_TIME]);
  cachedActiveTime = result[STORAGE_KEYS.ACTIVE_TIME] || null;
  return cachedActiveTime;
}

export async function recoverActiveTime() {
  const state = await loadActiveTime();
  if (!state) {
    logger.info('No active time state found, initializing');
    return initActiveTime();
  }

  if (state.focusStartTime !== null) {
    const delta = Date.now() - state.lastPersistedAt;
    if (delta > 0) {
      state.accumulatedMs += delta;
      logger.info('Recovered active time after service worker restart', {
        deltaMs: delta,
        newAccumulatedMs: state.accumulatedMs,
      });
    }
  }

  state.lastPersistedAt = Date.now();
  cachedActiveTime = state;
  await batchWrite({ [STORAGE_KEYS.ACTIVE_TIME]: state });
  return state;
}

export function handleFocusChange(windowId) {
  if (!cachedActiveTime) {
    logger.warn('handleFocusChange called before active time loaded', {
      errorCode: ERROR_CODES.ERR_RECOVERY,
    });
    return null;
  }

  const now = Date.now();
  const WINDOW_ID_NONE = chrome.windows.WINDOW_ID_NONE;

  if (windowId === WINDOW_ID_NONE) {
    if (cachedActiveTime.focusStartTime !== null) {
      const delta = now - cachedActiveTime.focusStartTime;
      if (delta > 0) {
        cachedActiveTime.accumulatedMs += delta;
      }
      cachedActiveTime.focusStartTime = null;
    }
  } else {
    if (cachedActiveTime.focusStartTime === null) {
      cachedActiveTime.focusStartTime = now;
    }
  }

  cachedActiveTime.lastPersistedAt = now;
  return { ...cachedActiveTime };
}

export function getCurrentActiveTime() {
  if (!cachedActiveTime) {
    return 0;
  }
  let total = cachedActiveTime.accumulatedMs;
  if (cachedActiveTime.focusStartTime !== null) {
    const delta = Date.now() - cachedActiveTime.focusStartTime;
    if (delta > 0) {
      total += delta;
    }
  }
  return total;
}

export async function persistActiveTime() {
  if (!cachedActiveTime) {
    return;
  }
  cachedActiveTime.lastPersistedAt = Date.now();
  await batchWrite({ [STORAGE_KEYS.ACTIVE_TIME]: { ...cachedActiveTime } });
}

export function getCachedActiveTimeState() {
  if (!cachedActiveTime) {
    return null;
  }
  return { ...cachedActiveTime };
}
