/**
 * E2E: Gone Tab Handling & Bookmarks
 *
 * Verifies that tabs reaching the "gone" status are:
 *   - Bookmarked (when bookmarkEnabled=true) in the configured folder
 *   - Closed/removed from the browser
 *   - Cleaned up from tabMeta
 *
 * Also verifies that gone user groups are bookmarked as a group.
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Gone Tab Handling & Bookmarks (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  beforeEach(async () => {
    await h.resetTabs();
  });

  describe('without bookmarks', () => {
    beforeEach(async () => {
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 4000,
        redToGone: 6000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });
    });

    it('gone ungrouped tab is closed', async () => {
      const tabId = await h.openTab('https://example.com');
      await h.backdateTab(tabId, 7000);
      await h.triggerEvaluation();

      const tabs = await h.queryTabs({});
      expect(tabs.some((t) => t.id === tabId)).toBe(false);
    }, 20_000);

    it('gone tab is removed from tabMeta', async () => {
      const tabId = await h.openTab('https://example.com');
      await h.backdateTab(tabId, 7000);
      await h.triggerEvaluation();

      const meta = await h.getTabMeta();
      expect(meta[tabId]).toBeUndefined();
      expect(meta[String(tabId)]).toBeUndefined();
    }, 20_000);

    it('gone user group: all tabs closed', async () => {
      const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
      const windowId = (await h.getTab(tab1)).windowId;
      await h.createUserGroup([tab1, tab2], 'DoomedGroup', windowId);
      // Wait for extension to process group events and update tabMeta.groupId
      await sleep(1000);
      await h.triggerEvaluation();

      await h.backdateTab(tab1, 7000);
      await h.backdateTab(tab2, 7000);
      await h.triggerEvaluation();

      const tabs = await h.queryTabs({});
      expect(tabs.some((t) => t.id === tab1)).toBe(false);
      expect(tabs.some((t) => t.id === tab2)).toBe(false);
    }, 30_000);
  });

  describe('with bookmarks enabled', () => {
    const FOLDER_NAME = 'TabCycle E2E Test';

    beforeEach(async () => {
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 4000,
        redToGone: 6000,
        timeMode: 'wallclock',
        bookmarkEnabled: true,
      });
      // Set a unique folder name for test isolation
      const settings = await h.getSettings();
      settings.bookmarkFolderName = FOLDER_NAME;
      await h.writeStorage({ v1_settings: settings });
      await sleep(300);
    });

    afterEach(async () => {
      // Clean up test bookmarks
      try {
        await h.evalFn(async (name) => {
          const tree = await chrome.bookmarks.getTree();
          function findFolder(nodes) {
            for (const node of nodes) {
              if (node.title === name && node.children) return node;
              if (node.children) {
                const found = findFolder(node.children);
                if (found) return found;
              }
            }
            return null;
          }
          const folder = findFolder(tree);
          if (folder) await chrome.bookmarks.removeTree(folder.id);
        }, FOLDER_NAME);
      } catch { /* best effort cleanup */ }
    });

    it('gone tab is bookmarked before closing', async () => {
      const tabId = await h.openTab('https://example.com/bookmarktest');
      await h.backdateTab(tabId, 7000);
      await h.triggerEvaluation();

      // Tab should be closed
      const tabs = await h.queryTabs({});
      expect(tabs.some((t) => t.id === tabId)).toBe(false);

      // Bookmark should exist in the folder
      const bookmarks = await h.getBookmarksInFolder(FOLDER_NAME);
      const found = bookmarks.some((b) => b.url === 'https://example.com/bookmarktest');
      expect(found).toBe(true);
    }, 25_000);

    it('non-bookmarkable URLs (chrome://, about:blank) are not bookmarked', async () => {
      const tabId = await h.openTab('about:blank');
      await h.backdateTab(tabId, 7000);
      await h.triggerEvaluation();

      // Tab should be closed
      const tabs = await h.queryTabs({});
      expect(tabs.some((t) => t.id === tabId)).toBe(false);

      // No bookmark should have been created for about:blank
      const bookmarks = await h.getBookmarksInFolder(FOLDER_NAME);
      const blankBookmark = bookmarks.some((b) => b.url === 'about:blank');
      expect(blankBookmark).toBe(false);
    }, 25_000);

    it('gone user group tabs are bookmarked as a group', async () => {
      const [tab1, tab2] = await h.openTabs(2);
      // Navigate to real URLs so they're bookmarkable
      await h.navigateTab(tab1, 'https://example.com/group-tab-1');
      await h.navigateTab(tab2, 'https://example.com/group-tab-2');

      const windowId = (await h.getTab(tab1)).windowId;
      await h.createUserGroup([tab1, tab2], 'BookmarkGroup', windowId);
      // Wait for extension to process group events and update tabMeta.groupId
      await sleep(1000);
      await h.triggerEvaluation();

      await h.backdateTab(tab1, 7000);
      await h.backdateTab(tab2, 7000);
      await h.triggerEvaluation();

      // Both tabs should be closed
      const tabs = await h.queryTabs({});
      expect(tabs.some((t) => t.id === tab1)).toBe(false);
      expect(tabs.some((t) => t.id === tab2)).toBe(false);

      // Bookmarks should exist — either as individual bookmarks or under a subfolder
      const bookmarks = await h.getBookmarksInFolder(FOLDER_NAME);
      // The group bookmark creates a subfolder with the group name
      const subFolder = bookmarks.find(
        (b) => b.title === 'BookmarkGroup' && b.children
      );

      if (subFolder) {
        // Group was bookmarked as a subfolder
        expect(subFolder.children.length).toBeGreaterThanOrEqual(2);
      } else {
        // Individual bookmarks
        const urls = bookmarks.map((b) => b.url).filter(Boolean);
        expect(urls).toContain('https://example.com/group-tab-1');
        expect(urls).toContain('https://example.com/group-tab-2');
      }
    }, 35_000);
  });
});
