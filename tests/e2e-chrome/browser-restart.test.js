/**
 * E2E: Browser Restart (Session Restore)
 *
 * Verifies that tab groups, tab ages, and special groups survive a browser
 * restart.  Launches Chrome with a persistent userDataDir, sets up state
 * (named groups, aged tabs, special groups), closes Chrome, relaunches with
 * --restore-last-session, and asserts the state is preserved.
 *
 * This exercises three fixes introduced together:
 *   1. startupInProgress guard — prevents placeNewTab during session restore
 *   2. URL-based tab matching in reconcileState — preserves ages across ID changes
 *   3. Group-ID remapping — carries forward specialGroups / groupNaming metadata
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHarness, sleep } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

// Strip the age suffix that updateGroupTitlesWithAge appends, e.g. "Work (2m)" → "Work"
function stripAge(title) {
  return (title || '').replace(/\s?\([0-9]+[mhd]\)$/, '').trim();
}

describeOrSkip('Browser restart (session restore)', () => {
  let userDataDir;
  let h1; // first-session harness
  let h2; // post-restart harness

  beforeAll(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabcycle-restart-'));
  });

  afterAll(async () => {
    try { if (h2) await h2.cleanup(); } catch { /* */ }
    try { if (h1) await h1.cleanup(); } catch { /* */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('preserves tab groups, ages, and special groups across restart', async () => {
    // ════════════════════════════════════════════════════════════════════
    // Phase 1 — First session: create tabs, groups, and age state
    // ════════════════════════════════════════════════════════════════════

    h1 = await createHarness({ userDataDir });

    // Wide thresholds so the restart window (a few seconds) can't cause
    // unexpected transitions.  Backdating will place tabs clearly within
    // each zone.
    await h1.setFastThresholds({
      greenToYellow: 30_000,   // 30 s
      yellowToRed:   60_000,   // 60 s
      redToGone:    600_000,   // 10 min — never reached during test
      timeMode: 'wallclock',
      bookmarkEnabled: false,
    });

    // Create tabs with distinct URLs (one URL per tab for unambiguous matching)
    const greenTab1  = await h1.openTab('https://example.com/green1');
    const greenTab2  = await h1.openTab('https://example.com/green2');
    const yellowTab1 = await h1.openTab('https://example.com/yellow1');
    const yellowTab2 = await h1.openTab('https://example.com/yellow2');
    const redTab1    = await h1.openTab('https://example.com/red1');
    const redTab2    = await h1.openTab('https://example.com/red2');
    const ungroupedY = await h1.openTab('https://example.com/uy');
    const ungroupedR = await h1.openTab('https://example.com/ur');

    // Group into named groups
    const windowId = (await h1.getTab(greenTab1)).windowId;
    const _workGroup    = await h1.createUserGroup([greenTab1, greenTab2],  'Work',    windowId);
    const _readingGroup = await h1.createUserGroup([yellowTab1, yellowTab2], 'Reading', windowId);
    const _archiveGroup = await h1.createUserGroup([redTab1, redTab2],       'Archive', windowId);

    // Backdate tabs so evaluation moves them into yellow / red status.
    // Yellow tabs: 35 s (> 30 s threshold, 25 s margin before red).
    // Red tabs:    65 s (> 60 s threshold, 535 s margin before gone).
    for (const tid of [yellowTab1, yellowTab2, ungroupedY]) {
      await h1.backdateTab(tid, 35_000);
    }
    for (const tid of [redTab1, redTab2, ungroupedR]) {
      await h1.backdateTab(tid, 65_000);
    }

    // Run evaluation — creates special groups for the ungrouped aged tabs
    await h1.triggerEvaluation();

    // ── Record "before" snapshot ────────────────────────────────────────

    const beforeMeta  = await h1.getTabMeta();
    const beforeWS    = await h1.getWindowState();
    const beforeGroups = await h1.queryGroups(windowId);

    // Map group baseName → sorted tab URLs
    const beforeGroupUrls = {};
    for (const g of beforeGroups) {
      const tabs = await h1.queryTabs({ groupId: g.id });
      beforeGroupUrls[stripAge(g.title) || `_special_${g.color}`] =
        tabs.map((t) => t.url).sort();
    }

    // Map URL → refreshWallTime (for age-preservation check)
    const beforeWallTimes = {};
    for (const meta of Object.values(beforeMeta)) {
      if (meta.url) beforeWallTimes[meta.url] = meta.refreshWallTime;
    }

    // Map URL → status
    const beforeStatuses = {};
    for (const meta of Object.values(beforeMeta)) {
      if (meta.url) beforeStatuses[meta.url] = meta.status;
    }

    // Verify pre-restart expectations
    const ws1 = beforeWS[windowId] || beforeWS[String(windowId)];
    expect(ws1.specialGroups.yellow).not.toBeNull();
    expect(ws1.specialGroups.red).not.toBeNull();
    expect(beforeGroupUrls['Work']?.length).toBe(2);
    expect(beforeGroupUrls['Reading']?.length).toBe(2);
    expect(beforeGroupUrls['Archive']?.length).toBe(2);

    // ════════════════════════════════════════════════════════════════════
    // Phase 2 — Close Chrome and relaunch with session restore
    // ════════════════════════════════════════════════════════════════════

    await h1.cleanup();
    h1 = null;
    await sleep(2000); // give Chrome time to flush session state

    h2 = await createHarness({
      userDataDir,
      extraArgs: ['--restore-last-session'],
    });

    // Wait for extension startup + reconciliation to finish.
    // Poll until tabMeta has at least as many entries as before.
    const expectedTabCount = Object.keys(beforeMeta).length;
    const startupDeadline = Date.now() + 30_000;
    while (Date.now() < startupDeadline) {
      const meta = await h2.getTabMeta();
      if (Object.keys(meta).length >= expectedTabCount) break;
      await sleep(500);
    }

    // Run an evaluation cycle to settle all state (special groups, colors, sorting)
    await h2.triggerEvaluation();

    // ════════════════════════════════════════════════════════════════════
    // Phase 3 — Verify state after restart
    // ════════════════════════════════════════════════════════════════════

    const afterWid   = await h2.getMainWindowId();
    const afterMeta  = await h2.getTabMeta();
    const afterWS    = await h2.getWindowState();
    const afterGroups = await h2.queryGroups(afterWid);

    // ── 1. Named groups preserved with same tabs ────────────────────────

    const afterGroupUrls = {};
    for (const g of afterGroups) {
      const tabs = await h2.queryTabs({ groupId: g.id });
      afterGroupUrls[stripAge(g.title) || `_special_${g.color}`] =
        tabs.map((t) => t.url).sort();
    }

    for (const name of ['Work', 'Reading', 'Archive']) {
      expect(afterGroupUrls[name]).toBeDefined();
      expect(afterGroupUrls[name]).toEqual(beforeGroupUrls[name]);
    }

    // ── 2. Tab ages preserved (refreshWallTime within tolerance) ────────

    const AGE_TOLERANCE_MS = 5000;
    const afterWallTimes = {};
    for (const meta of Object.values(afterMeta)) {
      if (meta.url) afterWallTimes[meta.url] = meta.refreshWallTime;
    }

    for (const [url, beforeTime] of Object.entries(beforeWallTimes)) {
      const afterTime = afterWallTimes[url];
      if (afterTime === undefined) continue; // tab may not have been restored (e.g. about:blank keeper)
      expect(Math.abs(afterTime - beforeTime)).toBeLessThan(AGE_TOLERANCE_MS);
    }

    // ── 3. Tab statuses preserved ───────────────────────────────────────

    const afterStatuses = {};
    for (const meta of Object.values(afterMeta)) {
      if (meta.url) afterStatuses[meta.url] = meta.status;
    }

    for (const [url, beforeStatus] of Object.entries(beforeStatuses)) {
      if (!afterStatuses[url]) continue;
      expect(afterStatuses[url]).toBe(beforeStatus);
    }

    // ── 4. Special groups exist ─────────────────────────────────────────

    const ws2 = afterWS[afterWid] || afterWS[String(afterWid)];
    expect(ws2).toBeDefined();
    expect(ws2.specialGroups.yellow).not.toBeNull();
    expect(ws2.specialGroups.red).not.toBeNull();

    // ── 5. Ungrouped aged tabs are in the correct special groups ────────

    // Find the tab with the ungrouped-yellow URL
    const afterTabs = await h2.queryTabs({ windowId: afterWid });
    const uyTab = afterTabs.find((t) => t.url === 'https://example.com/uy');
    const urTab = afterTabs.find((t) => t.url === 'https://example.com/ur');

    expect(uyTab).toBeDefined();
    expect(urTab).toBeDefined();

    if (uyTab) {
      expect(uyTab.groupId).toBe(ws2.specialGroups.yellow);
    }
    if (urTab) {
      expect(urTab.groupId).toBe(ws2.specialGroups.red);
    }
  }, 120_000);
});
