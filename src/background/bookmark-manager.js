import { STORAGE_KEYS, BOOKMARK_BLOCKED_URLS, DEFAULT_BOOKMARK_SETTINGS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('background');

// Cached "Other Bookmarks" node ID — discovered once per service worker lifecycle
let cachedOtherBookmarksId = null;

/**
 * Discovers the "Other Bookmarks" node ID via chrome.bookmarks.getTree().
 * Caches the result for subsequent calls within the same service worker lifecycle.
 * @returns {Promise<string>} The bookmark node ID of "Other Bookmarks"
 */
export async function getOtherBookmarksId() {
  if (cachedOtherBookmarksId) return cachedOtherBookmarksId;

  const tree = await chrome.bookmarks.getTree();
  const otherBookmarks = tree[0].children.find(
    (node) => node.title === 'Other Bookmarks' || node.title === 'Other bookmarks'
  );

  if (!otherBookmarks) {
    // Fallback: "Other Bookmarks" is typically the second child (id "2")
    cachedOtherBookmarksId = tree[0].children.length > 1 ? tree[0].children[1].id : tree[0].children[0].id;
  } else {
    cachedOtherBookmarksId = otherBookmarks.id;
  }

  return cachedOtherBookmarksId;
}

/**
 * Resolves the bookmark folder for storing closed-tab bookmarks.
 * Implements the folder lookup algorithm: stored ID → name fallback → create new.
 * Detects external renames (FR-018) and updates settings accordingly.
 * @param {object} settings - The current v1_settings object
 * @returns {Promise<string|null>} The folder's bookmark node ID, or null on failure
 */
export async function resolveBookmarkFolder(settings) {
  const cid = logger.correlationId();
  const folderName = settings.bookmarkFolderName || DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_FOLDER_NAME;

  try {
    // Step 1: Read stored folder ID
    const stored = await chrome.storage.local.get(STORAGE_KEYS.BOOKMARK_STATE);
    const bookmarkState = stored[STORAGE_KEYS.BOOKMARK_STATE] || { folderId: null };
    let folderId = bookmarkState.folderId;

    // Step 2: If we have a stored ID, verify it
    if (folderId) {
      try {
        const results = await chrome.bookmarks.get(folderId);
        const folder = results[0];

        // FR-018: Detect external rename and sync settings
        if (folder.title !== folderName) {
          logger.info('Bookmark folder renamed externally, syncing settings', {
            oldName: folderName,
            newName: folder.title,
            folderId,
          }, cid);
          const currentSettings = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
          if (currentSettings) {
            currentSettings.bookmarkFolderName = folder.title;
            await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: currentSettings });
          }
        }

        return folderId;
      } catch {
        // Stored ID is invalid (folder deleted) — clear and fall through
        logger.debug('Stored bookmark folder ID invalid, falling back to name search', { folderId }, cid);
        folderId = null;
      }
    }

    // Step 3: Scan "Other Bookmarks" children by name
    const otherBookmarksId = await getOtherBookmarksId();
    const children = await chrome.bookmarks.getChildren(otherBookmarksId);
    const match = children.find((node) => !node.url && node.title === folderName);

    if (match) {
      // Found by name — persist the ID
      await chrome.storage.local.set({
        [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: match.id },
      });
      logger.debug('Bookmark folder found by name', { folderId: match.id, folderName }, cid);
      return match.id;
    }

    // Step 4: Create new folder
    const newFolder = await chrome.bookmarks.create({
      parentId: otherBookmarksId,
      title: folderName,
    });

    await chrome.storage.local.set({
      [STORAGE_KEYS.BOOKMARK_STATE]: { folderId: newFolder.id },
    });
    logger.info('Bookmark folder created', { folderId: newFolder.id, folderName }, cid);
    return newFolder.id;
  } catch (err) {
    logger.error('Failed to resolve bookmark folder', {
      error: err.message,
      errorCode: ERROR_CODES.ERR_BOOKMARK_FOLDER,
    }, cid);
    return null;
  }
}

/**
 * Checks whether a URL should be bookmarked.
 * Returns false for empty, chrome://newtab, chrome://newtab/, and about:blank.
 * @param {string} url - The tab URL to check
 * @returns {boolean} True if the URL should be bookmarked
 */
export function isBookmarkableUrl(url) {
  if (!url) return false;
  return !BOOKMARK_BLOCKED_URLS.includes(url);
}

/**
 * Creates a bookmark for a single tab.
 * Falls back to URL as title if tab title is empty.
 * Wraps in try/catch — never throws.
 * @param {object} tab - Object with at least { title, url }
 * @param {string} parentId - The bookmark folder ID to create the bookmark in
 * @returns {Promise<boolean>} True if bookmark was created successfully
 */
export async function bookmarkTab(tab, parentId) {
  const cid = logger.correlationId();
  try {
    const title = tab.title && tab.title.trim() ? tab.title : tab.url;
    await chrome.bookmarks.create({
      parentId,
      title,
      url: tab.url,
    });
    return true;
  } catch (err) {
    logger.warn('Failed to create bookmark for tab', {
      tabId: tab.id,
      url: tab.url,
      error: err.message,
      errorCode: ERROR_CODES.ERR_BOOKMARK_CREATE,
    }, cid);
    return false;
  }
}

/**
 * Creates a subfolder for a tab group and bookmarks each tab inside it.
 * Uses "(unnamed)" if the group title is empty.
 * Filters out non-bookmarkable URLs.
 * @param {string} groupTitle - The tab group's title
 * @param {Array} tabs - Array of tab objects with { id, title, url }
 * @param {string} parentId - The root bookmark folder ID
 * @returns {Promise<{created: number, skipped: number, failed: number}>}
 */
export async function bookmarkGroupTabs(groupTitle, tabs, parentId) {
  const cid = logger.correlationId();
  const subfolderName = groupTitle && groupTitle.trim() ? groupTitle : '(unnamed)';
  const result = { created: 0, skipped: 0, failed: 0 };

  try {
    const subfolder = await chrome.bookmarks.create({
      parentId,
      title: subfolderName,
    });

    for (const tab of tabs) {
      if (!isBookmarkableUrl(tab.url)) {
        result.skipped++;
        continue;
      }
      const success = await bookmarkTab(tab, subfolder.id);
      if (success) {
        result.created++;
      } else {
        result.failed++;
      }
    }

    logger.info('Group bookmarked as subfolder', {
      groupTitle: subfolderName,
      subfolderId: subfolder.id,
      tabsCreated: result.created,
      tabsSkipped: result.skipped,
      tabsFailed: result.failed,
    }, cid);
  } catch (err) {
    logger.error('Failed to create group subfolder', {
      groupTitle: subfolderName,
      error: err.message,
      errorCode: ERROR_CODES.ERR_BOOKMARK_FOLDER,
    }, cid);
  }

  return result;
}
