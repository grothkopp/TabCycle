/**
 * E2E Chrome Test Harness
 *
 * Launches a real Chrome instance with the TabCycle extension loaded and
 * provides helpers to interact with the extension's service worker, storage,
 * tabs, and groups via the Chrome DevTools Protocol (CDP).
 *
 * Requirements:
 *   - Puppeteer (already in devDependencies)
 *   - Chrome/Chromium binary path in CHROME_PATH or PUPPETEER_EXECUTABLE_PATH
 *
 * Usage:
 *   import { createHarness } from './harness.js';
 *   const h = await createHarness();
 *   // ... run tests ...
 *   await h.cleanup();
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../src');

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH;

// ─── Storage keys (must match src/shared/constants.js) ──────────────────────
const SK = {
  SETTINGS: 'v1_settings',
  TAB_META: 'v1_tabMeta',
  WINDOW_STATE: 'v1_windowState',
  ACTIVE_TIME: 'v1_activeTime',
  BOOKMARK_STATE: 'v1_bookmarkState',
};

// ─── Harness Factory ────────────────────────────────────────────────────────

export async function createHarness(opts = {}) {
  if (!CHROME_PATH) {
    throw new Error(
      'No Chrome binary found. Set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH.'
    );
  }

  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: false,
    executablePath: CHROME_PATH,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      ...(opts.extraArgs || []),
    ],
    defaultViewport: null,
  });

  // Wait for the service worker target to appear
  const swTarget = await waitForServiceWorker(browser, 10_000);
  const extensionId = new URL(swTarget.url()).hostname;

  // Get a CDP session to the service worker so we can evaluate code in its context
  const swWorker = await swTarget.worker();

  const harness = {
    browser,
    extensionId,
    swTarget,
    swWorker,

    // ── Storage helpers ─────────────────────────────────────────────────

    /** Read one or more keys from chrome.storage.local (runs in SW context) */
    async readStorage(keys) {
      return swWorker.evaluate(async (ks) => {
        return chrome.storage.local.get(ks);
      }, keys);
    },

    /** Write to chrome.storage.local (runs in SW context) */
    async writeStorage(data) {
      return swWorker.evaluate(async (d) => {
        return chrome.storage.local.set(d);
      }, data);
    },

    /** Convenience: read tabMeta */
    async getTabMeta() {
      const result = await harness.readStorage([SK.TAB_META]);
      return result[SK.TAB_META] || {};
    },

    /** Convenience: read windowState */
    async getWindowState() {
      const result = await harness.readStorage([SK.WINDOW_STATE]);
      return result[SK.WINDOW_STATE] || {};
    },

    /** Convenience: read settings */
    async getSettings() {
      const result = await harness.readStorage([SK.SETTINGS]);
      return result[SK.SETTINGS] || {};
    },

    // ── Settings helpers ────────────────────────────────────────────────

    /**
     * Set very short thresholds (in ms) so tests don't have to wait hours.
     * Also sets timeMode to 'wallclock' so elapsed real time drives transitions.
     */
    async setFastThresholds({
      greenToYellow = 2000,
      yellowToRed = 4000,
      redToGone = 6000,
      timeMode = 'wallclock',
      bookmarkEnabled = false,
    } = {}) {
      const settings = await harness.getSettings();
      const updated = {
        ...settings,
        timeMode,
        thresholds: { greenToYellow, yellowToRed, redToGone },
        bookmarkEnabled,
      };
      await harness.writeStorage({ [SK.SETTINGS]: updated });
      // Wait for storage change listener to fire
      await sleep(300);
    },

    /**
     * Backdate a tab's refresh times so it appears old without waiting.
     * @param {number|string} tabId
     * @param {number} ageMs - How old the tab should appear (in ms)
     */
    async backdateTab(tabId, ageMs) {
      const tabMeta = await harness.getTabMeta();
      const meta = tabMeta[tabId] || tabMeta[String(tabId)];
      if (!meta) throw new Error(`Tab ${tabId} not found in tabMeta`);
      meta.refreshWallTime = Date.now() - ageMs;
      meta.refreshActiveTime = Math.max(0, meta.refreshActiveTime - ageMs);
      await harness.writeStorage({ [SK.TAB_META]: tabMeta });
    },

    // ── Evaluation cycle trigger ────────────────────────────────────────

    /**
     * Trigger the extension's evaluation cycle by firing the alarm.
     * We use chrome.alarms API from the service worker context.
     */
    async triggerEvaluation() {
      await swWorker.evaluate(async () => {
        // Clear and recreate the alarm to force an immediate fire
        await chrome.alarms.clear('tabcycle-eval');
        await chrome.alarms.create('tabcycle-eval', { when: Date.now() });
      });
      // Wait for the alarm handler + evaluation cycle to complete
      await sleep(1500);
    },

    // ── Tab helpers ─────────────────────────────────────────────────────

    /** Open a new tab and return its Chrome tab ID */
    async openTab(url = 'about:blank') {
      const tabId = await swWorker.evaluate(async (u) => {
        const tab = await chrome.tabs.create({ url: u });
        return tab.id;
      }, url);
      await sleep(500); // let onCreated handler run
      return tabId;
    },

    /** Open multiple tabs, return array of tab IDs */
    async openTabs(count, url = 'about:blank') {
      const ids = [];
      for (let i = 0; i < count; i++) {
        ids.push(await harness.openTab(url));
      }
      return ids;
    },

    /** Close a tab by ID */
    async closeTab(tabId) {
      await swWorker.evaluate(async (id) => {
        await chrome.tabs.remove(id);
      }, tabId);
      await sleep(300);
    },

    /** Get all Chrome tabs in a window (or all windows if windowId is omitted) */
    async queryTabs(queryOpts = {}) {
      return swWorker.evaluate(async (opts) => {
        return chrome.tabs.query(opts);
      }, queryOpts);
    },

    /** Get a single tab by ID */
    async getTab(tabId) {
      return swWorker.evaluate(async (id) => {
        return chrome.tabs.get(id);
      }, tabId);
    },

    /** Navigate a tab to a URL */
    async navigateTab(tabId, url) {
      await swWorker.evaluate(async (id, u) => {
        await chrome.tabs.update(id, { url: u });
      }, tabId, url);
      await sleep(800); // let navigation handler run
    },

    // ── Group helpers ───────────────────────────────────────────────────

    /** Get all tab groups in a window */
    async queryGroups(windowId) {
      const opts = windowId !== undefined ? { windowId } : {};
      return swWorker.evaluate(async (o) => {
        return chrome.tabGroups.query(o);
      }, opts);
    },

    /** Get a single group by ID */
    async getGroup(groupId) {
      return swWorker.evaluate(async (id) => {
        return chrome.tabGroups.get(id);
      }, groupId);
    },

    /** Create a user-named tab group from given tab IDs */
    async createUserGroup(tabIds, title, windowId) {
      const groupId = await swWorker.evaluate(async (ids, t, wid) => {
        const gid = await chrome.tabs.group({
          tabIds: ids,
          createProperties: wid !== undefined ? { windowId: wid } : undefined,
        });
        if (t !== undefined) {
          await chrome.tabGroups.update(gid, { title: t });
        }
        return gid;
      }, tabIds, title, windowId);
      await sleep(300);
      return groupId;
    },

    /** Get tabs in a specific group */
    async getTabsInGroup(groupId) {
      return swWorker.evaluate(async (gid) => {
        return chrome.tabs.query({ groupId: gid });
      }, groupId);
    },

    // ── Bookmark helpers ────────────────────────────────────────────────

    /** Get all bookmarks under a folder name */
    async getBookmarksInFolder(folderName) {
      return swWorker.evaluate(async (name) => {
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
        return folder ? folder.children || [] : [];
      }, folderName);
    },

    // ── Window helpers ──────────────────────────────────────────────────

    /** Get the first (main) window ID */
    async getMainWindowId() {
      const windows = await swWorker.evaluate(async () => {
        return chrome.windows.getAll({ windowTypes: ['normal'] });
      });
      if (windows.length === 0) throw new Error('No browser windows found');
      return windows[0].id;
    },

    // ── Snapshot: capture full observable state ─────────────────────────

    /**
     * Capture a snapshot of the current browser state for assertions.
     * Returns: { tabs, groups, tabMeta, windowState, settings }
     */
    async snapshot(windowId) {
      const wid = windowId || await harness.getMainWindowId();
      const [tabs, groups, tabMeta, windowState, settings] = await Promise.all([
        harness.queryTabs({ windowId: wid }),
        harness.queryGroups(wid),
        harness.getTabMeta(),
        harness.getWindowState(),
        harness.getSettings(),
      ]);
      return { tabs, groups, tabMeta, windowState, settings, windowId: wid };
    },

    // ── Cleanup ─────────────────────────────────────────────────────────

    /** Close all tabs except one (to avoid closing the window) then close browser */
    async cleanup() {
      try {
        await browser.close();
      } catch { /* ignore */ }
    },

    /**
     * Close all non-pinned tabs except the first one, to reset state between tests.
     */
    async resetTabs() {
      const tabs = await harness.queryTabs({});
      // Keep the first tab, close the rest
      const toClose = tabs.filter((_, i) => i > 0).map((t) => t.id);
      if (toClose.length > 0) {
        await swWorker.evaluate(async (ids) => {
          await chrome.tabs.remove(ids);
        }, toClose);
      }
      await sleep(500);
    },
  };

  // Wait for extension to finish its onInstalled initialization
  await sleep(2000);

  return harness;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServiceWorker(browser, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await browser.targets();
    const sw = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );
    if (sw) return sw;
    await sleep(200);
  }
  throw new Error('Service worker target not found within timeout');
}

export { SK };
