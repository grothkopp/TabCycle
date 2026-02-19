/**
 * E2E: Tab Status Transitions
 *
 * Verifies that tabs transition green → yellow → red → gone based on age,
 * observing real Chrome tab state after evaluation cycles.
 */

import { createHarness } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Status Transitions (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    // Use wallclock mode with very short thresholds
    await h.setFastThresholds({
      greenToYellow: 2000,   // 2s
      yellowToRed: 4000,     // 4s
      redToGone: 6000,       // 6s
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  beforeEach(async () => {
    await h.resetTabs();
    // Re-apply fast thresholds (resetTabs may trigger evaluation)
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 4000,
      redToGone: 6000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
  });

  it('new tab starts as green in tabMeta', async () => {
    const tabId = await h.openTab('https://example.com');
    const meta = await h.getTabMeta();
    const entry = meta[tabId] || meta[String(tabId)];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('green');
    await h.closeTab(tabId);
  }, 15_000);

  it('tab transitions to yellow after greenToYellow threshold', async () => {
    const tabId = await h.openTab('https://example.com');

    // Backdate the tab so it appears 2.5s old (past greenToYellow=2s)
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();

    const meta = await h.getTabMeta();
    const entry = meta[tabId] || meta[String(tabId)];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('yellow');

    await h.closeTab(tabId);
  }, 15_000);

  it('tab transitions to red after yellowToRed threshold', async () => {
    const tabId = await h.openTab('https://example.com');

    // Backdate past yellowToRed=4s
    await h.backdateTab(tabId, 4500);
    await h.triggerEvaluation();

    const meta = await h.getTabMeta();
    const entry = meta[tabId] || meta[String(tabId)];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('red');

    await h.closeTab(tabId);
  }, 15_000);

  it('tab transitions to gone and is closed after redToGone threshold', async () => {
    const tabId = await h.openTab('https://example.com');

    // Backdate past redToGone=6s
    await h.backdateTab(tabId, 7000);
    await h.triggerEvaluation();

    // The tab should have been closed by the evaluation cycle
    const tabs = await h.queryTabs({});
    const stillExists = tabs.some((t) => t.id === tabId);
    expect(stillExists).toBe(false);

    // tabMeta should no longer contain this tab
    const meta = await h.getTabMeta();
    expect(meta[tabId]).toBeUndefined();
    expect(meta[String(tabId)]).toBeUndefined();
  }, 15_000);

  it('multiple tabs transition independently based on their age', async () => {
    const [tab1, tab2, tab3] = await h.openTabs(3, 'https://example.com');

    // tab1: stays green (reset to fresh — opening 3 tabs takes ~3s)
    // tab2: becomes yellow (2.5s old)
    // tab3: becomes red (4.5s old)
    await h.backdateTab(tab1, 0);
    await h.backdateTab(tab2, 2500);
    await h.backdateTab(tab3, 4500);
    await h.triggerEvaluation();

    const meta = await h.getTabMeta();
    expect((meta[tab1] || meta[String(tab1)]).status).toBe('green');
    expect((meta[tab2] || meta[String(tab2)]).status).toBe('yellow');
    expect((meta[tab3] || meta[String(tab3)]).status).toBe('red');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
    await h.closeTab(tab3);
  }, 20_000);

  it('tab progresses through all statuses sequentially', async () => {
    const tabId = await h.openTab('https://example.com');

    // Verify green
    let meta = await h.getTabMeta();
    expect((meta[tabId] || meta[String(tabId)]).status).toBe('green');

    // → yellow
    await h.backdateTab(tabId, 2500);
    await h.triggerEvaluation();
    meta = await h.getTabMeta();
    expect((meta[tabId] || meta[String(tabId)]).status).toBe('yellow');

    // → red
    await h.backdateTab(tabId, 4500);
    await h.triggerEvaluation();
    meta = await h.getTabMeta();
    expect((meta[tabId] || meta[String(tabId)]).status).toBe('red');

    // → gone (closed)
    await h.backdateTab(tabId, 7000);
    await h.triggerEvaluation();
    const tabs = await h.queryTabs({});
    expect(tabs.some((t) => t.id === tabId)).toBe(false);
  }, 30_000);
});
