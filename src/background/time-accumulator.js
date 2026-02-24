/**
 * Tracks how long the browser has been actively used (window focused).
 *
 * Active time accumulates independently of all settings toggles. When aging
 * is paused, the clock keeps ticking so tab ages remain accurate when aging
 * resumes. An age cap (applied in service-worker.js on re-enable) prevents
 * mass tab closure after a long pause.
 *
 * The accumulator works like a stopwatch:
 *   - When a Chrome window gains focus → start the stopwatch
 *   - When all windows lose focus → stop and add elapsed time to the total
 *   - getCurrentTotalActiveTimeMs() returns the total, including any currently running segment
 */

import { STORAGE_KEYS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { readValidatedStateFromStorage, writeMultipleStateEntries } from './state-persistence.js';

const logger = createLogger('background');

/** In-memory cache of the active time state. Null until first load. */
let inMemoryActiveTimeState = null;

/** Promise for the in-flight load operation, to avoid duplicate loads. */
let pendingLoadPromise = null;

/**
 * Creates a default active time state (zero accumulated, no focus, timestamped now).
 */
export function createDefaultActiveTimeState() {
  return {
    accumulatedMs: 0,
    focusStartTime: null,
    lastPersistedAt: Date.now(),
  };
}

/**
 * Initializes active time state in storage with default values.
 * Called on first extension install.
 */
export async function initializeActiveTimeInStorage() {
  const defaultState = createDefaultActiveTimeState();
  await writeMultipleStateEntries({ [STORAGE_KEYS.ACTIVE_TIME]: defaultState });
  inMemoryActiveTimeState = defaultState;
  return defaultState;
}

/**
 * Loads active time state from storage into the in-memory cache.
 */
export async function loadActiveTimeFromStorage() {
  const storedData = await readValidatedStateFromStorage([STORAGE_KEYS.ACTIVE_TIME]);
  inMemoryActiveTimeState = storedData[STORAGE_KEYS.ACTIVE_TIME] || null;
  return inMemoryActiveTimeState;
}

/**
 * Ensures the active time state is loaded into memory before any operation.
 * Deduplicates concurrent load requests via a shared promise.
 */
async function ensureActiveTimeIsLoaded() {
  if (inMemoryActiveTimeState) return inMemoryActiveTimeState;
  if (pendingLoadPromise) return pendingLoadPromise;
  pendingLoadPromise = recoverActiveTimeAfterRestart().finally(() => { pendingLoadPromise = null; });
  return pendingLoadPromise;
}

/**
 * Recovers active time state after a service worker restart.
 *
 * If the browser had focus when the service worker was killed, the time between
 * the last persist and now is added to the accumulated total, so no active time
 * is lost during restarts.
 */
export async function recoverActiveTimeAfterRestart() {
  const loadedState = await loadActiveTimeFromStorage();
  if (!loadedState) {
    logger.info('No active time state found, initializing');
    return initializeActiveTimeInStorage();
  }

  if (loadedState.focusStartTime !== null) {
    const millisecondsSinceLastPersist = Date.now() - loadedState.lastPersistedAt;
    if (millisecondsSinceLastPersist > 0) {
      loadedState.accumulatedMs += millisecondsSinceLastPersist;
      logger.info('Recovered active time after service worker restart', {
        deltaMs: millisecondsSinceLastPersist,
        newAccumulatedMs: loadedState.accumulatedMs,
      });
    }
  }

  loadedState.lastPersistedAt = Date.now();
  inMemoryActiveTimeState = loadedState;
  await writeMultipleStateEntries({ [STORAGE_KEYS.ACTIVE_TIME]: loadedState });
  return loadedState;
}

/**
 * Updates the active time accumulator when a Chrome window gains or loses focus.
 *
 * When focus moves away from all Chrome windows (windowId === WINDOW_ID_NONE),
 * the elapsed focus time is added to the total. When a window gains focus,
 * the stopwatch starts.
 *
 * @param {number} windowId - The window that gained focus, or WINDOW_ID_NONE
 * @returns {Promise<object>} Snapshot of the current active time state
 */
export async function updateActiveTimeOnWindowFocusChange(windowId) {
  await ensureActiveTimeIsLoaded();

  const now = Date.now();
  const WINDOW_ID_NONE = chrome.windows.WINDOW_ID_NONE;

  if (windowId === WINDOW_ID_NONE) {
    // All Chrome windows lost focus — stop the stopwatch
    if (inMemoryActiveTimeState.focusStartTime !== null) {
      const elapsedSinceFocusStart = now - inMemoryActiveTimeState.focusStartTime;
      if (elapsedSinceFocusStart > 0) {
        inMemoryActiveTimeState.accumulatedMs += elapsedSinceFocusStart;
      }
      inMemoryActiveTimeState.focusStartTime = null;
    }
  } else {
    // A Chrome window gained focus — start the stopwatch
    if (inMemoryActiveTimeState.focusStartTime === null) {
      inMemoryActiveTimeState.focusStartTime = now;
    }
  }

  inMemoryActiveTimeState.lastPersistedAt = now;
  return { ...inMemoryActiveTimeState };
}

/**
 * Calculates the current total active time in milliseconds.
 * Includes any currently-running focus segment (time since the window was last focused).
 *
 * @returns {Promise<number>} Total accumulated active time in ms
 */
export async function getCurrentTotalActiveTimeMs() {
  await ensureActiveTimeIsLoaded();
  let totalMs = inMemoryActiveTimeState.accumulatedMs;
  if (inMemoryActiveTimeState.focusStartTime !== null) {
    const elapsedInCurrentSegment = Date.now() - inMemoryActiveTimeState.focusStartTime;
    if (elapsedInCurrentSegment > 0) {
      totalMs += elapsedInCurrentSegment;
    }
  }
  return totalMs;
}

/**
 * Persists the current in-memory active time state to chrome.storage.local.
 * Called periodically (every evaluation cycle) to survive service worker restarts.
 */
export async function saveActiveTimeToStorage() {
  await ensureActiveTimeIsLoaded();
  inMemoryActiveTimeState.lastPersistedAt = Date.now();
  await writeMultipleStateEntries({ [STORAGE_KEYS.ACTIVE_TIME]: { ...inMemoryActiveTimeState } });
}

/**
 * Returns a snapshot of the in-memory active time state.
 * Useful for diagnostics and logging.
 */
export async function getActiveTimeSnapshot() {
  await ensureActiveTimeIsLoaded();
  return { ...inMemoryActiveTimeState };
}
