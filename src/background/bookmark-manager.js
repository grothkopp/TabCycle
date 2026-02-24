/**
 * Bookmarks tabs before they are closed (when they reach the GONE lifecycle stage).
 *
 * Closed tabs are saved into a configurable folder under "Other Bookmarks".
 * Grouped tabs are bookmarked as a subfolder with the group's title.
 * The folder is created on demand and its ID is cached for subsequent calls.
 */

import { STORAGE_KEYS, URLS_EXCLUDED_FROM_BOOKMARKING, DEFAULT_BOOKMARK_SETTINGS, ERROR_CODES } from '../shared/constants.js';
import { removeAgeSuffixFromTitle } from './group-manager.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('background');

/** Cached ID of the "Other Bookmarks" folder — discovered once per service worker lifecycle. */
let cachedOtherBookmarksFolderId = null;

/**
 * Finds the "Other Bookmarks" folder in Chrome's bookmark tree.
 * Caches the result for the lifetime of the service worker.
 *
 * @returns {Promise<string>} The bookmark node ID of the "Other Bookmarks" folder
 */
export async function findOtherBookmarksFolderId() {
  if (cachedOtherBookmarksFolderId) return cachedOtherBookmarksFolderId;

  const bookmarkTree = await chrome.bookmarks.getTree();
  const otherBookmarksNode = bookmarkTree[0].children.find(
    (node) => node.title === 'Other Bookmarks' || node.title === 'Other bookmarks'
  );

  if (!otherBookmarksNode) {
    cachedOtherBookmarksFolderId = bookmarkTree[0].children.length > 1 ? bookmarkTree[0].children[1].id : bookmarkTree[0].children[0].id;
  } else {
    cachedOtherBookmarksFolderId = otherBookmarksNode.id;
  }

  return cachedOtherBookmarksFolderId;
}

/**
 * Finds or creates the bookmark folder where closed-tab bookmarks are stored.
 *
 * Resolution strategy:
 *   1. Check the stored folder ID — if valid, use it
 *   2. If the folder was renamed externally, detect and sync the new name to settings
 *   3. Search "Other Bookmarks" children by name
 *   4. Create a new folder if none found
 *
 * @param {object} settings - The current user settings (needs bookmarkFolderName)
 * @returns {Promise<string|null>} The folder's bookmark node ID, or null on failure
 */
export async function findOrCreateBookmarkFolderForClosedTabs(settings) {
  const correlationId = logger.correlationId();
  const desiredFolderName = settings.bookmarkFolderName || DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME;

  try {
    // Step 1: Check if we have a stored folder ID
    const storedData = await chrome.storage.local.get(STORAGE_KEYS.BOOKMARK_STATE);
    const bookmarkState = storedData[STORAGE_KEYS.BOOKMARK_STATE] || { folderId: null };
    let folderId = bookmarkState.folderId;

    // Step 2: Verify the stored folder still exists
    if (folderId) {
      try {
        const folderNodes = await chrome.bookmarks.get(folderId);
        const existingFolder = folderNodes[0];

        // Detect if the user renamed the folder outside of the extension
        if (existingFolder.title !== desiredFolderName) {
          logger.info('Bookmark folder renamed externally, syncing settings', {
            oldName: desiredFolderName,
            newName: existingFolder.title,
            folderId,
          }, correlationId);
          const currentSettings = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
          if (currentSettings) {
            currentSettings.bookmarkFolderName = existingFolder.title;
            await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: currentSettings });
          }
        }

        return folderId;
      } catch {
        // Stored folder was deleted — clear and fall through to search
        logger.debug('Stored bookmark folder ID invalid, falling back to name search', { folderId }, correlationId);
        folderId = null;
      }
    }

    // Step 3: Search "Other Bookmarks" children by name
    const otherBookmarksFolderId = await findOtherBookmarksFolderId();
    const childNodes = await chrome.bookmarks.getChildren(otherBookmarksFolderId);
    const matchingFolder = childNodes.find((node) => !node.url && node.title === desiredFolderName);

    if (matchingFolder) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: matchingFolder.id },
      });
      logger.debug('Bookmark folder found by name', { folderId: matchingFolder.id, folderName: desiredFolderName }, correlationId);
      return matchingFolder.id;
    }

    // Step 4: Create a new folder
    const newFolder = await chrome.bookmarks.create({
      parentId: otherBookmarksFolderId,
      title: desiredFolderName,
    });

    await chrome.storage.local.set({
      [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: newFolder.id },
    });
    logger.info('Bookmark folder created', { folderId: newFolder.id, folderName: desiredFolderName }, correlationId);
    return newFolder.id;
  } catch (error) {
    logger.error('Failed to resolve bookmark folder', {
      error: error.message,
      errorCode: ERROR_CODES.ERR_BOOKMARK_FOLDER,
    }, correlationId);
    return null;
  }
}

/**
 * Returns true if the URL is worth bookmarking.
 * Empty pages, new-tab pages, and about:blank are excluded.
 *
 * @param {string} url - The URL to check
 * @returns {boolean} True if the URL should be bookmarked
 */
export function isUrlWorthBookmarking(url) {
  if (!url) return false;
  return !URLS_EXCLUDED_FROM_BOOKMARKING.includes(url);
}

/**
 * Creates a bookmark for a single tab.
 * Falls back to the URL as the bookmark title if the tab has no title.
 * Never throws — returns false on failure.
 *
 * @param {object} tab - A tab object with { title, url } (and optionally { id })
 * @param {string} parentFolderId - The bookmark folder ID to create the bookmark in
 * @returns {Promise<boolean>} True if the bookmark was created successfully
 */
export async function createBookmarkForSingleTab(tab, parentFolderId) {
  const correlationId = logger.correlationId();
  try {
    const bookmarkTitle = tab.title && tab.title.trim() ? tab.title : tab.url;
    await chrome.bookmarks.create({
      parentId: parentFolderId,
      title: bookmarkTitle,
      url: tab.url,
    });
    return true;
  } catch (error) {
    logger.warn('Failed to create bookmark for tab', {
      tabId: tab.id,
      url: tab.url,
      error: error.message,
      errorCode: ERROR_CODES.ERR_BOOKMARK_CREATE,
    }, correlationId);
    return false;
  }
}

/**
 * Creates a subfolder for a tab group and bookmarks all its tabs inside.
 * Uses "(unnamed)" if the group has no title. Filters out non-bookmarkable URLs.
 *
 * @param {string} groupTitle - The tab group's title
 * @param {Array} tabs - Array of tab objects with { id, title, url }
 * @param {string} parentFolderId - The root bookmark folder ID
 * @returns {Promise<{created: number, skipped: number, failed: number}>}
 */
export async function createBookmarkSubfolderForTabGroup(groupTitle, tabs, parentFolderId) {
  const correlationId = logger.correlationId();
  const titleWithoutAge = removeAgeSuffixFromTitle(groupTitle);
  const subfolderName = titleWithoutAge && titleWithoutAge.trim() ? titleWithoutAge : '(unnamed)';
  const bookmarkingResults = { created: 0, skipped: 0, failed: 0 };

  try {
    const subfolder = await chrome.bookmarks.create({
      parentId: parentFolderId,
      title: subfolderName,
    });

    for (const tab of tabs) {
      if (!isUrlWorthBookmarking(tab.url)) {
        bookmarkingResults.skipped++;
        continue;
      }
      const wasCreated = await createBookmarkForSingleTab(tab, subfolder.id);
      if (wasCreated) {
        bookmarkingResults.created++;
      } else {
        bookmarkingResults.failed++;
      }
    }

    logger.info('Group bookmarked as subfolder', {
      groupTitle: subfolderName,
      subfolderId: subfolder.id,
      tabsCreated: bookmarkingResults.created,
      tabsSkipped: bookmarkingResults.skipped,
      tabsFailed: bookmarkingResults.failed,
    }, correlationId);
  } catch (error) {
    logger.error('Failed to create group subfolder', {
      groupTitle: subfolderName,
      error: error.message,
      errorCode: ERROR_CODES.ERR_BOOKMARK_FOLDER,
    }, correlationId);
  }

  return bookmarkingResults;
}
