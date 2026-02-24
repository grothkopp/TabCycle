/**
 * Reads and writes extension state to chrome.storage.local with schema validation.
 *
 * Every read and write passes through validators (defined in schemas.js) to catch
 * data corruption early. Validation failures are logged as warnings but do not
 * block the operation — the extension continues with potentially imperfect data
 * rather than crashing.
 */

import { STORAGE_KEYS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import {
  validateSettings,
  validateBookmarkState,
  validateActiveTime,
  validateTabMeta,
  validateWindowState,
} from '../shared/schemas.js';

const logger = createLogger('background');

/** Maps each storage key to its corresponding validator function. */
const VALIDATORS_BY_STORAGE_KEY = {
  [STORAGE_KEYS.SETTINGS]: validateSettings,
  [STORAGE_KEYS.ACTIVE_TIME]: validateActiveTime,
  [STORAGE_KEYS.TAB_META]: validateTabMeta,
  [STORAGE_KEYS.WINDOW_STATE]: validateWindowState,
  [STORAGE_KEYS.BOOKMARK_STATE]: validateBookmarkState,
};

/**
 * Reads one or more entries from chrome.storage.local, validating each against its schema.
 *
 * @param {string[]} storageKeys - Array of STORAGE_KEYS to read
 * @returns {Promise<object>} The stored values keyed by storage key
 * @throws {Error} If the underlying chrome.storage.local.get call fails
 */
export async function readValidatedStateFromStorage(storageKeys) {
  try {
    const storedValues = await chrome.storage.local.get(storageKeys);
    for (const key of storageKeys) {
      if (storedValues[key] !== undefined && VALIDATORS_BY_STORAGE_KEY[key]) {
        const validationResult = VALIDATORS_BY_STORAGE_KEY[key](storedValues[key]);
        if (!validationResult.valid) {
          logger.warn('Schema validation failed on read', {
            key,
            errors: validationResult.errors,
            errorCode: ERROR_CODES.ERR_SCHEMA_VALIDATION,
          });
        }
      }
    }
    return storedValues;
  } catch (error) {
    logger.error('Failed to read from storage', {
      keys: storageKeys,
      error: error.message,
      errorCode: ERROR_CODES.ERR_STORAGE_READ,
    });
    throw error;
  }
}

/**
 * Writes one or more entries to chrome.storage.local, validating each against its schema first.
 *
 * @param {object} dataToWrite - Object of { storageKey: value } pairs to persist
 * @throws {Error} If the underlying chrome.storage.local.set call fails
 */
export async function writeValidatedStateToStorage(dataToWrite) {
  try {
    for (const [key, value] of Object.entries(dataToWrite)) {
      if (VALIDATORS_BY_STORAGE_KEY[key]) {
        const validationResult = VALIDATORS_BY_STORAGE_KEY[key](value);
        if (!validationResult.valid) {
          logger.warn('Schema validation failed on write', {
            key,
            errors: validationResult.errors,
            errorCode: ERROR_CODES.ERR_SCHEMA_VALIDATION,
          });
        }
      }
    }
    await chrome.storage.local.set(dataToWrite);
  } catch (error) {
    logger.error('Failed to write to storage', {
      keys: Object.keys(dataToWrite),
      error: error.message,
      errorCode: ERROR_CODES.ERR_STORAGE_WRITE,
    });
    throw error;
  }
}

/**
 * Writes multiple state entries to storage in a single operation.
 * Convenience wrapper that skips the call when there is nothing to write.
 *
 * @param {object} stateChanges - Object of { storageKey: value } pairs to persist
 */
export async function writeMultipleStateEntries(stateChanges) {
  if (!stateChanges || Object.keys(stateChanges).length === 0) {
    return;
  }
  await writeValidatedStateToStorage(stateChanges);
}

/**
 * Removes one or more keys from chrome.storage.local.
 *
 * @param {string[]} storageKeys - Array of storage keys to delete
 * @throws {Error} If the underlying chrome.storage.local.remove call fails
 */
export async function removeKeysFromStorage(storageKeys) {
  try {
    await chrome.storage.local.remove(storageKeys);
  } catch (error) {
    logger.error('Failed to remove keys from storage', {
      keys: storageKeys,
      error: error.message,
      errorCode: ERROR_CODES.ERR_STORAGE_WRITE,
    });
    throw error;
  }
}
