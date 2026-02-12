import { jest } from '@jest/globals';

const {
  computeStatus,
  computeAge,
  evaluateAllTabs,
} = await import('../../src/background/status-evaluator.js');

describe('status-evaluator', () => {
  const thresholds = {
    greenToYellow: 14400000,  // 4h
    yellowToRed: 28800000,    // 8h
    redToGone: 86400000,      // 24h
  };

  describe('computeStatus', () => {
    it('should return green when age is below greenToYellow', () => {
      expect(computeStatus(0, thresholds)).toBe('green');
      expect(computeStatus(14399999, thresholds)).toBe('green');
    });

    it('should return yellow when age is at or above greenToYellow but below yellowToRed', () => {
      expect(computeStatus(14400000, thresholds)).toBe('yellow');
      expect(computeStatus(20000000, thresholds)).toBe('yellow');
      expect(computeStatus(28799999, thresholds)).toBe('yellow');
    });

    it('should return red when age is at or above yellowToRed but below redToGone', () => {
      expect(computeStatus(28800000, thresholds)).toBe('red');
      expect(computeStatus(50000000, thresholds)).toBe('red');
      expect(computeStatus(86399999, thresholds)).toBe('red');
    });

    it('should return gone when age is at or above redToGone', () => {
      expect(computeStatus(86400000, thresholds)).toBe('gone');
      expect(computeStatus(100000000, thresholds)).toBe('gone');
    });

    it('should handle zero age', () => {
      expect(computeStatus(0, thresholds)).toBe('green');
    });

    it('should handle exact threshold boundaries', () => {
      expect(computeStatus(14400000, thresholds)).toBe('yellow');
      expect(computeStatus(28800000, thresholds)).toBe('red');
      expect(computeStatus(86400000, thresholds)).toBe('gone');
    });
  });

  describe('computeAge', () => {
    it('should compute age in active time mode', () => {
      const tabMeta = { refreshActiveTime: 1000, refreshWallTime: Date.now() - 5000 };
      const activeTimeMs = 5000;
      const settings = { timeMode: 'active' };
      expect(computeAge(tabMeta, activeTimeMs, settings)).toBe(4000);
    });

    it('should compute age in wall clock mode', () => {
      const now = Date.now();
      const tabMeta = { refreshActiveTime: 0, refreshWallTime: now - 10000 };
      const activeTimeMs = 0;
      const settings = { timeMode: 'wallclock' };
      const age = computeAge(tabMeta, activeTimeMs, settings);
      expect(age).toBeGreaterThanOrEqual(9900);
      expect(age).toBeLessThanOrEqual(10100);
    });

    it('should return 0 when tab was just refreshed (active mode)', () => {
      const tabMeta = { refreshActiveTime: 5000, refreshWallTime: Date.now() };
      const activeTimeMs = 5000;
      const settings = { timeMode: 'active' };
      expect(computeAge(tabMeta, activeTimeMs, settings)).toBe(0);
    });

    it('should never return negative age', () => {
      const tabMeta = { refreshActiveTime: 10000, refreshWallTime: Date.now() + 5000 };
      const activeTimeMs = 5000;
      const settings = { timeMode: 'active' };
      expect(computeAge(tabMeta, activeTimeMs, settings)).toBe(0);
    });
  });

  describe('evaluateAllTabs', () => {
    const settings = {
      timeMode: 'active',
      thresholds,
    };

    it('should return transitions for tabs that changed status', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 14400000; // exactly at yellow threshold

      const transitions = evaluateAllTabs(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
    });

    it('should not include tabs that have not changed status', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 1000; // still green

      const transitions = evaluateAllTabs(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toBeUndefined();
    });

    it('should skip pinned tabs', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: true, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 100000000; // way past gone

      const transitions = evaluateAllTabs(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toBeUndefined();
    });

    it('should handle multiple tabs with different transitions', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        2: { tabId: 2, windowId: 1, refreshActiveTime: 14400000, refreshWallTime: 0, status: 'yellow', pinned: false, groupId: null, isSpecialGroup: false },
        3: { tabId: 3, windowId: 1, refreshActiveTime: 28800000, refreshWallTime: 0, status: 'red', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 86400000 + 28800000; // tab1 gone, tab2 gone, tab3 at redToGone

      const transitions = evaluateAllTabs(tabMeta, activeTimeMs, settings);
      expect(transitions[1].newStatus).toBe('gone');
      expect(transitions[2].newStatus).toBe('gone');
      expect(transitions[3].newStatus).toBe('gone');
    });

    it('should detect green to red transition (skipping yellow)', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 28800000; // at yellowToRed threshold

      const transitions = evaluateAllTabs(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'red' });
    });
  });
});
