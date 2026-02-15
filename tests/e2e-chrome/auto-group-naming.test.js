/**
 * E2E: Auto Group Naming
 *
 * Verifies delayed naming of unnamed groups, user-edit protection, and
 * non-colliding title composition with the group-age suffix feature.
 */

import { createHarness, sleep, SK } from './harness.js';

const describeOrSkip = process.env.SKIP_E2E_CHROME ? describe.skip : describe;

async function setAutoNamingConfig(h, { enabled = true, delayMinutes = 1, showGroupAge = false } = {}) {
  const settings = await h.getSettings();
  await h.writeStorage({
    [SK.SETTINGS]: {
      ...settings,
      autoGroupNamingEnabled: enabled,
      autoGroupNamingDelayMinutes: delayMinutes,
      showGroupAge,
      bookmarkEnabled: false,
    },
  });
  await sleep(500);
}

async function setGroupNamingWindowState(h, windowId, groupId, patch) {
  await h.evalFn(async (wid, gid, storageKey, update) => {
    const state = await chrome.storage.local.get([storageKey]);
    const windowState = state[storageKey] || {};
    const ws = windowState[wid] || windowState[String(wid)] || {
      specialGroups: { yellow: null, red: null },
      groupZones: {},
      groupNaming: {},
    };

    if (!ws.groupNaming || typeof ws.groupNaming !== 'object') {
      ws.groupNaming = {};
    }

    const now = Date.now();
    const existing = ws.groupNaming[gid] || {};
    ws.groupNaming[gid] = {
      firstUnnamedSeenAt: existing.firstUnnamedSeenAt || now,
      lastAutoNamedAt: existing.lastAutoNamedAt ?? null,
      lastCandidate: existing.lastCandidate ?? null,
      userEditLockUntil: existing.userEditLockUntil || now,
      ...update,
    };

    windowState[wid] = ws;
    await chrome.storage.local.set({ [storageKey]: windowState });
  }, windowId, groupId, SK.WINDOW_STATE, patch);
}

function baseWords(title) {
  return title.replace(/\s?\(\d+[mhd]\)$/, '').trim().split(/\s+/).filter(Boolean);
}

describeOrSkip('Auto Group Naming (real Chrome)', () => {
  let h;

  beforeAll(async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        h = await createHarness();
        return;
      } catch (err) {
        lastError = err;
        await sleep(1500);
      }
    }
    throw lastError;
  }, 60_000);

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
    await setAutoNamingConfig(h, { enabled: true, delayMinutes: 5, showGroupAge: false });
  });

  it('auto-names an unnamed group only after the configured delay', async () => {
    const [tab1, tab2] = await h.openTabs(2, 'https://react.dev/learn');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], '', windowId);

    await setGroupNamingWindowState(h, windowId, groupId, {
      firstUnnamedSeenAt: Date.now() - (4 * 60 * 1000),
      userEditLockUntil: Date.now() - 1000,
    });
    await h.triggerEvaluation();

    let group = await h.getGroup(groupId);
    expect((group.title || '').trim()).toBe('');

    await setGroupNamingWindowState(h, windowId, groupId, {
      firstUnnamedSeenAt: Date.now() - (6 * 60 * 1000),
      userEditLockUntil: Date.now() - 1000,
    });
    await h.triggerEvaluation();

    group = await h.getGroup(groupId);
    const words = baseWords(group.title);
    expect(words.length).toBeGreaterThan(0);
    expect(words.length).toBeLessThanOrEqual(2);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 35_000);

  it('treats age-only titles as unnamed and composes auto-name + age suffix', async () => {
    await setAutoNamingConfig(h, { enabled: true, delayMinutes: 1, showGroupAge: true });

    const [tab1, tab2] = await h.openTabs(2, 'https://postgresql.org/docs/current');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], '', windowId);

    await h.backdateTab(tab1, 180000);
    await h.backdateTab(tab2, 180000);
    await setGroupNamingWindowState(h, windowId, groupId, {
      firstUnnamedSeenAt: Date.now() - (3 * 60 * 1000),
      userEditLockUntil: Date.now() - 1000,
    });

    await h.triggerEvaluation();

    const group = await h.getGroup(groupId);
    expect(group.title).toMatch(/^.+\s\(\d+[mhd]\)$/);
    const words = baseWords(group.title);
    expect(words.length).toBeGreaterThan(0);
    expect(words.length).toBeLessThanOrEqual(2);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 35_000);

  it('skips auto-naming while user-edit lock is active at threshold', async () => {
    await setAutoNamingConfig(h, { enabled: true, delayMinutes: 1, showGroupAge: false });

    const [tab1, tab2] = await h.openTabs(2, 'https://kubernetes.io/docs');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], '', windowId);

    await setGroupNamingWindowState(h, windowId, groupId, {
      firstUnnamedSeenAt: Date.now() - (2 * 60 * 1000),
      userEditLockUntil: Date.now() + 3000,
    });
    await h.triggerEvaluation();

    let group = await h.getGroup(groupId);
    expect((group.title || '').trim()).toBe('');

    await sleep(3500);
    await setGroupNamingWindowState(h, windowId, groupId, {
      userEditLockUntil: Date.now() - 1000,
    });
    await h.triggerEvaluation();

    group = await h.getGroup(groupId);
    expect(baseWords(group.title).length).toBeGreaterThan(0);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 40_000);

  it('keeps stable base names across repeated extension title updates with showGroupAge', async () => {
    await setAutoNamingConfig(h, { enabled: true, delayMinutes: 1, showGroupAge: true });

    const [tab1, tab2] = await h.openTabs(2, 'https://developer.mozilla.org/en-US/');
    const windowId = (await h.getTab(tab1)).windowId;
    const groupId = await h.createUserGroup([tab1, tab2], '', windowId);

    await h.backdateTab(tab1, 240000);
    await h.backdateTab(tab2, 240000);
    await setGroupNamingWindowState(h, windowId, groupId, {
      firstUnnamedSeenAt: Date.now() - (2 * 60 * 1000),
      userEditLockUntil: Date.now() - 1000,
    });

    await h.triggerEvaluation();
    const first = await h.getGroup(groupId);
    await h.triggerEvaluation();
    const second = await h.getGroup(groupId);

    const firstWords = baseWords(first.title);
    const secondWords = baseWords(second.title);

    expect(firstWords.join(' ')).toBe(secondWords.join(' '));
    expect(firstWords.length).toBeGreaterThan(0);
    expect(firstWords.length).toBeLessThanOrEqual(2);
    expect((first.title.match(/\(\d+[mhd]\)/g) || []).length).toBe(1);
    expect((second.title.match(/\(\d+[mhd]\)/g) || []).length).toBe(1);

    await h.closeTab(tab1);
    await h.closeTab(tab2);
  }, 40_000);
});
