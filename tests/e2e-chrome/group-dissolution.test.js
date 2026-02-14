/**
 * E2E: Group Dissolution
 *
 * Verifies that unnamed single-tab groups created by the extension are
 * dissolved (the lone tab is ungrouped), while user-named groups and
 * multi-tab groups are preserved.
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Group Dissolution (real Chrome)', () => {
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

  it('user-named group with one tab is NOT dissolved', async () => {
    const tabId = await h.openTab('https://example.com');
    const windowId = (await h.getTab(tabId)).windowId;
    const groupId = await h.createUserGroup([tabId], 'KeepMe', windowId);

    await h.triggerEvaluation();

    // Group should still exist
    const tab = await h.getTab(tabId);
    expect(tab.groupId).toBe(groupId);

    const group = await h.getGroup(groupId);
    expect(group.title).toBe('KeepMe');

    await h.closeTab(tabId);
  }, 20_000);

  it('user-named group with multiple tabs is preserved', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'MultiTab', windowId);

    await h.triggerEvaluation();

    const t1 = await h.getTab(tab1);
    const t2 = await h.getTab(tab2);
    expect(t1.groupId).toBe(groupId);
    expect(t2.groupId).toBe(groupId);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 20_000);

  it('extension-created group dissolves when reduced to one tab', async () => {
    // Simulate the extension creating a group by opening two tabs from the
    // same context (Case 2 in tab-placer: ungrouped context → group both)
    const contextTabId = await h.openTab('https://example.com');
    await sleep(300);

    // Open a new tab with contextTab as opener → should auto-group both
    const newTabId = await h.evalFn(async (openerId) => {
      const tab = await chrome.tabs.create({
        url: 'https://example.org',
        openerTabId: openerId,
      });
      return tab.id;
    }, contextTabId);
    await sleep(1000);

    // Verify they're grouped
    const contextTab = await h.getTab(contextTabId);
    const newTab = await h.getTab(newTabId);
    expect(contextTab.groupId).not.toBe(-1);
    expect(contextTab.groupId).toBe(newTab.groupId);
    const groupId = contextTab.groupId;

    // Close one tab → group now has 1 tab → should dissolve
    await h.closeTab(newTabId);
    await sleep(500);
    await h.triggerEvaluation();

    // The remaining tab should be ungrouped
    const remainingTab = await h.getTab(contextTabId);
    expect(remainingTab.groupId).toBe(-1);

    await h.closeTab(contextTabId);
  }, 30_000);
});
