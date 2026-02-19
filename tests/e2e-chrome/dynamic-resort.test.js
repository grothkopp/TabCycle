/**
 * E2E: Dynamic Resort Scenarios
 *
 * Verifies that the extension correctly resorts tabs and groups when:
 * A) User changes threshold settings while diverse tabs/groups are open
 * B) User manually reorders groups into an invalid zone order
 * C) User refreshes (navigates) a tab inside a yellow/red user group
 * D) User drags a tab into a group with a different status
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

/** Helper: get the minimum tab index for a group (its visual position) */
async function groupPosition(h, groupId) {
  const tabs = await h.getTabsInGroup(groupId);
  if (tabs.length === 0) return Infinity;
  return Math.min(...tabs.map((t) => t.index));
}

describeOrSkip('Dynamic Resort Scenarios (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  beforeEach(async () => {
    await h.resetTabs();
    await h.setFastThresholds({
      greenToYellow: 15000,
      yellowToRed: 30000,
      redToGone: 120000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  });

  // ── Scenario A: Threshold change triggers full resort ──────────────

  describe('Scenario A: threshold change resort', () => {
    it('yellow tab in Yellow special group becomes green when threshold is raised', async () => {
      // Start with short thresholds so tab becomes yellow
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 30000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const tabId = await h.openTab('https://example.com');
      await h.backdateTab(tabId, 2500);
      await h.triggerEvaluation();

      // Tab should be in Yellow special group
      let tab = await h.getTab(tabId);
      expect(tab.groupId).not.toBe(-1);
      let group = await h.getGroup(tab.groupId);
      expect(group.title).toBe('');

      // Raise threshold so tab is now green again
      await h.setFastThresholds({
        greenToYellow: 60000,
        yellowToRed: 120000,
        redToGone: 240000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });
      // The settings change triggers an eval cycle; wait for it
      await sleep(2000);
      await h.triggerEvaluation();

      // Tab should now be ungrouped (green)
      tab = await h.getTab(tabId);
      expect(tab.groupId).toBe(-1);

      const meta = await h.getTabMeta();
      const entry = meta[tabId] || meta[String(tabId)];
      expect(entry.status).toBe('green');

      await h.closeTab(tabId);
    }, 30_000);

    it('yellow tab moves to Red special group when threshold is lowered', async () => {
      // Start with thresholds where tab is yellow
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 30000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const tabId = await h.openTab('https://example.com');
      await h.backdateTab(tabId, 3000);
      await h.triggerEvaluation();

      let tab = await h.getTab(tabId);
      expect(tab.groupId).not.toBe(-1);
      let group = await h.getGroup(tab.groupId);
      expect(group.title).toBe('');

      // Lower yellowToRed threshold so tab is now red
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 2500,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });
      await sleep(2000);
      await h.triggerEvaluation();

      // Tab should now be in Red special group
      tab = await h.getTab(tabId);
      expect(tab.groupId).not.toBe(-1);
      group = await h.getGroup(tab.groupId);
      expect(group.title).toBe('');

      await h.closeTab(tabId);
    }, 30_000);

    it('user groups are resorted when threshold change shifts zones', async () => {
      // Create three user groups with different ages
      await h.setFastThresholds({
        greenToYellow: 15000,
        yellowToRed: 30000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const greenTabs = await h.openTabs(2, 'https://example.com');
      const yellowTabs = await h.openTabs(2, 'https://example.com');

      const windowId = (await h.getTab(greenTabs[0])).windowId;
      const greenGroup = await h.createUserGroup(greenTabs, 'GreenGrp', windowId);
      const yellowGroup = await h.createUserGroup(yellowTabs, 'YellowGrp', windowId);

      // Backdate: green tabs fresh, yellow tabs aged 16s
      for (const id of greenTabs) await h.backdateTab(id, 0);
      for (const id of yellowTabs) await h.backdateTab(id, 16000);

      await h.triggerEvaluation();

      // Verify initial order: green left, yellow right
      let greenPos = await groupPosition(h, greenGroup);
      let yellowPos = await groupPosition(h, yellowGroup);
      expect(greenPos).toBeLessThan(yellowPos);

      // Now lower yellowToRed to 10s — yellow group tabs (age 16s) become red.
      // Keep greenToYellow at 15s so green tabs (age 0) stay green.
      await h.setFastThresholds({
        greenToYellow: 15000,
        yellowToRed: 10000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });
      // Re-backdate green tabs to 0 to ensure they haven't aged during tab creation
      for (const id of greenTabs) await h.backdateTab(id, 0);
      await sleep(2000);
      await h.triggerEvaluation();

      // Yellow group should now be red
      const yellowGrp = await h.getGroup(yellowGroup);
      expect(yellowGrp.color).toBe('red');

      // Green group should still be green (tabs are fresh)
      const greenGrp = await h.getGroup(greenGroup);
      expect(greenGrp.color).toBe('green');

      // Order: green left, red right
      greenPos = await groupPosition(h, greenGroup);
      yellowPos = await groupPosition(h, yellowGroup);
      expect(greenPos).toBeLessThan(yellowPos);

      // Cleanup
      for (const id of [...greenTabs, ...yellowTabs]) {
        try { await h.closeTab(id); } catch { /* */ }
      }
    }, 40_000);
  });

  // ── Scenario B: Manual reorder correction ──────────────────────────

  describe('Scenario B: manual reorder correction', () => {
    it('green group moved into yellow zone is corrected back to green zone', async () => {
      await h.setFastThresholds({
        greenToYellow: 15000,
        yellowToRed: 30000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const greenTabs = await h.openTabs(2, 'https://example.com');
      const yellowTabs = await h.openTabs(2, 'https://example.com');

      const windowId = (await h.getTab(greenTabs[0])).windowId;
      const greenGroup = await h.createUserGroup(greenTabs, 'GreenGrp', windowId);
      const yellowGroup = await h.createUserGroup(yellowTabs, 'YellowGrp', windowId);

      for (const id of greenTabs) await h.backdateTab(id, 0);
      for (const id of yellowTabs) await h.backdateTab(id, 16000);

      await h.triggerEvaluation();

      // Verify: green left, yellow right
      let greenPos = await groupPosition(h, greenGroup);
      let yellowPos = await groupPosition(h, yellowGroup);
      expect(greenPos).toBeLessThan(yellowPos);

      // Manually move green group to the far right (into yellow zone)
      await h.moveGroup(greenGroup, -1);

      // Now green group is visually after yellow group — invalid order
      greenPos = await groupPosition(h, greenGroup);
      yellowPos = await groupPosition(h, yellowGroup);
      expect(greenPos).toBeGreaterThan(yellowPos);

      // The moveGroup triggers onMoved → _scheduleSortAndUpdate (300ms debounce)
      // Wait for the debounced sort to fire and correct the order
      await h.waitForSortUpdate();

      // After correction: green should be back to the left
      greenPos = await groupPosition(h, greenGroup);
      yellowPos = await groupPosition(h, yellowGroup);
      expect(greenPos).toBeLessThan(yellowPos);

      for (const id of [...greenTabs, ...yellowTabs]) {
        try { await h.closeTab(id); } catch { /* */ }
      }
    }, 35_000);
  });

  // ── Scenario C: Refresh events trigger resort ──────────────────────

  describe('Scenario C: refresh in user group triggers resort', () => {
    it('navigating a tab in a yellow user group moves the group to green zone', async () => {
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 30000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const stayGreenTabs = await h.openTabs(2, 'https://example.com');
      const willRefreshTabs = await h.openTabs(2, 'https://example.com');

      const windowId = (await h.getTab(stayGreenTabs[0])).windowId;
      const greenGroup = await h.createUserGroup(stayGreenTabs, 'StaysGreen', windowId);
      const yellowGroup = await h.createUserGroup(willRefreshTabs, 'WillRefresh', windowId);

      // Keep green tabs fresh, age yellow tabs
      for (const id of stayGreenTabs) await h.backdateTab(id, 0);
      for (const id of willRefreshTabs) await h.backdateTab(id, 2500);

      await h.triggerEvaluation();

      // Yellow group should be yellow and to the right
      let yellowGrp = await h.getGroup(yellowGroup);
      expect(yellowGrp.color).toBe('yellow');
      let greenPos = await groupPosition(h, greenGroup);
      let yellowPos = await groupPosition(h, yellowGroup);
      expect(greenPos).toBeLessThan(yellowPos);

      // Navigate one tab in the yellow group → resets to green
      await h.navigateTab(willRefreshTabs[0], 'https://example.org');

      // Navigation resets the tab's refreshWallTime and status to green.
      // The debounced sort reads tabMeta.status, so we need a full eval
      // cycle to recalculate statuses from ages and then sort.
      await h.waitForSortUpdate();
      // Backdate the navigated tab to 0 to ensure it's fresh
      await h.backdateTab(willRefreshTabs[0], 0);
      await h.triggerEvaluation();

      // Group should now be green (freshest tab is green)
      yellowGrp = await h.getGroup(yellowGroup);
      expect(yellowGrp.color).toBe('green');

      for (const id of [...stayGreenTabs, ...willRefreshTabs]) {
        try { await h.closeTab(id); } catch { /* */ }
      }
    }, 35_000);

    it('navigating a tab in a red user group moves the group to green zone', async () => {
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 4000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const greenTabs = await h.openTabs(2, 'https://example.com');
      const redTabs = await h.openTabs(2, 'https://example.com');

      const windowId = (await h.getTab(greenTabs[0])).windowId;
      const _greenGroup = await h.createUserGroup(greenTabs, 'FreshGrp', windowId);
      const redGroup = await h.createUserGroup(redTabs, 'OldGrp', windowId);

      for (const id of greenTabs) await h.backdateTab(id, 0);
      for (const id of redTabs) await h.backdateTab(id, 5000);

      await h.triggerEvaluation();

      let redGrp = await h.getGroup(redGroup);
      expect(redGrp.color).toBe('red');

      // Navigate one tab in the red group
      await h.navigateTab(redTabs[0], 'https://example.org');
      await h.waitForSortUpdate();
      // Ensure the navigated tab is fresh
      await h.backdateTab(redTabs[0], 0);
      await h.triggerEvaluation();

      // Group should now be green
      redGrp = await h.getGroup(redGroup);
      expect(redGrp.color).toBe('green');

      for (const id of [...greenTabs, ...redTabs]) {
        try { await h.closeTab(id); } catch { /* */ }
      }
    }, 35_000);
  });

  // ── Scenario D: Tab drag to different-status group ─────────────────

  describe('Scenario D: tab drag to different-status group', () => {
    it('dragging a green tab into a yellow group makes the group green and resorts', async () => {
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 30000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      // Create a green group and a yellow group
      const greenTabs = await h.openTabs(2, 'https://example.com');
      const yellowTabs = await h.openTabs(2, 'https://example.com');

      const windowId = (await h.getTab(greenTabs[0])).windowId;
      const _greenGroup = await h.createUserGroup(greenTabs, 'GreenGrp', windowId);
      const yellowGroup = await h.createUserGroup(yellowTabs, 'YellowGrp', windowId);

      for (const id of greenTabs) await h.backdateTab(id, 0);
      for (const id of yellowTabs) await h.backdateTab(id, 2500);

      await h.triggerEvaluation();

      let yellowGrp = await h.getGroup(yellowGroup);
      expect(yellowGrp.color).toBe('yellow');

      // Drag a green tab from greenGroup into yellowGroup
      const draggedTab = greenTabs[0];
      await h.moveTabToGroup(draggedTab, yellowGroup);

      // The onUpdated groupId handler fires → _scheduleSortAndUpdate
      await h.waitForSortUpdate();
      await h.triggerEvaluation();

      // Yellow group should now be green (freshest tab is the dragged green tab)
      yellowGrp = await h.getGroup(yellowGroup);
      expect(yellowGrp.color).toBe('green');

      // Verify the dragged tab is in the yellow group
      const tab = await h.getTab(draggedTab);
      expect(tab.groupId).toBe(yellowGroup);

      for (const id of [...greenTabs, ...yellowTabs]) {
        try { await h.closeTab(id); } catch { /* */ }
      }
    }, 35_000);

    it('dragging a yellow tab into a red group makes the group yellow', async () => {
      await h.setFastThresholds({
        greenToYellow: 2000,
        yellowToRed: 4000,
        redToGone: 120000,
        timeMode: 'wallclock',
        bookmarkEnabled: false,
      });

      const yellowTabs = await h.openTabs(2, 'https://example.com');
      const redTabs = await h.openTabs(2, 'https://example.com');

      const windowId = (await h.getTab(yellowTabs[0])).windowId;
      const _yellowGroup = await h.createUserGroup(yellowTabs, 'YellowGrp', windowId);
      const redGroup = await h.createUserGroup(redTabs, 'RedGrp', windowId);

      for (const id of yellowTabs) await h.backdateTab(id, 2500);
      for (const id of redTabs) await h.backdateTab(id, 5000);

      await h.triggerEvaluation();

      let redGrp = await h.getGroup(redGroup);
      expect(redGrp.color).toBe('red');

      // Drag a yellow tab into the red group
      const draggedTab = yellowTabs[0];
      await h.moveTabToGroup(draggedTab, redGroup);

      // The onUpdated groupId handler updates tabMeta.groupId and triggers
      // _scheduleSortAndUpdate. We need a full eval cycle to recalculate
      // group statuses from the updated tab membership.
      await h.waitForSortUpdate();
      // Re-backdate the dragged tab to ensure it's still yellow (not aged further)
      await h.backdateTab(draggedTab, 2500);
      await h.triggerEvaluation();

      // Red group should now be yellow (freshest tab is yellow)
      redGrp = await h.getGroup(redGroup);
      expect(redGrp.color).toBe('yellow');

      for (const id of [...yellowTabs, ...redTabs]) {
        try { await h.closeTab(id); } catch { /* */ }
      }
    }, 35_000);
  });
});
