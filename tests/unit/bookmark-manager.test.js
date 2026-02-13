import { jest } from '@jest/globals';

// Mock chrome APIs before importing the module
const mockBookmarks = {
  getTree: jest.fn(),
  get: jest.fn(),
  getChildren: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

const mockStorage = {
  local: {
    get: jest.fn(),
    set: jest.fn(),
  },
};

globalThis.chrome = {
  bookmarks: mockBookmarks,
  storage: mockStorage,
};

import {
  getOtherBookmarksId,
  resolveBookmarkFolder,
  isBookmarkableUrl,
  bookmarkTab,
  bookmarkGroupTabs,
} from '../../src/background/bookmark-manager.js';

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the cached "Other Bookmarks" ID between tests
  // We do this by re-mocking getTree to always return a fresh tree
  mockBookmarks.getTree.mockResolvedValue([{
    children: [
      { id: '1', title: 'Bookmarks Bar' },
      { id: '2', title: 'Other Bookmarks' },
    ],
  }]);
  mockStorage.local.get.mockResolvedValue({});
  mockStorage.local.set.mockResolvedValue(undefined);
});

describe('isBookmarkableUrl', () => {
  it('should return false for empty string', () => {
    expect(isBookmarkableUrl('')).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isBookmarkableUrl(undefined)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isBookmarkableUrl(null)).toBe(false);
  });

  it('should return false for chrome://newtab', () => {
    expect(isBookmarkableUrl('chrome://newtab')).toBe(false);
  });

  it('should return false for chrome://newtab/', () => {
    expect(isBookmarkableUrl('chrome://newtab/')).toBe(false);
  });

  it('should return false for about:blank', () => {
    expect(isBookmarkableUrl('about:blank')).toBe(false);
  });

  it('should return true for a valid HTTP URL', () => {
    expect(isBookmarkableUrl('https://example.com')).toBe(true);
  });

  it('should return true for chrome://settings', () => {
    expect(isBookmarkableUrl('chrome://settings')).toBe(true);
  });

  it('should return true for file:// URL', () => {
    expect(isBookmarkableUrl('file:///home/user/doc.html')).toBe(true);
  });
});

describe('bookmarkTab', () => {
  it('should call chrome.bookmarks.create with correct params', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '100' });
    const tab = { id: 1, title: 'Test Page', url: 'https://example.com' };

    const result = await bookmarkTab(tab, '42');

    expect(result).toBe(true);
    expect(mockBookmarks.create).toHaveBeenCalledWith({
      parentId: '42',
      title: 'Test Page',
      url: 'https://example.com',
    });
  });

  it('should use URL as title when tab title is empty', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '100' });
    const tab = { id: 1, title: '', url: 'https://example.com' };

    await bookmarkTab(tab, '42');

    expect(mockBookmarks.create).toHaveBeenCalledWith({
      parentId: '42',
      title: 'https://example.com',
      url: 'https://example.com',
    });
  });

  it('should use URL as title when tab title is undefined', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '100' });
    const tab = { id: 1, url: 'https://example.com' };

    await bookmarkTab(tab, '42');

    expect(mockBookmarks.create).toHaveBeenCalledWith({
      parentId: '42',
      title: 'https://example.com',
      url: 'https://example.com',
    });
  });

  it('should use URL as title when tab title is whitespace only', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '100' });
    const tab = { id: 1, title: '   ', url: 'https://example.com' };

    await bookmarkTab(tab, '42');

    expect(mockBookmarks.create).toHaveBeenCalledWith({
      parentId: '42',
      title: 'https://example.com',
      url: 'https://example.com',
    });
  });

  it('should catch errors and return false without throwing', async () => {
    mockBookmarks.create.mockRejectedValue(new Error('Bookmark API error'));
    const tab = { id: 1, title: 'Test', url: 'https://example.com' };

    const result = await bookmarkTab(tab, '42');

    expect(result).toBe(false);
  });
});

describe('bookmarkGroupTabs', () => {
  it('should create subfolder then bookmark each tab', async () => {
    mockBookmarks.create
      .mockResolvedValueOnce({ id: '200' }) // subfolder
      .mockResolvedValue({ id: '201' }); // bookmarks

    const tabs = [
      { id: 1, title: 'Tab 1', url: 'https://a.com' },
      { id: 2, title: 'Tab 2', url: 'https://b.com' },
    ];

    const result = await bookmarkGroupTabs('My Group', tabs, '42');

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockBookmarks.create).toHaveBeenCalledTimes(3); // 1 subfolder + 2 bookmarks
    expect(mockBookmarks.create).toHaveBeenNthCalledWith(1, {
      parentId: '42',
      title: 'My Group',
    });
    expect(mockBookmarks.create).toHaveBeenNthCalledWith(2, {
      parentId: '200',
      title: 'Tab 1',
      url: 'https://a.com',
    });
  });

  it('should use "(unnamed)" for empty group title', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '200' });

    await bookmarkGroupTabs('', [{ id: 1, title: 'Tab', url: 'https://a.com' }], '42');

    expect(mockBookmarks.create).toHaveBeenNthCalledWith(1, {
      parentId: '42',
      title: '(unnamed)',
    });
  });

  it('should use "(unnamed)" for undefined group title', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '200' });

    await bookmarkGroupTabs(undefined, [{ id: 1, title: 'Tab', url: 'https://a.com' }], '42');

    expect(mockBookmarks.create).toHaveBeenNthCalledWith(1, {
      parentId: '42',
      title: '(unnamed)',
    });
  });

  it('should skip tabs with blocklisted URLs', async () => {
    mockBookmarks.create.mockResolvedValue({ id: '200' });

    const tabs = [
      { id: 1, title: 'Tab 1', url: 'https://a.com' },
      { id: 2, title: 'New Tab', url: 'chrome://newtab' },
      { id: 3, title: 'Blank', url: 'about:blank' },
    ];

    const result = await bookmarkGroupTabs('Group', tabs, '42');

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);
    // 1 subfolder + 1 bookmark (2 skipped)
    expect(mockBookmarks.create).toHaveBeenCalledTimes(2);
  });

  it('should count failed bookmarks without throwing', async () => {
    mockBookmarks.create
      .mockResolvedValueOnce({ id: '200' }) // subfolder succeeds
      .mockRejectedValueOnce(new Error('fail')) // first tab fails
      .mockResolvedValueOnce({ id: '202' }); // second tab succeeds

    const tabs = [
      { id: 1, title: 'Tab 1', url: 'https://a.com' },
      { id: 2, title: 'Tab 2', url: 'https://b.com' },
    ];

    const result = await bookmarkGroupTabs('Group', tabs, '42');

    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('resolveBookmarkFolder', () => {
  const defaultSettings = {
    bookmarkFolderName: 'Closed Tabs',
  };

  it('should return folder by stored ID when valid', async () => {
    mockStorage.local.get.mockImplementation((key) => {
      if (key === 'v1_bookmarkState') return Promise.resolve({ v1_bookmarkState: { folderId: '50' } });
      if (key === 'v1_settings') return Promise.resolve({ v1_settings: defaultSettings });
      return Promise.resolve({});
    });
    mockBookmarks.get.mockResolvedValue([{ id: '50', title: 'Closed Tabs' }]);

    const result = await resolveBookmarkFolder(defaultSettings);

    expect(result).toBe('50');
    expect(mockBookmarks.get).toHaveBeenCalledWith('50');
  });

  it('should fall back to name search when stored ID is invalid', async () => {
    mockStorage.local.get.mockImplementation((key) => {
      if (key === 'v1_bookmarkState') return Promise.resolve({ v1_bookmarkState: { folderId: '99' } });
      return Promise.resolve({});
    });
    mockBookmarks.get.mockRejectedValue(new Error('not found'));
    mockBookmarks.getChildren.mockResolvedValue([
      { id: '60', title: 'Closed Tabs' }, // folder (no url)
      { id: '61', title: 'Some Bookmark', url: 'https://x.com' },
    ]);

    const result = await resolveBookmarkFolder(defaultSettings);

    expect(result).toBe('60');
    expect(mockStorage.local.set).toHaveBeenCalledWith({
      v1_bookmarkState: { folderId: '60' },
    });
  });

  it('should create new folder when none found', async () => {
    mockStorage.local.get.mockResolvedValue({});
    mockBookmarks.getChildren.mockResolvedValue([]);
    mockBookmarks.create.mockResolvedValue({ id: '70' });

    const result = await resolveBookmarkFolder(defaultSettings);

    expect(result).toBe('70');
    expect(mockBookmarks.create).toHaveBeenCalledWith({
      parentId: '2',
      title: 'Closed Tabs',
    });
    expect(mockStorage.local.set).toHaveBeenCalledWith({
      v1_bookmarkState: { folderId: '70' },
    });
  });

  it('should detect external rename and update settings (FR-018)', async () => {
    mockStorage.local.get.mockImplementation((key) => {
      if (key === 'v1_bookmarkState') return Promise.resolve({ v1_bookmarkState: { folderId: '50' } });
      if (key === 'v1_settings') return Promise.resolve({ v1_settings: { ...defaultSettings, bookmarkFolderName: 'Closed Tabs' } });
      return Promise.resolve({});
    });
    // Folder was renamed externally to "My Renamed Folder"
    mockBookmarks.get.mockResolvedValue([{ id: '50', title: 'My Renamed Folder' }]);

    const result = await resolveBookmarkFolder(defaultSettings);

    expect(result).toBe('50');
    // Should have updated settings with the new name
    expect(mockStorage.local.set).toHaveBeenCalledWith({
      v1_settings: expect.objectContaining({
        bookmarkFolderName: 'My Renamed Folder',
      }),
    });
  });

  it('should use default folder name when settings field is missing', async () => {
    mockStorage.local.get.mockResolvedValue({});
    mockBookmarks.getChildren.mockResolvedValue([]);
    mockBookmarks.create.mockResolvedValue({ id: '80' });

    const result = await resolveBookmarkFolder({});

    expect(result).toBe('80');
    expect(mockBookmarks.create).toHaveBeenCalledWith({
      parentId: '2',
      title: 'Closed Tabs',
    });
  });

  it('should return null when all operations fail', async () => {
    mockStorage.local.get.mockRejectedValue(new Error('storage error'));

    const result = await resolveBookmarkFolder(defaultSettings);

    expect(result).toBeNull();
  });
});
