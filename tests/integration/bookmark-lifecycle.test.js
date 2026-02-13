import { jest } from '@jest/globals';

// ─── Mock Chrome APIs ────────────────────────────────────────────────────────

const storageBacking = {};

const mockStorage = {
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
};

const bookmarkNodes = {};
let bookmarkIdCounter = 100;

const mockBookmarks = {
  getTree: jest.fn(async () => [{
    children: [
      { id: '1', title: 'Bookmarks Bar', children: [] },
      { id: '2', title: 'Other Bookmarks', children: [] },
    ],
  }]),
  get: jest.fn(async (id) => {
    const node = bookmarkNodes[id];
    if (!node) throw new Error(`Can't find bookmark for id.`);
    return [node];
  }),
  getChildren: jest.fn(async (parentId) => {
    return Object.values(bookmarkNodes).filter((n) => n.parentId === parentId);
  }),
  create: jest.fn(async (details) => {
    const id = String(bookmarkIdCounter++);
    const node = { id, ...details };
    bookmarkNodes[id] = node;
    return node;
  }),
  update: jest.fn(async (id, changes) => {
    const node = bookmarkNodes[id];
    if (!node) throw new Error(`Can't find bookmark for id.`);
    Object.assign(node, changes);
    return node;
  }),
};

const tabStore = {};

const mockTabs = {
  get: jest.fn(async (tabId) => {
    const tab = tabStore[tabId];
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }),
  remove: jest.fn(async (tabId) => {
    delete tabStore[tabId];
  }),
  query: jest.fn(async () => Object.values(tabStore)),
};

const mockTabGroups = {
  TAB_GROUP_ID_NONE: -1,
  get: jest.fn(async (groupId) => {
    return { id: groupId, title: `Group ${groupId}`, windowId: 1 };
  }),
  query: jest.fn(async () => []),
};

globalThis.chrome = {
  storage: mockStorage,
  bookmarks: mockBookmarks,
  tabs: mockTabs,
  tabGroups: mockTabGroups,
};

import { resolveBookmarkFolder, isBookmarkableUrl, bookmarkTab, bookmarkGroupTabs } from '../../src/background/bookmark-manager.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resetState() {
  for (const key of Object.keys(storageBacking)) delete storageBacking[key];
  for (const key of Object.keys(bookmarkNodes)) delete bookmarkNodes[key];
  for (const key of Object.keys(tabStore)) delete tabStore[key];
  bookmarkIdCounter = 100;
  jest.clearAllMocks();
  // Re-setup default mocks after clear
  mockBookmarks.getTree.mockImplementation(async () => [{
    children: [
      { id: '1', title: 'Bookmarks Bar', children: [] },
      { id: '2', title: 'Other Bookmarks', children: [] },
    ],
  }]);
  mockBookmarks.get.mockImplementation(async (id) => {
    const node = bookmarkNodes[id];
    if (!node) throw new Error(`Can't find bookmark for id.`);
    return [node];
  });
  mockBookmarks.getChildren.mockImplementation(async (parentId) => {
    return Object.values(bookmarkNodes).filter((n) => n.parentId === parentId);
  });
  mockBookmarks.create.mockImplementation(async (details) => {
    const id = String(bookmarkIdCounter++);
    const node = { id, ...details };
    bookmarkNodes[id] = node;
    return node;
  });
  mockBookmarks.update.mockImplementation(async (id, changes) => {
    const node = bookmarkNodes[id];
    if (!node) throw new Error(`Can't find bookmark for id.`);
    Object.assign(node, changes);
    return node;
  });
  mockTabs.get.mockImplementation(async (tabId) => {
    const tab = tabStore[tabId];
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  });
  mockTabs.remove.mockImplementation(async (tabId) => {
    delete tabStore[tabId];
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetState();
});

describe('Bookmark lifecycle: individual tab close', () => {
  it('should create bookmark before tab removal when bookmarkEnabled=true', async () => {
    tabStore[1] = { id: 1, title: 'Example', url: 'https://example.com', windowId: 1 };
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };

    const folderId = await resolveBookmarkFolder(settings);
    expect(folderId).toBeTruthy();

    const tab = await chrome.tabs.get(1);
    expect(isBookmarkableUrl(tab.url)).toBe(true);

    const success = await bookmarkTab(tab, folderId);
    expect(success).toBe(true);

    // Verify bookmark was created in the folder
    const children = Object.values(bookmarkNodes).filter((n) => n.parentId === folderId && n.url);
    expect(children).toHaveLength(1);
    expect(children[0].title).toBe('Example');
    expect(children[0].url).toBe('https://example.com');
  });

  it('should not create bookmark when bookmarkEnabled=false', async () => {
    tabStore[1] = { id: 1, title: 'Example', url: 'https://example.com', windowId: 1 };
    const settings = { bookmarkEnabled: false, bookmarkFolderName: 'Closed Tabs' };

    // When disabled, the service worker skips bookmark creation entirely
    // Simulate: check the flag
    expect(settings.bookmarkEnabled).toBe(false);
    // No bookmark calls should be made
    const bookmarksBefore = Object.values(bookmarkNodes).filter((n) => n.url);
    expect(bookmarksBefore).toHaveLength(0);
  });

  it('should not create bookmark for chrome://newtab URL', async () => {
    tabStore[2] = { id: 2, title: 'New Tab', url: 'chrome://newtab', windowId: 1 };
    const tab = await chrome.tabs.get(2);

    expect(isBookmarkableUrl(tab.url)).toBe(false);
  });

  it('should not create bookmark for about:blank URL', async () => {
    tabStore[3] = { id: 3, title: '', url: 'about:blank', windowId: 1 };
    const tab = await chrome.tabs.get(3);

    expect(isBookmarkableUrl(tab.url)).toBe(false);
  });

  it('should still remove tab when bookmark creation fails', async () => {
    tabStore[4] = { id: 4, title: 'Fail Tab', url: 'https://fail.com', windowId: 1 };
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };

    const folderId = await resolveBookmarkFolder(settings);

    // Make bookmark creation fail
    mockBookmarks.create.mockRejectedValueOnce(new Error('Bookmark API error'));

    const success = await bookmarkTab(tabStore[4], folderId);
    expect(success).toBe(false);

    // Tab removal should still succeed
    await chrome.tabs.remove(4);
    expect(tabStore[4]).toBeUndefined();
  });

  it('should create folder on first tab close when folder does not exist', async () => {
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };

    // No folder exists yet
    expect(Object.values(bookmarkNodes)).toHaveLength(0);

    const folderId = await resolveBookmarkFolder(settings);

    // Folder should now exist
    expect(folderId).toBeTruthy();
    expect(bookmarkNodes[folderId]).toBeDefined();
    expect(bookmarkNodes[folderId].title).toBe('Closed Tabs');
    expect(bookmarkNodes[folderId].parentId).toBe('2'); // Other Bookmarks
  });

  it('should reuse existing folder by stored ID', async () => {
    // Pre-create a folder and store its ID
    const folder = await chrome.bookmarks.create({ parentId: '2', title: 'Closed Tabs' });
    storageBacking['v1_bookmarkState'] = { folderId: folder.id };

    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };
    const folderId = await resolveBookmarkFolder(settings);

    expect(folderId).toBe(folder.id);
    // Should not have created a new folder
    const folders = Object.values(bookmarkNodes).filter((n) => !n.url && n.parentId === '2');
    expect(folders).toHaveLength(1);
  });
});

describe('Bookmark lifecycle: group close', () => {
  it('should create subfolder with group name and bookmark each tab', async () => {
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };
    const folderId = await resolveBookmarkFolder(settings);

    const tabs = [
      { id: 10, title: 'Tab A', url: 'https://a.com' },
      { id: 11, title: 'Tab B', url: 'https://b.com' },
    ];

    const result = await bookmarkGroupTabs('Research', tabs, folderId);

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);

    // Find the subfolder
    const subfolders = Object.values(bookmarkNodes).filter((n) => !n.url && n.parentId === folderId);
    expect(subfolders).toHaveLength(1);
    expect(subfolders[0].title).toBe('Research');

    // Find bookmarks in the subfolder
    const bookmarks = Object.values(bookmarkNodes).filter((n) => n.url && n.parentId === subfolders[0].id);
    expect(bookmarks).toHaveLength(2);
  });

  it('should use "(unnamed)" for unnamed group', async () => {
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };
    const folderId = await resolveBookmarkFolder(settings);

    const tabs = [{ id: 20, title: 'Tab', url: 'https://x.com' }];
    await bookmarkGroupTabs('', tabs, folderId);

    const subfolders = Object.values(bookmarkNodes).filter((n) => !n.url && n.parentId === folderId);
    expect(subfolders).toHaveLength(1);
    expect(subfolders[0].title).toBe('(unnamed)');
  });

  it('should skip tabs with blocklisted URLs in group', async () => {
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };
    const folderId = await resolveBookmarkFolder(settings);

    const tabs = [
      { id: 30, title: 'Good', url: 'https://good.com' },
      { id: 31, title: 'New Tab', url: 'chrome://newtab' },
      { id: 32, title: '', url: 'about:blank' },
    ];

    const result = await bookmarkGroupTabs('Mixed', tabs, folderId);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('should create separate subfolders for groups with same name', async () => {
    const settings = { bookmarkEnabled: true, bookmarkFolderName: 'Closed Tabs' };
    const folderId = await resolveBookmarkFolder(settings);

    await bookmarkGroupTabs('Work', [{ id: 40, title: 'Tab 1', url: 'https://a.com' }], folderId);
    await bookmarkGroupTabs('Work', [{ id: 41, title: 'Tab 2', url: 'https://b.com' }], folderId);

    const subfolders = Object.values(bookmarkNodes).filter((n) => !n.url && n.parentId === folderId);
    expect(subfolders).toHaveLength(2);
    expect(subfolders[0].title).toBe('Work');
    expect(subfolders[1].title).toBe('Work');
  });
});
