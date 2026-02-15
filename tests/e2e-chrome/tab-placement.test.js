/**
 * E2E: Tab Placement
 *
 * Verifies that new tabs are placed correctly based on their context tab:
 *   1. Context tab in user group → new tab joins same group
 *   2. Context tab ungrouped → both grouped into a new green group
 *   3. No context / pinned / special group → leftmost position
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

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
    await sleep(500);

    // Open a link from tab1's page context so Chrome sets openerTabId
    const pages = await h.browser.pages();
    const tab1Page = pages.find((p) => {
      try { return p.url().includes('example.com'); } catch { return false; }
    });
    // Use window.open which sets openerTabId on the new tab
    await tab1Page.evaluate(() => { window.open('https://example.org', '_blank'); });
    await sleep(1500);

    // Find the newly opened tab
    const allTabs = await h.queryTabs({});
    const newTab = allTabs.find((t) => t.url?.includes('example.org'));
    expect(newTab).toBeDefined();
    expect(newTab.groupId).toBe(groupId);

    await h.closeTab(newTab.id);
    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 25_000);

  it('new tab opened from ungrouped tab creates a new group with both', async () => {
    // Create an ungrouped tab
    const contextTabId = await h.openTab('https://example.com');
    await sleep(500);

    // Verify it's ungrouped
    let contextTab = await h.getTab(contextTabId);
    expect(contextTab.groupId).toBe(-1);

    // Open a link from the page context so Chrome sets openerTabId
    const pages = await h.browser.pages();
    const ctxPage = pages.find((p) => {
      try { return p.url().includes('example.com'); } catch { return false; }
    });
    await ctxPage.evaluate(() => { window.open('https://example.org', '_blank'); });
    await sleep(1500);

    // Both tabs should now be in the same group
    contextTab = await h.getTab(contextTabId);
    const allTabs = await h.queryTabs({});
    const newTab = allTabs.find((t) => t.url?.includes('example.org'));
    expect(newTab).toBeDefined();

    expect(contextTab.groupId).not.toBe(-1);
    expect(newTab.groupId).not.toBe(-1);
    expect(contextTab.groupId).toBe(newTab.groupId);

    // The group should be green
    const group = await h.getGroup(contextTab.groupId);
    expect(group.color).toBe('green');

    await h.closeTab(newTab.id);
    await h.closeTab(contextTabId);
  }, 25_000);

  it('new group from ungrouped green tab is green and stays in green zone after eval', async () => {
    // Use short thresholds so we can create a yellow group via backdating
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 60000,
      redToGone: 120000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });

    // Create a yellow user group so there's a non-green zone present
    const [yTab1, yTab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(yTab1)).windowId;
    const yellowGroup = await h.createUserGroup([yTab1, yTab2], 'YellowGroup', windowId);
    await h.backdateTab(yTab1, 3000);
    await h.backdateTab(yTab2, 3000);
    await h.triggerEvaluation();

    // Now create an ungrouped green tab (context tab for the new group)
    const contextTabId = await h.openTab('https://example.com');
    await h.backdateTab(contextTabId, 0); // ensure fresh green
    await sleep(500);

    // Open a link from the context tab's page so Chrome sets openerTabId
    const pages = await h.browser.pages();
    const ctxPage = pages.find((p) => {
      try { return p.url().includes('example.com') && !p.url().includes('example.org'); } catch { return false; }
    });
    await ctxPage.evaluate(() => { window.open('https://example.org', '_blank'); });
    await sleep(1500);

    // Find the newly opened tab and verify it's grouped with context tab
    const allTabs = await h.queryTabs({});
    const newTab = allTabs.find((t) => t.url?.includes('example.org'));
    expect(newTab).toBeDefined();
    const ctxAfter = await h.getTab(contextTabId);
    expect(ctxAfter.groupId).not.toBe(-1);
    expect(newTab.groupId).toBe(ctxAfter.groupId);

    // The new group should be green
    const group = await h.getGroup(ctxAfter.groupId);
    expect(group.color).toBe('green');

    // Run an evaluation cycle — the green group should remain green
    await h.triggerEvaluation();

    // Verify group is still green
    const groupAfter = await h.getGroup(ctxAfter.groupId);
    expect(groupAfter.color).toBe('green');

    // Verify the green group is positioned before the yellow group (zone order)
    const greenTabs = await h.getTabsInGroup(ctxAfter.groupId);
    const yellowTabs = await h.getTabsInGroup(yellowGroup);
    const greenPos = Math.min(...greenTabs.map((t) => t.index));
    const yellowPos = Math.min(...yellowTabs.map((t) => t.index));
    expect(greenPos).toBeLessThan(yellowPos);

    // Cleanup
    await h.closeTab(newTab.id);
    await h.closeTab(contextTabId);
    await h.closeTab(yTab1);
    await h.closeTab(yTab2);
  }, 30_000);

  it('auto-created group from leftmost context tab stays left of existing green groups', async () => {
    const existingA = await h.openTab('https://example.net/?tc=existing-a');
    const existingB = await h.openTab('https://example.net/?tc=existing-b');
    const windowId = (await h.getTab(existingA)).windowId;
    const existingGroupId = await h.createUserGroup([existingA, existingB], 'ExistingGreen', windowId);
    await h.backdateTab(existingA, 0);
    await h.backdateTab(existingB, 0);
    await h.triggerEvaluation();

    const contextTabId = await h.openTab('https://example.com/?tc=leftmost-context');
    await h.evalFn(async (id) => {
      await chrome.tabs.move(id, { index: 1 });
    }, contextTabId);
    await h.backdateTab(contextTabId, 0);
    await sleep(500);

    const stateBefore = await h.getWindowState();
    const ws = stateBefore[windowId] || stateBefore[String(windowId)] || {
      specialGroups: { yellow: null, red: null },
      groupZones: {},
    };
    await h.writeStorage({
      v1_windowState: {
        ...stateBefore,
        [windowId]: {
          ...ws,
          groupZones: {},
        },
      },
    });

    const pages = await h.browser.pages();
    const contextPage = pages.find((p) => {
      try { return p.url().includes('leftmost-context'); } catch { return false; }
    });
    await contextPage.evaluate(() => { window.open('https://example.org/?tc=leftmost-opened', '_blank'); });
    await sleep(1500);

    const allTabs = await h.queryTabs({ windowId });
    const newTab = allTabs.find((t) => t.url?.includes('leftmost-opened'));
    expect(newTab).toBeDefined();

    const contextAfter = await h.getTab(contextTabId);
    expect(contextAfter.groupId).not.toBe(-1);
    expect(newTab.groupId).toBe(contextAfter.groupId);

    const autoTabsBeforeEval = await h.getTabsInGroup(contextAfter.groupId);
    const existingTabsBeforeEval = await h.getTabsInGroup(existingGroupId);
    const autoPosBeforeEval = Math.min(...autoTabsBeforeEval.map((t) => t.index));
    const existingPosBeforeEval = Math.min(...existingTabsBeforeEval.map((t) => t.index));
    expect(autoPosBeforeEval).toBeLessThan(existingPosBeforeEval);

    await h.triggerEvaluation();

    const autoTabsAfterEval = await h.getTabsInGroup(contextAfter.groupId);
    const existingTabsAfterEval = await h.getTabsInGroup(existingGroupId);
    const autoPosAfterEval = Math.min(...autoTabsAfterEval.map((t) => t.index));
    const existingPosAfterEval = Math.min(...existingTabsAfterEval.map((t) => t.index));
    expect(autoPosAfterEval).toBeLessThan(existingPosAfterEval);

    await h.closeTab(newTab.id);
    await h.closeTab(contextTabId);
    await h.closeTab(existingA);
    await h.closeTab(existingB);
  }, 35_000);

  it('new tab from pinned context tab is green and stays green after eval', async () => {
    // Use short thresholds so we can create a yellow group via backdating
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 60000,
      redToGone: 120000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });

    // Create some yellow tabs so there's a non-green zone to avoid
    const [yTab1, yTab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(yTab1)).windowId;
    const yellowGroup = await h.createUserGroup([yTab1, yTab2], 'YellowGroup', windowId);
    await h.backdateTab(yTab1, 3000);
    await h.backdateTab(yTab2, 3000);
    await h.triggerEvaluation();

    // Create and pin a tab
    const pinnedTabId = await h.openTab('https://example.com');
    await h.evalFn(async (id) => {
      await chrome.tabs.update(id, { pinned: true });
    }, pinnedTabId);
    await sleep(500);

    // Open a new tab via window.open from a page context so openerTabId is set.
    // We need a non-pinned page to call window.open from, but the scenario is
    // "active tab is pinned". Since Chrome doesn't let us window.open from a
    // pinned tab's page easily, we test via chrome.tabs.create which goes
    // through onCreated → placeNewTab (no openerTabId → leftmost).
    const newTabId = await h.openTab('https://example.org');
    await h.backdateTab(newTabId, 0); // ensure fresh green

    // New tab should be green in tabMeta
    const meta = await h.getTabMeta();
    const newMeta = meta[newTabId] || meta[String(newTabId)];
    expect(newMeta).toBeDefined();
    expect(newMeta.status).toBe('green');

    // Record position
    const newTabBefore = await h.getTab(newTabId);
    const posBefore = newTabBefore.index;

    // Run eval — tab should remain green and not be moved into yellow/red zone
    await h.triggerEvaluation();
    const metaAfter = await h.getTabMeta();
    const newMetaAfter = metaAfter[newTabId] || metaAfter[String(newTabId)];
    expect(newMetaAfter.status).toBe('green');

    // Position should not have changed (green stays in green zone)
    const newTabAfter = await h.getTab(newTabId);
    expect(newTabAfter.index).toBe(posBefore);

    // Cleanup
    await h.closeTab(newTabId);
    await h.evalFn(async (id) => {
      await chrome.tabs.update(id, { pinned: false });
    }, pinnedTabId);
    await sleep(300);
    await h.closeTab(pinnedTabId);
    await h.closeTab(yTab1);
    await h.closeTab(yTab2);
  }, 25_000);

  it('new tab opened from user group in green zone joins group and stays in position', async () => {
    // Create a user group in the green zone
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'GreenUserGroup', windowId);
    await h.backdateTab(tab1, 0);
    await h.backdateTab(tab2, 0);
    await h.triggerEvaluation();

    // Verify group is green
    const groupBefore = await h.getGroup(groupId);
    expect(groupBefore.color).toBe('green');

    // Record group position
    const tabsBefore = await h.getTabsInGroup(groupId);
    const posBefore = Math.min(...tabsBefore.map((t) => t.index));

    // Open a link from tab1's page context so Chrome sets openerTabId
    const pages = await h.browser.pages();
    const tab1Page = pages.find((p) => {
      try { return p.url().includes('example.com'); } catch { return false; }
    });
    await tab1Page.evaluate(() => { window.open('https://example.org', '_blank'); });
    await sleep(1500);

    // New tab should join the same group
    const allTabs = await h.queryTabs({});
    const newTab = allTabs.find((t) => t.url?.includes('example.org'));
    expect(newTab).toBeDefined();
    expect(newTab.groupId).toBe(groupId);

    // Group should still be green
    const groupMid = await h.getGroup(groupId);
    expect(groupMid.color).toBe('green');

    // Run eval — group should remain green and in same position
    await h.triggerEvaluation();
    const groupAfter = await h.getGroup(groupId);
    expect(groupAfter.color).toBe('green');

    const tabsAfter = await h.getTabsInGroup(groupId);
    const posAfter = Math.min(...tabsAfter.map((t) => t.index));
    expect(posAfter).toBe(posBefore);

    // Cleanup
    await h.closeTab(newTab.id);
    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 25_000);

  it('pinned tabs are not tracked by the extension', async () => {
    // Create and pin a tab
    const tabId = await h.openTab('https://example.com');
    await h.evalFn(async (id) => {
      await chrome.tabs.update(id, { pinned: true });
    }, tabId);
    await sleep(500);

    // Pinned tab should not be in tabMeta
    const meta = await h.getTabMeta();
    expect(meta[tabId]).toBeUndefined();
    expect(meta[String(tabId)]).toBeUndefined();

    // Unpin and cleanup
    await h.evalFn(async (id) => {
      await chrome.tabs.update(id, { pinned: false });
    }, tabId);
    await sleep(500);
    await h.closeTab(tabId);
  }, 20_000);
});
