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

const VALIDATORS = {
  [STORAGE_KEYS.SETTINGS]: validateSettings,
  [STORAGE_KEYS.ACTIVE_TIME]: validateActiveTime,
  [STORAGE_KEYS.TAB_META]: validateTabMeta,
  [STORAGE_KEYS.WINDOW_STATE]: validateWindowState,
  [STORAGE_KEYS.BOOKMARK_STATE]: validateBookmarkState,
};

export async function readState(keys) {
  try {
    const result = await chrome.storage.local.get(keys);
    for (const key of keys) {
      if (result[key] !== undefined && VALIDATORS[key]) {
        const validation = VALIDATORS[key](result[key]);
        if (!validation.valid) {
          logger.warn('Schema validation failed on read', {
            key,
            errors: validation.errors,
            errorCode: ERROR_CODES.ERR_SCHEMA_VALIDATION,
          });
        }
      }
    }
    return result;
  } catch (err) {
    logger.error('Failed to read from storage', {
      keys,
      error: err.message,
      errorCode: ERROR_CODES.ERR_STORAGE_READ,
    });
    throw err;
  }
}

export async function writeState(data) {
  try {
    for (const [key, value] of Object.entries(data)) {
      if (VALIDATORS[key]) {
        const validation = VALIDATORS[key](value);
        if (!validation.valid) {
          logger.warn('Schema validation failed on write', {
            key,
            errors: validation.errors,
            errorCode: ERROR_CODES.ERR_SCHEMA_VALIDATION,
          });
        }
      }
    }
    await chrome.storage.local.set(data);
  } catch (err) {
    logger.error('Failed to write to storage', {
      keys: Object.keys(data),
      error: err.message,
      errorCode: ERROR_CODES.ERR_STORAGE_WRITE,
    });
    throw err;
  }
}

export async function batchWrite(changes) {
  if (!changes || Object.keys(changes).length === 0) {
    return;
  }
  await writeState(changes);
}

export async function removeKeys(keys) {
  try {
    await chrome.storage.local.remove(keys);
  } catch (err) {
    logger.error('Failed to remove keys from storage', {
      keys,
      error: err.message,
      errorCode: ERROR_CODES.ERR_STORAGE_WRITE,
    });
    throw err;
  }
}
