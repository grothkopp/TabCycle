/**
 * E2E: Navigation Reset
 *
 * Verifies that navigating a tab resets it to green status and ungroups
 * it from any special group (Yellow/Red).
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Navigation Reset (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 4000,
      redToGone: 120000,
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
      redToGone: 120000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  });

  it('navigating a yellow tab resets it to green', async () => {
    const tabId = await h.openTab('https://example.com');

    // Make it yellow
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    let meta = await h.getTabMeta();
    expect((meta[tabId] || meta[String(tabId)]).status).toBe('yellow');

    // Navigate to a new URL
    await h.navigateTab(tabId, 'https://example.org');

    meta = await h.getTabMeta();
    const entry = meta[tabId] || meta[String(tabId)];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('green');

    await h.closeTab(tabId);
  }, 25_000);

  it('navigating a tab in Yellow special group ungroups it', async () => {
    const tabId = await h.openTab('https://example.com');

    // Make it yellow → moves to Yellow special group
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    let tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1);
    const yellowGroupId = tab.groupId;

    // Navigate → should ungroup
    await h.navigateTab(tabId, 'https://example.org');

    tab = await h.getTab(tabId);
    // Tab should now be ungrouped
    expect(tab.groupId).toBe(-1);

    // And status should be green
    const meta = await h.getTabMeta();
    const entry = meta[tabId] || meta[String(tabId)];
    expect(entry.status).toBe('green');

    await h.closeTab(tabId);
  }, 25_000);

  it('navigating a tab in Red special group ungroups it and resets to green', async () => {
    const tabId = await h.openTab('https://example.com');

    // Make it red
    await h.backdateTab(tabId, 4500);
    await h.triggerEvaluation();

    let tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1);

    let group = await h.getGroup(tab.groupId);
    expect(group.title).toBe('Red');

    // Navigate → should ungroup and reset
    await h.navigateTab(tabId, 'https://example.org');

    tab = await h.getTab(tabId);
    expect(tab.groupId).toBe(-1);

    const meta = await h.getTabMeta();
    const entry = meta[tabId] || meta[String(tabId)];
    expect(entry.status).toBe('green');

    await h.closeTab(tabId);
  }, 25_000);

  it('navigating a tab in a user group does NOT ungroup it', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'UserGroup', windowId);

    // Navigate tab1 within the user group
    await h.navigateTab(tab1, 'https://example.org');

    const tab = await h.getTab(tab1);
    // Should still be in the user group
    expect(tab.groupId).toBe(groupId);

    // Status should be green (refreshed)
    const meta = await h.getTabMeta();
    const entry = meta[tab1] || meta[String(tab1)];
    expect(entry.status).toBe('green');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 25_000);

  it('navigated tab is moved to leftmost position (green zone)', async () => {
    // Create some tabs so there's a meaningful position
    const otherTab = await h.openTab('https://example.com');
    const tabId = await h.openTab('https://example.com');

    // Make tabId yellow → moves to Yellow group (rightward)
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    // Navigate → should reset and move to leftmost
    await h.navigateTab(tabId, 'https://example.org');

    const tab = await h.getTab(tabId);
    // Should be at or near index 0 (after pinned tabs)
    // The exact index depends on pinned tabs, but it should be very low
    expect(tab.index).toBeLessThanOrEqual(1);

    await h.closeTab(tabId);
    await h.closeTab(otherTab);
  }, 25_000);
});
