/**
 * E2E Chrome Test Harness
 *
 * Launches Puppeteer's bundled "Chrome for Testing" with the TabCycle
 * extension loaded and provides helpers to interact with the extension's
 * service worker, storage, tabs, and groups via the Chrome DevTools
 * Protocol (CDP).
 *
 * NOTE: Stable Google Chrome blocks --load-extension.  The bundled
 * "Chrome for Testing" binary supports it.  Override with CHROME_E2E_PATH
 * if you need a different binary (e.g. Chromium, Chrome Canary).
 *
 * Requirements:
 *   - Puppeteer (already in devDependencies — includes Chrome for Testing)
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

// ─── Storage keys (must match src/shared/constants.js) ──────────────────────
const SK = {
  SETTINGS: 'v1_settings',
  TAB_META: 'v1_tabMeta',
  WINDOW_STATE: 'v1_windowState',
  ACTIVE_TIME: 'v1_activeTime',
  BOOKMARK_STATE: 'v1_bookmarkState',
};

// ─── CDP helper: evaluate JS in the service worker context ──────────────────

/**
 * Evaluate an async expression string in the service worker via CDP.
 * Returns the deserialized result.
 */
async function cdpEval(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    const msg = exceptionDetails.exception?.description ||
                exceptionDetails.text ||
                JSON.stringify(exceptionDetails);
    throw new Error(`CDP eval error: ${msg}`);
  }
  return result.value;
}

/**
 * Evaluate an async function in the service worker, passing JSON-serialisable
 * arguments.  Mimics puppeteer's page.evaluate(fn, ...args) API.
 */
async function cdpEvalFn(cdp, fn, ...args) {
  const argList = args.map((a) => JSON.stringify(a)).join(', ');
  const expression = `(${fn.toString()})(${argList})`;
  return cdpEval(cdp, expression);
}

// ─── Harness Factory ────────────────────────────────────────────────────────

export async function createHarness(opts = {}) {
  const puppeteer = await import('puppeteer');

  // Use Puppeteer's bundled "Chrome for Testing" which supports --load-extension.
  // Stable Google Chrome blocks that flag.  Override with CHROME_E2E_PATH if needed.
  const executablePath = process.env.CHROME_E2E_PATH || puppeteer.default.executablePath();

  const browser = await puppeteer.default.launch({
    headless: false,
    executablePath,
    // Puppeteer adds --disable-extensions by default; we must remove it.
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      // CI runners (GitHub Actions) lack kernel sandbox support
      ...(process.env.CI ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
      ...(opts.extraArgs || []),
    ],
    defaultViewport: null,
  });

  // Wait for the extension's service worker target to appear.
  // We poll browser.targets() because waitForTarget can miss targets
  // that were created during launch() before the listener is attached.
  const swTarget = await pollForTarget(
    browser,
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    15_000
  );
  const extensionId = new URL(swTarget.url()).hostname;

  // Open a CDP session to the service worker (let — may be reassigned by ensureCdp)
  let cdp = await swTarget.createCDPSession();
  await cdp.send('Runtime.enable');

  const harness = {
    browser,
    extensionId,
    swTarget,
    cdp,

    /** Low-level: evaluate a JS expression string in the SW context */
    evalExpr: (expr) => cdpEval(cdp, expr),
    /** Low-level: evaluate a function with args in the SW context */
    evalFn: (fn, ...args) => cdpEvalFn(cdp, fn, ...args),

    // ── Storage helpers ─────────────────────────────────────────────────

    /** Read one or more keys from chrome.storage.local (runs in SW context) */
    async readStorage(keys) {
      return cdpEvalFn(cdp, async (ks) => {
        return chrome.storage.local.get(ks);
      }, keys);
    },

    /** Write to chrome.storage.local (runs in SW context) */
    async writeStorage(data) {
      return cdpEvalFn(cdp, async (d) => {
        await chrome.storage.local.set(d);
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
      // Skip write if settings are already identical — avoids triggering
      // storage.onChanged → runEvaluationCycle on every beforeEach.
      const same =
        settings.timeMode === timeMode &&
        settings.bookmarkEnabled === bookmarkEnabled &&
        settings.thresholds?.greenToYellow === greenToYellow &&
        settings.thresholds?.yellowToRed === yellowToRed &&
        settings.thresholds?.redToGone === redToGone;
      if (same) return;

      await harness.writeStorage({ [SK.SETTINGS]: updated });
      // Writing settings triggers storage.onChanged → runEvaluationCycle.
      // Wait for that cycle to fully complete before returning.
      await sleep(300); // let the listener fire
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const running = await cdpEval(cdp, 'self.__evaluationCycleRunning || false');
        if (!running) break;
        await sleep(200);
      }
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
     * Trigger the extension's evaluation cycle by calling the exposed
     * self.__runEvaluationCycle() directly and awaiting its completion.
     * Waits for any in-flight cycle (e.g. from storage.onChanged) to
     * finish first, so the guard never skips our call.
     */
    async triggerEvaluation() {
      await harness.ensureCdp();
      // Wait for any in-flight cycle to finish (e.g. triggered by setFastThresholds)
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const running = await cdpEval(cdp, 'self.__evaluationCycleRunning || false');
        if (!running) break;
        await sleep(200);
      }
      await cdpEvalFn(cdp, async () => {
        await self.__runEvaluationCycle('e2e-test');
      });
      // Brief settle time for Chrome to finish processing tab/group moves
      await sleep(500);
    },

    // ── Tab helpers ─────────────────────────────────────────────────────

    /** Open a new tab and return its Chrome tab ID */
    async openTab(url = 'about:blank') {
      const tabId = await cdpEvalFn(cdp, async (u) => {
        const tab = await chrome.tabs.create({ url: u });
        return tab.id;
      }, url);
      await sleep(1000); // let onCreated handler finish writing tabMeta
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
      await cdpEvalFn(cdp, async (id) => {
        await chrome.tabs.remove(id);
      }, tabId);
      await sleep(300);
    },

    /** Get all Chrome tabs in a window (or all windows if windowId is omitted) */
    async queryTabs(queryOpts = {}) {
      return cdpEvalFn(cdp, async (opts) => {
        return chrome.tabs.query(opts);
      }, queryOpts);
    },

    /** Get a single tab by ID */
    async getTab(tabId) {
      return cdpEvalFn(cdp, async (id) => {
        return chrome.tabs.get(id);
      }, tabId);
    },

    /** Navigate a tab to a URL */
    async navigateTab(tabId, url) {
      await cdpEvalFn(cdp, async (id, u) => {
        await chrome.tabs.update(id, { url: u });
      }, tabId, url);
      await sleep(1000); // let navigation handler run
    },

    // ── Group helpers ───────────────────────────────────────────────────

    /** Get all tab groups in a window */
    async queryGroups(windowId) {
      const opts = windowId !== undefined ? { windowId } : {};
      return cdpEvalFn(cdp, async (o) => {
        return chrome.tabGroups.query(o);
      }, opts);
    },

    /** Get a single group by ID */
    async getGroup(groupId) {
      return cdpEvalFn(cdp, async (id) => {
        return chrome.tabGroups.get(id);
      }, groupId);
    },

    /** Create a user-named tab group from given tab IDs */
    async createUserGroup(tabIds, title, windowId) {
      const groupId = await cdpEvalFn(cdp, async (ids, t, wid) => {
        const opts = { tabIds: ids };
        if (wid !== undefined) opts.createProperties = { windowId: wid };
        const gid = await chrome.tabs.group(opts);
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
      return cdpEvalFn(cdp, async (gid) => {
        return chrome.tabs.query({ groupId: gid });
      }, groupId);
    },

    // ── Bookmark helpers ────────────────────────────────────────────────

    /** Get all bookmarks under a folder name */
    async getBookmarksInFolder(folderName) {
      return cdpEvalFn(cdp, async (name) => {
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
      const windows = await cdpEvalFn(cdp, async () => {
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

    /** Detach CDP and close the browser */
    async cleanup() {
      try { await cdp.detach(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    },

    /**
     * Close all tabs except a pinned keeper, to reset state between tests.
     * The keeper is pinned so the extension ignores it (pinned tabs are
     * skipped in onCreated) — it can never appear in tabMeta or be closed
     * by the evaluation cycle, which prevents Chrome from exiting.
     */
    async resetTabs() {
      await harness.ensureCdp();
      // Wait for any in-flight eval cycle to finish first
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const running = await cdpEval(cdp, 'self.__evaluationCycleRunning || false');
        if (!running) break;
        await sleep(200);
      }
      // Create a pinned keeper tab first
      const keeperId = await cdpEvalFn(cdp, async () => {
        const t = await chrome.tabs.create({ url: 'about:blank', pinned: true });
        return t.id;
      });
      await sleep(400);
      const tabs = await harness.queryTabs({});
      const toClose = tabs.filter((t) => t.id !== keeperId).map((t) => t.id);
      if (toClose.length > 0) {
        await cdpEvalFn(cdp, async (ids) => {
          await chrome.tabs.remove(ids);
        }, toClose);
      }
      await sleep(500);
      // Clear stale tabMeta and windowState so previous tests don't leak
      await harness.writeStorage({ [SK.TAB_META]: {}, [SK.WINDOW_STATE]: {} });
      await sleep(300);
    },

    /**
     * Re-establish the CDP session if the service worker has restarted.
     */
    async ensureCdp() {
      try {
        await cdp.send('Runtime.evaluate', {
          expression: '1',
          returnByValue: true,
        });
      } catch {
        // Session is dead — find the new SW target and reconnect
        const newSw = await pollForTarget(
          browser,
          (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
          10_000
        );
        harness.swTarget = newSw;
        cdp = await newSw.createCDPSession();
        harness.cdp = cdp;
        await cdp.send('Runtime.enable');
      }
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

/** Poll browser.targets() until a matching target appears. */
async function pollForTarget(browser, predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = browser.targets();
    const match = targets.find(predicate);
    if (match) return match;
    await sleep(300);
  }
  throw new Error(`Target not found within ${timeoutMs}ms`);
}

export { SK };
