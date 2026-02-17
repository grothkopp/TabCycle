/**
 * E2E: Group Sorting / Zone Order
 *
 * Verifies that tab groups are sorted into zones: green → yellow → red
 * (left to right), with special groups at zone boundaries, and that
 * user groups are colored to match their freshest tab's status.
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Group Sorting & Zone Order (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 4000,
      redToGone: 120000, // keep gone far away
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

  it('user group color reflects freshest tab status (green)', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'MyGroup', windowId);

    await h.triggerEvaluation();

    const group = await h.getGroup(groupId);
    expect(group.color).toBe('green');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 20_000);

  it('user group color turns yellow when all tabs are yellow', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'MyGroup', windowId);

    // Backdate both tabs past greenToYellow (2s) but under yellowToRed (4s)
    await h.backdateTab(tab1, 3000);
    await h.backdateTab(tab2, 3000);
    await h.triggerEvaluation();

    const group = await h.getGroup(groupId);
    expect(group.color).toBe('yellow');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 20_000);

  it('user group color stays green if one tab is green and another is yellow', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'MixedGroup', windowId);

    // tab1: reset to fresh (opening 2 tabs takes ~2s which ages past 2s threshold)
    await h.backdateTab(tab1, 0);
    // tab2: backdate past greenToYellow
    await h.backdateTab(tab2, 2500);
    await h.triggerEvaluation();

    const group = await h.getGroup(groupId);
    // Group color = freshest tab = green
    expect(group.color).toBe('green');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 20_000);

  it('groups are sorted in zone order: green before yellow before red', async () => {
    // Use wide thresholds so opening 6 tabs (~6s) doesn't cause aging issues
    await h.setFastThresholds({
      greenToYellow: 15000,
      yellowToRed: 30000,
      redToGone: 120000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });

    // Create three user groups, each with a different status
    const greenTabs = await h.openTabs(2, 'https://example.com');
    const yellowTabs = await h.openTabs(2, 'https://example.com');
    const redTabs = await h.openTabs(2, 'https://example.com');

    const windowId = (await h.getTab(greenTabs[0])).windowId;

    const greenGroup = await h.createUserGroup(greenTabs, 'GreenGroup', windowId);
    const yellowGroup = await h.createUserGroup(yellowTabs, 'YellowGroup', windowId);
    const redGroup = await h.createUserGroup(redTabs, 'RedGroup', windowId);

    // Backdate tabs with wide margins:
    // green: fresh (0ms) — well under 15s threshold
    // yellow: 16s — past greenToYellow(15s) but under yellowToRed(30s)
    // red: 31s — past yellowToRed(30s) but under redToGone(120s)
    for (const id of greenTabs) await h.backdateTab(id, 0);
    for (const id of yellowTabs) await h.backdateTab(id, 16000);
    for (const id of redTabs) await h.backdateTab(id, 31000);

    await h.triggerEvaluation();

    // Read the groups in their current visual order (by index)
    const groups = await h.queryGroups(windowId);
    // Titles may have age suffixes (e.g. "GreenGroup · 2s"), so use startsWith
    const userGroups = groups.filter(
      (g) => g.title?.startsWith('GreenGroup') || g.title?.startsWith('YellowGroup') || g.title?.startsWith('RedGroup')
    );

    // Get the first tab of each group to determine position
    const groupPositions = {};
    for (const g of userGroups) {
      const tabs = await h.getTabsInGroup(g.id);
      if (tabs.length > 0) {
        const key = g.title?.startsWith('GreenGroup') ? 'GreenGroup'
          : g.title?.startsWith('YellowGroup') ? 'YellowGroup'
          : 'RedGroup';
        groupPositions[key] = Math.min(...tabs.map((t) => t.index));
      }
    }

    // Green should be leftmost, then yellow, then red
    expect(groupPositions['GreenGroup']).toBeLessThan(groupPositions['YellowGroup']);
    expect(groupPositions['YellowGroup']).toBeLessThan(groupPositions['RedGroup']);

    // Cleanup
    for (const id of [...greenTabs, ...yellowTabs, ...redTabs]) {
      try { await h.closeTab(id); } catch { /* may already be closed */ }
    }
  }, 40_000);

  it('special Yellow group appears at the yellow zone boundary', async () => {
    // Create an ungrouped tab that will become yellow
    const tabId = await h.openTab('https://example.com');
    // Also create a green user group for reference
    const greenTabs = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tabId)).windowId;
    const greenGroup = await h.createUserGroup(greenTabs, 'StaysGreen', windowId);

    // Backdate the ungrouped tab to yellow
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    const groups = await h.queryGroups(windowId);
    const yellowSpecial = groups.find((g) => g.title === '' && g.color === 'yellow');
    const greenUserGroup = groups.find((g) => g.title === 'StaysGreen');

    expect(yellowSpecial).toBeDefined();
    expect(greenUserGroup).toBeDefined();

    // Yellow special group should be to the right of the green user group
    if (yellowSpecial && greenUserGroup) {
      const yellowTabs = await h.getTabsInGroup(yellowSpecial.id);
      const greenGroupTabs = await h.getTabsInGroup(greenUserGroup.id);
      const yellowPos = Math.min(...yellowTabs.map((t) => t.index));
      const greenPos = Math.min(...greenGroupTabs.map((t) => t.index));
      expect(yellowPos).toBeGreaterThan(greenPos);
    }

    await h.closeTab(tabId);
    for (const id of greenTabs) {
      try { await h.closeTab(id); } catch { /* */ }
    }
  }, 30_000);

  it('special Red group appears after Yellow group', async () => {
    const yellowTab = await h.openTab('https://example.com');
    const redTab = await h.openTab('https://example.com');

    await h.backdateTab(yellowTab, 2500);
    await h.backdateTab(redTab, 4500);
    await h.triggerEvaluation();

    const windowId = (await h.queryTabs({}))[0].windowId;
    const groups = await h.queryGroups(windowId);
    const yellowSpecial = groups.find((g) => g.title === '' && g.color === 'yellow');
    const redSpecial = groups.find((g) => g.title === '' && g.color === 'red');

    expect(yellowSpecial).toBeDefined();
    expect(redSpecial).toBeDefined();

    if (yellowSpecial && redSpecial) {
      const yellowTabs = await h.getTabsInGroup(yellowSpecial.id);
      const redTabs = await h.getTabsInGroup(redSpecial.id);
      const yellowPos = Math.min(...yellowTabs.map((t) => t.index));
      const redPos = Math.min(...redTabs.map((t) => t.index));
      expect(redPos).toBeGreaterThan(yellowPos);
    }

    await h.closeTab(yellowTab);
    await h.closeTab(redTab);
  }, 25_000);
});
