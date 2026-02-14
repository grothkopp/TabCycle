/**
 * E2E: Tab Grouping
 *
 * Verifies that ungrouped tabs are moved into the correct special groups
 * (Yellow, Red) when their status changes, and that they are ungrouped
 * when they return to green.
 */

import { createHarness, sleep } from './harness.js';

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
const describeOrSkip = CHROME_PATH ? describe : describe.skip;

describeOrSkip('Tab Grouping (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 4000,
      redToGone: 60000, // keep gone far away so tabs aren't closed
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
      greenToYellow: 2000,
      yellowToRed: 4000,
      redToGone: 60000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  });

  it('yellow tab is placed into a Yellow special group', async () => {
    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    // Check the tab is now in a group
    const tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1); // -1 = TAB_GROUP_ID_NONE

    // The group should be the Yellow special group
    const group = await h.getGroup(tab.groupId);
    expect(group.title).toBe('Yellow');
    expect(group.color).toBe('yellow');

    // windowState should track this as a special group
    const ws = await h.getWindowState();
    const windowEntry = ws[tab.windowId] || ws[String(tab.windowId)];
    expect(windowEntry).toBeDefined();
    expect(windowEntry.specialGroups.yellow).toBe(tab.groupId);

    await h.closeTab(tabId);
  }, 20_000);

  it('red tab is placed into a Red special group', async () => {
    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 4500);
    await h.triggerEvaluation();

    const tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1);

    const group = await h.getGroup(tab.groupId);
    expect(group.title).toBe('Red');
    expect(group.color).toBe('red');

    const ws = await h.getWindowState();
    const windowEntry = ws[tab.windowId] || ws[String(tab.windowId)];
    expect(windowEntry).toBeDefined();
    expect(windowEntry.specialGroups.red).toBe(tab.groupId);

    await h.closeTab(tabId);
  }, 20_000);

  it('tab transitions from Yellow group to Red group', async () => {
    const tabId = await h.openTab('https://example.com');

    // First make it yellow
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    let tab = await h.getTab(tabId);
    let group = await h.getGroup(tab.groupId);
    expect(group.title).toBe('Yellow');

    // Now make it red
    await h.backdateTab(tabId, 4500);
    await h.triggerEvaluation();

    tab = await h.getTab(tabId);
    group = await h.getGroup(tab.groupId);
    expect(group.title).toBe('Red');
    expect(group.color).toBe('red');

    await h.closeTab(tabId);
  }, 25_000);

  it('multiple yellow tabs share the same Yellow special group', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');

    await h.backdateTab(tab1, 2500);
    await h.backdateTab(tab2, 3000);
    await h.triggerEvaluation();

    const t1 = await h.getTab(tab1);
    const t2 = await h.getTab(tab2);

    // Both should be in the same Yellow group
    expect(t1.groupId).not.toBe(-1);
    expect(t2.groupId).not.toBe(-1);
    expect(t1.groupId).toBe(t2.groupId);

    const group = await h.getGroup(t1.groupId);
    expect(group.title).toBe('Yellow');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 20_000);

  it('green tab remains ungrouped', async () => {
    const tabId = await h.openTab('https://example.com');
    await h.triggerEvaluation();

    const tab = await h.getTab(tabId);
    // Green tabs should be ungrouped (groupId === -1)
    expect(tab.groupId).toBe(-1);

    await h.closeTab(tabId);
  }, 15_000);

  it('empty special group is cleaned up when last tab leaves', async () => {
    const tabId = await h.openTab('https://example.com');

    // Make it yellow → creates Yellow group
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    const tab = await h.getTab(tabId);
    const yellowGroupId = tab.groupId;
    expect(yellowGroupId).not.toBe(-1);

    // Now make it red → should move to Red group, Yellow group should be cleaned up
    await h.backdateTab(tabId, 4500);
    await h.triggerEvaluation();

    const tabAfter = await h.getTab(tabId);
    expect(tabAfter.groupId).not.toBe(yellowGroupId);

    // The old Yellow group should no longer exist (or have no tabs)
    const groups = await h.queryGroups(tabAfter.windowId);
    const yellowStillExists = groups.some((g) => g.id === yellowGroupId);
    // If it still exists, it should have no tabs
    if (yellowStillExists) {
      const tabsInYellow = await h.getTabsInGroup(yellowGroupId);
      expect(tabsInYellow.length).toBe(0);
    }

    await h.closeTab(tabId);
  }, 25_000);
});
