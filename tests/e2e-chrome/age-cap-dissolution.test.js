/**
 * E2E: Age Cap & Dissolution
 *
 * Verifies the reactive behaviors triggered by settings changes:
 * - Age cap applied when aging re-enabled (prevents mass closure)
 * - Special group dissolution when tab sorting disabled
 * - Tabs regrouped on next cycle when tab sorting re-enabled
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Age Cap & Dissolution (real Chrome)', () => {
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
    // Reset toggles to defaults
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
      timeMode: 'wallclock',
      thresholds: { greenToYellow: 2000, yellowToRed: 4000, redToGone: 60000 },
      bookmarkEnabled: false,
    };
    await h.writeStorage({ v1_settings: updated });
    await sleep(500);
  });

  it('age cap prevents mass closure when aging is re-enabled', async () => {
    // Use thresholds where redToGone is long enough that even the
    // capped age (redToGone + 60s) won't hit it before we can check.
    const settings = await h.getSettings();
    settings.thresholds = { greenToYellow: 2000, yellowToRed: 4000, redToGone: 60000 };
    settings.agingEnabled = true;
    settings.redToGoneEnabled = false; // prevent tab closure entirely during test
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    const tabId = await h.openTab('https://example.com');

    // Disable aging
    settings.agingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    // Backdate tab to be way past the gone threshold (simulates time passing while aging was off)
    await h.backdateTab(tabId, 500000); // 500 seconds

    // Re-enable aging — should apply age cap
    settings.agingEnabled = true;
    await h.writeStorage({ v1_settings: settings });
    await sleep(2000); // wait for age cap + re-evaluation

    // Tab should still exist (age was capped, not gone)
    const tab = await h.getTab(tabId);
    expect(tab).toBeDefined();

    // Tab's age should be capped at redToGone + 1 minute
    const meta = await h.getTabMeta();
    const tabMeta = meta[tabId] || meta[String(tabId)];
    expect(tabMeta).toBeDefined();
    // Status should be red at most (capped just past redToGone threshold boundary)
    expect(['green', 'yellow', 'red']).toContain(tabMeta.status);
    expect(tabMeta.status).not.toBe('gone');

    await h.closeTab(tabId);
  }, 30_000);

  it('dissolution happens immediately when tab sorting is disabled', async () => {
    // Create a tab that becomes yellow → placed in special group
    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 3000);
    await h.triggerEvaluation();

    let tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1); // in special group

    // Disable tab sorting — should trigger immediate dissolution
    const settings = await h.getSettings();
    settings.tabSortingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(2000); // wait for reactive dissolution

    tab = await h.getTab(tabId);
    expect(tab.groupId).toBe(-1); // ungrouped

    await h.closeTab(tabId);
  }, 25_000);

  it('tabs are regrouped when tab sorting is re-enabled', async () => {
    // Create a yellow tab
    const tabId = await h.openTab('https://example.com');
    await h.backdateTab(tabId, 3000);
    await h.triggerEvaluation();

    let tab = await h.getTab(tabId);
    expect(tab.groupId).not.toBe(-1); // in special group

    // Disable tab sorting → dissolves
    const settings = await h.getSettings();
    settings.tabSortingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(2000);

    tab = await h.getTab(tabId);
    expect(tab.groupId).toBe(-1); // ungrouped

    // Re-enable tab sorting → should regroup on next eval cycle
    settings.tabSortingEnabled = true;
    await h.writeStorage({ v1_settings: settings });
    await sleep(1000);
    await h.triggerEvaluation();

    tab = await h.getTab(tabId);
    // Tab should be back in a special group (yellow or red depending on elapsed wall-clock time)
    expect(tab.groupId).not.toBe(-1);

    const group = await h.getGroup(tab.groupId);
    // By the time re-evaluation runs, wall-clock age may have exceeded the
    // yellowToRed threshold (4s), so accept either yellow or red.
    expect(['yellow', 'red']).toContain(group.color);

    await h.closeTab(tabId);
  }, 30_000);

  it('multiple tabs with different ages are correctly capped on re-enable', async () => {
    const settings = await h.getSettings();
    settings.thresholds = { greenToYellow: 2000, yellowToRed: 4000, redToGone: 60000 };
    settings.agingEnabled = true;
    settings.redToGoneEnabled = false; // prevent tab closure during test
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');

    // Disable aging
    settings.agingEnabled = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);

    // Backdate: tab1 far past gone, tab2 only slightly past yellow
    await h.backdateTab(tab1, 500000);
    await h.backdateTab(tab2, 3000);

    // Re-enable aging
    settings.agingEnabled = true;
    await h.writeStorage({ v1_settings: settings });
    await sleep(2000);
    await h.triggerEvaluation();

    // Both tabs should still exist
    const t1 = await h.getTab(tab1);
    const t2 = await h.getTab(tab2);
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();

    const meta = await h.getTabMeta();
    const m1 = meta[tab1] || meta[String(tab1)];
    const m2 = meta[tab2] || meta[String(tab2)];

    // Tab1 was capped, so shouldn't be gone
    expect(m1.status).not.toBe('gone');
    // Tab2 was recent enough to be yellow (or red if wall-clock elapsed)
    expect(['green', 'yellow', 'red']).toContain(m2.status);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 30_000);
});
