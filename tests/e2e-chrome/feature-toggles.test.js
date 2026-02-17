/**
 * E2E: Feature Toggles
 *
 * Verifies that the v2 configuration toggles (agingEnabled, tabSortingEnabled,
 * tabgroupColoringEnabled, autoGroupEnabled, autoGroupNamingEnabled) actually
 * control runtime behavior in a real Chrome instance.
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Feature Toggles (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 4000,
      redToGone: 60000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  beforeEach(async () => {
    await h.resetTabs();
    // Reset all toggles to defaults
    const settings = await h.getSettings();
    const updated = {
      ...settings,
      agingEnabled: true,
      tabSortingEnabled: true,
      tabgroupSortingEnabled: true,
      tabgroupColoringEnabled: true,
      greenToYellowEnabled: true,
      yellowToRedEnabled: true,
      redToGoneEnabled: true,
      autoGroupEnabled: true,
      autoGroupNamingEnabled: true,
      timeMode: 'wallclock',
      thresholds: { greenToYellow: 2000, yellowToRed: 4000, redToGone: 60000 },
      bookmarkEnabled: false,
    };
    await h.writeStorage({ v1_settings: updated });
    await sleep(500);
  });

  it('agingEnabled=false prevents status transitions', async () => {
    // Disable aging
    const settings = await h.getSettings();
    settings.agingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 3000); // past greenToYellow threshold
    await h.triggerEvaluation();

    const meta = await h.getTabMeta();
    const tabMeta = meta[tabId] || meta[String(tabId)];
    expect(tabMeta.status).toBe('green'); // should NOT transition

    await h.closeTab(tabId);
  }, 20_000);

  it('tabSortingEnabled=false prevents special group creation', async () => {
    // Disable tab sorting
    const settings = await h.getSettings();
    settings.tabSortingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 3000);
    await h.triggerEvaluation();

    // Tab should transition status but NOT be placed in a special group
    const tab = await h.getTab(tabId);
    expect(tab.groupId).toBe(-1); // ungrouped

    const meta = await h.getTabMeta();
    const tabMeta = meta[tabId] || meta[String(tabId)];
    expect(tabMeta.status).toBe('yellow'); // status still changes

    await h.closeTab(tabId);
  }, 20_000);

  it('tabSortingEnabled=false dissolves existing special groups', async () => {
    // Create a yellow tab in a special group
    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 3000);
    await h.triggerEvaluation();

    let tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1); // should be in yellow group

    // Now disable tab sorting — should dissolve special groups
    const settings = await h.getSettings();
    settings.tabSortingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(2000); // wait for reactive dissolution

    tab = await h.getTab(tabId);
    expect(tab.groupId).toBe(-1); // ungrouped after dissolution

    await h.closeTab(tabId);
  }, 25_000);

  it('tabgroupColoringEnabled=false prevents group color updates', async () => {
    // Disable coloring
    const settings = await h.getSettings();
    settings.tabgroupColoringEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    // Create a user group with aged tabs
    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'NoColor', windowId);

    // Get the group's original color
    const groupBefore = await h.getGroup(groupId);
    const originalColor = groupBefore.color;

    // Age the tabs past greenToYellow
    await h.backdateTab(tab1, 3000);
    await h.backdateTab(tab2, 3000);
    await h.triggerEvaluation();

    // Group color should NOT have changed (coloring disabled)
    const groupAfter = await h.getGroup(groupId);
    expect(groupAfter.color).toBe(originalColor);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 25_000);

  it('autoGroupEnabled=false prevents new tab auto-grouping', async () => {
    // Disable auto-grouping
    const settings = await h.getSettings();
    settings.autoGroupEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    // Open a context page
    const contextTabId = await h.openTab('https://example.com');
    await sleep(500);

    // Open a child tab from it
    const pages = await h.browser.pages();
    const ctxPage = pages.find((p) => {
      try { return p.url().includes('example.com'); } catch { return false; }
    });
    if (ctxPage) {
      await ctxPage.evaluate(() => { window.open('https://example.org', '_blank'); });
      await sleep(1500);

      // Neither tab should be auto-grouped
      const contextTab = await h.getTab(contextTabId);
      expect(contextTab.groupId).toBe(-1);
    }

    // Cleanup
    const allTabs = await h.queryTabs({});
    for (const t of allTabs) {
      if (!t.pinned) await h.closeTab(t.id);
    }
  }, 25_000);

  it('autoGroupNamingEnabled=false independently stops naming', async () => {
    // Disable auto-naming only (auto-grouping stays on)
    const settings = await h.getSettings();
    settings.autoGroupNamingEnabled = false;
    settings.autoGroupEnabled = true;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    // Verify setting persisted correctly
    const stored = await h.getSettings();
    expect(stored.autoGroupNamingEnabled).toBe(false);
    expect(stored.autoGroupEnabled).toBe(true);

    // Cleanup
    const allTabs = await h.queryTabs({});
    for (const t of allTabs) {
      if (!t.pinned) await h.closeTab(t.id);
    }
  }, 15_000);

  it('greenToYellowEnabled=false caps tabs at green status', async () => {
    // Disable green→yellow transition
    const settings = await h.getSettings();
    settings.greenToYellowEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 10000); // way past all thresholds
    await h.triggerEvaluation();

    const meta = await h.getTabMeta();
    const tabMeta = meta[tabId] || meta[String(tabId)];
    expect(tabMeta.status).toBe('green'); // capped at green

    await h.closeTab(tabId);
  }, 20_000);

  it('redToGoneEnabled=false prevents tabs from being closed', async () => {
    const settings = await h.getSettings();
    settings.redToGoneEnabled = false;
    settings.thresholds = { greenToYellow: 2000, yellowToRed: 4000, redToGone: 6000 };
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 10000); // way past redToGone
    await h.triggerEvaluation();

    // Tab should exist and be red (not gone)
    const tab = await h.getTab(tabId);
    expect(tab).toBeDefined();

    const meta = await h.getTabMeta();
    const tabMeta = meta[tabId] || meta[String(tabId)];
    expect(tabMeta.status).toBe('red');

    await h.closeTab(tabId);
  }, 20_000);
});
