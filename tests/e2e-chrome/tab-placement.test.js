/**
 * E2E: Tab Placement
 *
 * Verifies that new tabs are placed correctly based on their context tab:
 *   1. Context tab in user group → new tab joins same group
 *   2. Context tab ungrouped → both grouped into a new green group
 *   3. No context / pinned / special group → leftmost position
 */

import { createHarness, sleep } from './harness.js';

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
const describeOrSkip = CHROME_PATH ? describe : describe.skip;

describeOrSkip('Tab Placement (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.setFastThresholds({
      greenToYellow: 120000,
      yellowToRed: 240000,
      redToGone: 360000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  beforeEach(async () => {
    await h.resetTabs();
    await h.setFastThresholds({
      greenToYellow: 120000,
      yellowToRed: 240000,
      redToGone: 360000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  });

  it('tab opened without context goes to leftmost position', async () => {
    // Open a few tabs first to have something to compare against
    await h.openTab('https://example.com');
    await h.openTab('https://example.com');

    // Open a tab without an opener (no context tab)
    const newTabId = await h.openTab('https://example.org');

    const tab = await h.getTab(newTabId);
    // Should be at or near position 0
    expect(tab.index).toBeLessThanOrEqual(1);

    await h.closeTab(newTabId);
  }, 20_000);

  it('new tab opened from a user group tab joins that group', async () => {
    // Create a user group
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'TestGroup', windowId);

    // Open a new tab with tab1 as the opener (simulating a link click)
    const newTabId = await h.swWorker.evaluate(async (openerId) => {
      const tab = await chrome.tabs.create({
        url: 'https://example.org',
        openerTabId: openerId,
      });
      return tab.id;
    }, tab1);
    await sleep(800);

    const newTab = await h.getTab(newTabId);
    expect(newTab.groupId).toBe(groupId);

    await h.closeTab(newTabId);
    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 25_000);

  it('new tab opened from ungrouped tab creates a new group with both', async () => {
    // Create an ungrouped tab
    const contextTabId = await h.openTab('https://example.com');
    await sleep(300);

    // Verify it's ungrouped
    let contextTab = await h.getTab(contextTabId);
    expect(contextTab.groupId).toBe(-1);

    // Open a new tab with contextTab as the opener
    const newTabId = await h.swWorker.evaluate(async (openerId) => {
      const tab = await chrome.tabs.create({
        url: 'https://example.org',
        openerTabId: openerId,
      });
      return tab.id;
    }, contextTabId);
    await sleep(800);

    // Both tabs should now be in the same group
    contextTab = await h.getTab(contextTabId);
    const newTab = await h.getTab(newTabId);

    expect(contextTab.groupId).not.toBe(-1);
    expect(newTab.groupId).not.toBe(-1);
    expect(contextTab.groupId).toBe(newTab.groupId);

    // The group should be green
    const group = await h.getGroup(contextTab.groupId);
    expect(group.color).toBe('green');

    await h.closeTab(newTabId);
    await h.closeTab(contextTabId);
  }, 25_000);

  it('pinned tabs are not tracked by the extension', async () => {
    // Create and pin a tab
    const tabId = await h.openTab('https://example.com');
    await h.swWorker.evaluate(async (id) => {
      await chrome.tabs.update(id, { pinned: true });
    }, tabId);
    await sleep(500);

    // Pinned tab should not be in tabMeta
    const meta = await h.getTabMeta();
    expect(meta[tabId]).toBeUndefined();
    expect(meta[String(tabId)]).toBeUndefined();

    // Unpin and cleanup
    await h.swWorker.evaluate(async (id) => {
      await chrome.tabs.update(id, { pinned: false });
    }, tabId);
    await sleep(500);
    await h.closeTab(tabId);
  }, 20_000);
});
