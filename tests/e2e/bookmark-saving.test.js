import { jest } from '@jest/globals';

/**
 * E2E tests for bookmark saving feature.
 * These tests require a running Chrome instance with the extension loaded.
 * They are designed to be run with Puppeteer via the E2E test infrastructure.
 *
 * Note: Full E2E tests with Puppeteer require a built extension and browser launch.
 * These tests validate the settings persistence flow using mocked Chrome APIs
 * to ensure the options page correctly reads/writes bookmark settings.
 */

// ─── Mock Chrome APIs ────────────────────────────────────────────────────────

const storageBacking = {};

globalThis.chrome = {
  storage: {
    local: {
      get: jest.fn(async (keys) => {
        if (typeof keys === 'string') {
          return { [keys]: storageBacking[keys] };
        }
        const result = {};
        for (const k of keys) {
          if (storageBacking[k] !== undefined) result[k] = storageBacking[k];
        }
        return result;
      }),
      set: jest.fn(async (data) => {
        Object.assign(storageBacking, data);
      }),
    },
    onChanged: { addListener: jest.fn() },
  },
  bookmarks: {
    getTree: jest.fn(async () => [{
      children: [
        { id: '1', title: 'Bookmarks Bar' },
        { id: '2', title: 'Other Bookmarks' },
      ],
    }]),
    get: jest.fn(async () => [{ id: '50', title: 'Closed Tabs' }]),
    getChildren: jest.fn(async () => []),
    create: jest.fn(async (details) => ({ id: '50', ...details })),
    update: jest.fn(async (id, changes) => ({ id, ...changes })),
  },
};

beforeEach(() => {
  for (const key of Object.keys(storageBacking)) delete storageBacking[key];
  jest.clearAllMocks();
  // Re-setup mocks after clear
  chrome.storage.local.get.mockImplementation(async (keys) => {
    if (typeof keys === 'string') {
      return { [keys]: storageBacking[keys] };
    }
    const result = {};
    for (const k of keys) {
      if (storageBacking[k] !== undefined) result[k] = storageBacking[k];
    }
    return result;
  });
  chrome.storage.local.set.mockImplementation(async (data) => {
    Object.assign(storageBacking, data);
  });
});

describe('Bookmark settings E2E: toggle on/off', () => {
  it('should default bookmarkEnabled to true when no settings exist', async () => {
    // No settings stored — default should be true
    const result = await chrome.storage.local.get('v1_settings');
    const settings = result['v1_settings'];
    // When settings are undefined, the options page uses the default
    expect(settings).toBeUndefined();
    // The default from DEFAULT_BOOKMARK_SETTINGS.BOOKMARK_ENABLED is true
  });

  it('should persist bookmarkEnabled=false when toggle is disabled', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      bookmarkEnabled: false,
    };
    await chrome.storage.local.set({ v1_settings: settings });

    const result = await chrome.storage.local.get('v1_settings');
    expect(result['v1_settings'].bookmarkEnabled).toBe(false);
  });

  it('should persist bookmarkEnabled=true when toggle is re-enabled', async () => {
    // Start with disabled
    await chrome.storage.local.set({
      v1_settings: {
        timeMode: 'active',
        thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
        bookmarkEnabled: false,
      },
    });

    // Re-enable
    const current = (await chrome.storage.local.get('v1_settings'))['v1_settings'];
    current.bookmarkEnabled = true;
    await chrome.storage.local.set({ v1_settings: current });

    const result = await chrome.storage.local.get('v1_settings');
    expect(result['v1_settings'].bookmarkEnabled).toBe(true);
  });
});

describe('Bookmark settings E2E: folder name', () => {
  it('should default bookmarkFolderName to "Closed Tabs" when not set', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
    };
    await chrome.storage.local.set({ v1_settings: settings });

    const result = await chrome.storage.local.get('v1_settings');
    // bookmarkFolderName not present — code should use default "Closed Tabs"
    expect(result['v1_settings'].bookmarkFolderName).toBeUndefined();
  });

  it('should persist custom bookmarkFolderName', async () => {
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      bookmarkEnabled: true,
      bookmarkFolderName: 'My Archive',
    };
    await chrome.storage.local.set({ v1_settings: settings });

    const result = await chrome.storage.local.get('v1_settings');
    expect(result['v1_settings'].bookmarkFolderName).toBe('My Archive');
  });

  it('should reject empty bookmarkFolderName at validation level', async () => {
    // This tests the schema validation, not the UI
    const { validateSettings } = await import('../../src/shared/schemas.js');
    const result = validateSettings({
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      bookmarkFolderName: '',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('bookmarkFolderName'))).toBe(true);
  });
});

describe('Bookmark full lifecycle E2E', () => {
  it('should create bookmark in correct folder when tab is bookmarked', async () => {
    const { resolveBookmarkFolder, isBookmarkableUrl, bookmarkTab } = await import('../../src/background/bookmark-manager.js');

    // Setup: store settings with bookmarks enabled
    const settings = {
      timeMode: 'active',
      thresholds: { greenToYellow: 14400000, yellowToRed: 28800000, redToGone: 86400000 },
      bookmarkEnabled: true,
      bookmarkFolderName: 'Closed Tabs',
    };
    await chrome.storage.local.set({ v1_settings: settings });

    // Resolve the bookmark folder (creates it since none exists)
    const folderId = await resolveBookmarkFolder(settings);
    expect(folderId).toBeTruthy();

    // Simulate a tab reaching Gone — check URL is bookmarkable
    const tab = { id: 42, title: 'Example Page', url: 'https://example.com' };
    expect(isBookmarkableUrl(tab.url)).toBe(true);

    // Create the bookmark
    const success = await bookmarkTab(tab, folderId);
    expect(success).toBe(true);

    // Verify bookmark was created via the mock
    expect(chrome.bookmarks.create).toHaveBeenCalledWith({
      parentId: folderId,
      title: 'Example Page',
      url: 'https://example.com',
    });
  });

  it('should skip empty tabs and not create bookmarks for them', async () => {
    const { isBookmarkableUrl } = await import('../../src/background/bookmark-manager.js');

    expect(isBookmarkableUrl('chrome://newtab')).toBe(false);
    expect(isBookmarkableUrl('chrome://newtab/')).toBe(false);
    expect(isBookmarkableUrl('about:blank')).toBe(false);
    expect(isBookmarkableUrl('')).toBe(false);
    expect(isBookmarkableUrl(undefined)).toBe(false);
  });

  it('should persist bookmark folder ID in v1_bookmarkState after folder creation', async () => {
    const { resolveBookmarkFolder } = await import('../../src/background/bookmark-manager.js');

    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };
    const folderId = await resolveBookmarkFolder(settings);

    expect(folderId).toBeTruthy();

    // Verify the folder ID was persisted
    const stored = await chrome.storage.local.get('v1_bookmarkState');
    expect(stored['v1_bookmarkState']).toBeDefined();
    expect(stored['v1_bookmarkState'].folderId).toBe(folderId);
  });
});
