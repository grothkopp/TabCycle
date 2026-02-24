const {
  determineLifecycleStage,
  calculateTabAgeInMs,
  findAllTabsNeedingStatusTransition,
} = await import('../../src/background/status-evaluator.js');

describe('status-evaluator', () => {
  const thresholds = {
    greenToYellow: 14400000,  // 4h
    yellowToRed: 28800000,    // 8h
    redToGone: 86400000,      // 24h
  };

  describe('determineLifecycleStage', () => {
    it('should return green when age is below greenToYellow', () => {
      expect(determineLifecycleStage(0, thresholds)).toBe('green');
      expect(determineLifecycleStage(14399999, thresholds)).toBe('green');
    });

    it('should return yellow when age is at or above greenToYellow but below yellowToRed', () => {
      expect(determineLifecycleStage(14400000, thresholds)).toBe('yellow');
      expect(determineLifecycleStage(20000000, thresholds)).toBe('yellow');
      expect(determineLifecycleStage(28799999, thresholds)).toBe('yellow');
    });

    it('should return red when age is at or above yellowToRed but below redToGone', () => {
      expect(determineLifecycleStage(28800000, thresholds)).toBe('red');
      expect(determineLifecycleStage(50000000, thresholds)).toBe('red');
      expect(determineLifecycleStage(86399999, thresholds)).toBe('red');
    });

    it('should return gone when age is at or above redToGone', () => {
      expect(determineLifecycleStage(86400000, thresholds)).toBe('gone');
      expect(determineLifecycleStage(100000000, thresholds)).toBe('gone');
    });

    it('should handle zero age', () => {
      expect(determineLifecycleStage(0, thresholds)).toBe('green');
    });

    it('should handle exact threshold boundaries', () => {
      expect(determineLifecycleStage(14400000, thresholds)).toBe('yellow');
      expect(determineLifecycleStage(28800000, thresholds)).toBe('red');
      expect(determineLifecycleStage(86400000, thresholds)).toBe('gone');
    });

    // ─── Transition gating tests (v2) ──────────────────────────────────────────

    describe('transition gating', () => {
      it('should cap at green when greenToYellowEnabled is false', () => {
        const toggles = { greenToYellowEnabled: false, yellowToRedEnabled: true, redToGoneEnabled: true };
        expect(determineLifecycleStage(0, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(14400000, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(28800000, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(86400000, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(100000000, thresholds, toggles)).toBe('green');
      });

      it('should cap at yellow when yellowToRedEnabled is false', () => {
        const toggles = { greenToYellowEnabled: true, yellowToRedEnabled: false, redToGoneEnabled: true };
        expect(determineLifecycleStage(0, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(14400000, thresholds, toggles)).toBe('yellow');
        expect(determineLifecycleStage(28800000, thresholds, toggles)).toBe('yellow');
        expect(determineLifecycleStage(86400000, thresholds, toggles)).toBe('yellow');
      });

      it('should cap at red when redToGoneEnabled is false', () => {
        const toggles = { greenToYellowEnabled: true, yellowToRedEnabled: true, redToGoneEnabled: false };
        expect(determineLifecycleStage(0, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(14400000, thresholds, toggles)).toBe('yellow');
        expect(determineLifecycleStage(28800000, thresholds, toggles)).toBe('red');
        expect(determineLifecycleStage(86400000, thresholds, toggles)).toBe('red');
        expect(determineLifecycleStage(100000000, thresholds, toggles)).toBe('red');
      });

      it('should cascade: disabling greenToYellow also blocks yellow→red and red→gone', () => {
        const toggles = { greenToYellowEnabled: false, yellowToRedEnabled: true, redToGoneEnabled: true };
        // Even at age far past redToGone, status stays green
        expect(determineLifecycleStage(200000000, thresholds, toggles)).toBe('green');
      });

      it('should cascade: disabling yellowToRed also blocks red→gone but not green→yellow', () => {
        const toggles = { greenToYellowEnabled: true, yellowToRedEnabled: false, redToGoneEnabled: true };
        expect(determineLifecycleStage(14400000, thresholds, toggles)).toBe('yellow');
        expect(determineLifecycleStage(200000000, thresholds, toggles)).toBe('yellow');
      });

      it('should allow all transitions when all toggles are enabled', () => {
        const toggles = { greenToYellowEnabled: true, yellowToRedEnabled: true, redToGoneEnabled: true };
        expect(determineLifecycleStage(0, thresholds, toggles)).toBe('green');
        expect(determineLifecycleStage(14400000, thresholds, toggles)).toBe('yellow');
        expect(determineLifecycleStage(28800000, thresholds, toggles)).toBe('red');
        expect(determineLifecycleStage(86400000, thresholds, toggles)).toBe('gone');
      });

      it('should allow all transitions when toggles parameter is undefined (backward compat)', () => {
        expect(determineLifecycleStage(0, thresholds, undefined)).toBe('green');
        expect(determineLifecycleStage(14400000, thresholds, undefined)).toBe('yellow');
        expect(determineLifecycleStage(28800000, thresholds, undefined)).toBe('red');
        expect(determineLifecycleStage(86400000, thresholds, undefined)).toBe('gone');
      });

      it('should allow all transitions when toggles parameter is null', () => {
        expect(determineLifecycleStage(14400000, thresholds, null)).toBe('yellow');
        expect(determineLifecycleStage(86400000, thresholds, null)).toBe('gone');
      });

      it('should cap at green when all transitions disabled', () => {
        const toggles = { greenToYellowEnabled: false, yellowToRedEnabled: false, redToGoneEnabled: false };
        expect(determineLifecycleStage(200000000, thresholds, toggles)).toBe('green');
      });

      it('should cap at yellow when only redToGone and yellowToRed disabled', () => {
        const toggles = { greenToYellowEnabled: true, yellowToRedEnabled: false, redToGoneEnabled: false };
        expect(determineLifecycleStage(86400000, thresholds, toggles)).toBe('yellow');
      });
    });
  });

  describe('calculateTabAgeInMs', () => {
    it('should compute age in active time mode', () => {
      const tabMeta = { refreshActiveTime: 1000, refreshWallTime: Date.now() - 5000 };
      const activeTimeMs = 5000;
      const settings = { timeMode: 'active' };
      expect(calculateTabAgeInMs(tabMeta, activeTimeMs, settings)).toBe(4000);
    });

    it('should compute age in wall clock mode', () => {
      const now = Date.now();
      const tabMeta = { refreshActiveTime: 0, refreshWallTime: now - 10000 };
      const activeTimeMs = 0;
      const settings = { timeMode: 'wallclock' };
      const age = calculateTabAgeInMs(tabMeta, activeTimeMs, settings);
      expect(age).toBeGreaterThanOrEqual(9900);
      expect(age).toBeLessThanOrEqual(10100);
    });

    it('should return 0 when tab was just refreshed (active mode)', () => {
      const tabMeta = { refreshActiveTime: 5000, refreshWallTime: Date.now() };
      const activeTimeMs = 5000;
      const settings = { timeMode: 'active' };
      expect(calculateTabAgeInMs(tabMeta, activeTimeMs, settings)).toBe(0);
    });

    it('should never return negative age', () => {
      const tabMeta = { refreshActiveTime: 10000, refreshWallTime: Date.now() + 5000 };
      const activeTimeMs = 5000;
      const settings = { timeMode: 'active' };
      expect(calculateTabAgeInMs(tabMeta, activeTimeMs, settings)).toBe(0);
    });
  });

  describe('findAllTabsNeedingStatusTransition', () => {
    const settings = {
      timeMode: 'active',
      thresholds,
    };

    it('should return transitions for tabs that changed status', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 14400000; // exactly at yellow threshold

      const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
    });

    it('should not include tabs that have not changed status', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 1000; // still green

      const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toBeUndefined();
    });

    it('should skip pinned tabs', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: true, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 100000000; // way past gone

      const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toBeUndefined();
    });

    it('should handle multiple tabs with different transitions', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        2: { tabId: 2, windowId: 1, refreshActiveTime: 14400000, refreshWallTime: 0, status: 'yellow', pinned: false, groupId: null, isSpecialGroup: false },
        3: { tabId: 3, windowId: 1, refreshActiveTime: 28800000, refreshWallTime: 0, status: 'red', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 86400000 + 28800000; // tab1 gone, tab2 gone, tab3 at redToGone

      const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, settings);
      expect(transitions[1].newStatus).toBe('gone');
      expect(transitions[2].newStatus).toBe('gone');
      expect(transitions[3].newStatus).toBe('gone');
    });

    it('should detect green to red transition (skipping yellow)', () => {
      const tabMeta = {
        1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
      };
      const activeTimeMs = 28800000; // at yellowToRed threshold

      const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, settings);
      expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'red' });
    });

    // ─── Transition toggle integration with findAllTabsNeedingStatusTransition ─────────────────────

    describe('transition toggles in findAllTabsNeedingStatusTransition', () => {
      it('should cap status at green when greenToYellowEnabled is false', () => {
        const s = {
          ...settings,
          greenToYellowEnabled: false,
          yellowToRedEnabled: true,
          redToGoneEnabled: true,
        };
        const tabMeta = {
          1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        };
        const activeTimeMs = 100000000; // way past gone

        const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, s);
        expect(transitions[1]).toBeUndefined(); // still green, no transition
      });

      it('should cap status at yellow when yellowToRedEnabled is false', () => {
        const s = {
          ...settings,
          greenToYellowEnabled: true,
          yellowToRedEnabled: false,
          redToGoneEnabled: true,
        };
        const tabMeta = {
          1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        };
        const activeTimeMs = 86400000; // at gone threshold

        const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, s);
        expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'yellow' });
      });

      it('should cap status at red when redToGoneEnabled is false', () => {
        const s = {
          ...settings,
          greenToYellowEnabled: true,
          yellowToRedEnabled: true,
          redToGoneEnabled: false,
        };
        const tabMeta = {
          1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        };
        const activeTimeMs = 100000000; // way past gone

        const transitions = findAllTabsNeedingStatusTransition(tabMeta, activeTimeMs, s);
        expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'red' });
      });

      it('should not transition when all transitions disabled and tab is green', () => {
        const s = {
          ...settings,
          greenToYellowEnabled: false,
          yellowToRedEnabled: false,
          redToGoneEnabled: false,
        };
        const tabMeta = {
          1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        };
        const transitions = findAllTabsNeedingStatusTransition(tabMeta, 200000000, s);
        expect(Object.keys(transitions)).toHaveLength(0);
      });

      it('should use defaults when transition toggles are absent (backward compat)', () => {
        const tabMeta = {
          1: { tabId: 1, windowId: 1, refreshActiveTime: 0, refreshWallTime: 0, status: 'green', pinned: false, groupId: null, isSpecialGroup: false },
        };
        const transitions = findAllTabsNeedingStatusTransition(tabMeta, 86400000, settings);
        expect(transitions[1]).toEqual({ oldStatus: 'green', newStatus: 'gone' });
      });
    });
  });
});
