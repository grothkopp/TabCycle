/**
 * E2E: Settings Persistence & Options Page
 *
 * Verifies that settings changes via the options page are persisted
 * and that the extension responds to them (e.g., changing thresholds
 * triggers re-evaluation, toggling bookmarks works).
 */

import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

describeOrSkip('Settings Persistence (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
  }, 30_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  });

  beforeEach(async () => {
    await h.resetTabs();
  });

  it('options page loads and shows current settings', async () => {
    const page = await h.browser.newPage();
    await page.goto(
      `chrome-extension://${h.extensionId}/options/options.html`
    );
    await sleep(500);

    const title = await page.title();
    expect(title).toBe('TabCycle Settings');

    // Check that the form elements exist
    const hasTimeMode = await page.evaluate(() =>
      document.querySelector('input[name="timeMode"]') !== null
    );
    expect(hasTimeMode).toBe(true);

    const hasGreenToYellow = await page.evaluate(() =>
      document.getElementById('greenToYellow') !== null
    );
    expect(hasGreenToYellow).toBe(true);

    await page.close();
  }, 15_000);

  it('changing time mode via options page persists to storage', async () => {
    const page = await h.browser.newPage();
    await page.goto(
      `chrome-extension://${h.extensionId}/options/options.html`
    );
    await sleep(500);

    // Click wallclock radio
    await page.click('input[name="timeMode"][value="wallclock"]');
    await page.click('#save-btn');
    await sleep(1000);

    const settings = await h.getSettings();
    expect(settings.timeMode).toBe('wallclock');

    // Switch back to active
    await page.click('input[name="timeMode"][value="active"]');
    await page.click('#save-btn');
    await sleep(1000);

    const settingsAfter = await h.getSettings();
    expect(settingsAfter.timeMode).toBe('active');

    await page.close();
  }, 20_000);

  it('settings change triggers re-evaluation of tabs', async () => {
    // Set long thresholds first
    await h.setFastThresholds({
      greenToYellow: 120000,
      yellowToRed: 240000,
      redToGone: 360000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });

    const tabId = await h.openTab('https://example.com');
    // Backdate by 3 seconds
    await h.backdateTab(tabId, 3000);

    // With 120s threshold, tab should still be green
    await h.triggerEvaluation();
    let meta = await h.getTabMeta();
    expect((meta[tabId] || meta[String(tabId)]).status).toBe('green');

    // Now change threshold to 2s — the storage change listener should
    // trigger re-evaluation and the tab should become yellow
    await h.setFastThresholds({
      greenToYellow: 2000,
      yellowToRed: 120000,
      redToGone: 360000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });
    // The storage.onChanged listener triggers runEvaluationCycle
    await sleep(2000);

    meta = await h.getTabMeta();
    expect((meta[tabId] || meta[String(tabId)]).status).toBe('yellow');

    await h.closeTab(tabId);
  }, 25_000);

  it('bookmark toggle persists correctly', async () => {
    // Enable bookmarks
    const settings = await h.getSettings();
    settings.bookmarkEnabled = true;
    settings.bookmarkFolderName = 'Test Folder';
    await h.writeStorage({ v1_settings: settings });
    await sleep(300);

    let stored = await h.getSettings();
    expect(stored.bookmarkEnabled).toBe(true);
    expect(stored.bookmarkFolderName).toBe('Test Folder');

    // Disable bookmarks
    stored.bookmarkEnabled = false;
    await h.writeStorage({ v1_settings: stored });
    await sleep(300);

    stored = await h.getSettings();
    expect(stored.bookmarkEnabled).toBe(false);
  }, 15_000);

  it('showGroupAge setting persists and affects group titles', async () => {
    // Create a user group with aged tabs
    await h.setFastThresholds({
      greenToYellow: 120000,
      yellowToRed: 240000,
      redToGone: 360000,
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });

    const [tab1, tab2] = await h.openTabs(2, 'https://example.com');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], 'AgeTest', windowId);

    // Backdate tabs so they have some age
    await h.backdateTab(tab1, 300000); // 5 minutes
    await h.backdateTab(tab2, 300000);

    // Enable showGroupAge
    const settings = await h.getSettings();
    settings.showGroupAge = true;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);
    await h.triggerEvaluation();

    // Group title should now include an age suffix like "(5m)"
    const group = await h.getGroup(groupId);
    expect(group.title).toMatch(/AgeTest\s?\(\d+[mhd]\)/);

    // Disable showGroupAge
    settings.showGroupAge = false;
    await h.writeStorage({ v1_settings: settings });
    await sleep(500);
    await h.triggerEvaluation();

    // Group title should be back to just "AgeTest"
    const groupAfter = await h.getGroup(groupId);
    expect(groupAfter.title).toBe('AgeTest');

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 35_000);
});
