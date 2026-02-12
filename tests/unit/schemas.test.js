import {
  validateSettings,
  validateActiveTime,
  validateTabMeta,
  validateWindowState,
} from '../../src/shared/schemas.js';

describe('validateSettings', () => {
  const validSettings = {
    timeMode: 'active',
    thresholds: {
      greenToYellow: 14400000,
      yellowToRed: 28800000,
      redToGone: 86400000,
    },
  };

  it('should pass for valid settings', () => {
    const result = validateSettings(validSettings);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should pass for wallclock mode', () => {
    const result = validateSettings({ ...validSettings, timeMode: 'wallclock' });
    expect(result.valid).toBe(true);
  });

  it('should fail for null input', () => {
    const result = validateSettings(null);
    expect(result.valid).toBe(false);
  });

  it('should fail for invalid timeMode', () => {
    const result = validateSettings({ ...validSettings, timeMode: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('timeMode');
  });

  it('should fail for negative thresholds', () => {
    const result = validateSettings({
      timeMode: 'active',
      thresholds: { greenToYellow: -1, yellowToRed: 100, redToGone: 200 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('greenToYellow'))).toBe(true);
  });

  it('should fail when greenToYellow >= yellowToRed', () => {
    const result = validateSettings({
      timeMode: 'active',
      thresholds: { greenToYellow: 200, yellowToRed: 100, redToGone: 300 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('less than'))).toBe(true);
  });

  it('should fail when yellowToRed >= redToGone', () => {
    const result = validateSettings({
      timeMode: 'active',
      thresholds: { greenToYellow: 100, yellowToRed: 300, redToGone: 200 },
    });
    expect(result.valid).toBe(false);
  });

  it('should fail for missing thresholds object', () => {
    const result = validateSettings({ timeMode: 'active' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('thresholds'))).toBe(true);
  });
});

describe('validateActiveTime', () => {
  const validActiveTime = {
    accumulatedMs: 5000,
    focusStartTime: null,
    lastPersistedAt: Date.now(),
  };

  it('should pass for valid active time', () => {
    const result = validateActiveTime(validActiveTime);
    expect(result.valid).toBe(true);
  });

  it('should pass with focusStartTime set', () => {
    const result = validateActiveTime({ ...validActiveTime, focusStartTime: Date.now() });
    expect(result.valid).toBe(true);
  });

  it('should fail for null input', () => {
    const result = validateActiveTime(null);
    expect(result.valid).toBe(false);
  });

  it('should fail for negative accumulatedMs', () => {
    const result = validateActiveTime({ ...validActiveTime, accumulatedMs: -1 });
    expect(result.valid).toBe(false);
  });

  it('should fail for invalid lastPersistedAt', () => {
    const result = validateActiveTime({ ...validActiveTime, lastPersistedAt: -1 });
    expect(result.valid).toBe(false);
  });

  it('should fail for non-numeric focusStartTime', () => {
    const result = validateActiveTime({ ...validActiveTime, focusStartTime: 'invalid' });
    expect(result.valid).toBe(false);
  });
});

describe('validateTabMeta', () => {
  const validEntry = {
    tabId: 1,
    windowId: 1,
    refreshActiveTime: 0,
    refreshWallTime: Date.now(),
    status: 'green',
    groupId: null,
    isSpecialGroup: false,
    pinned: false,
  };

  it('should pass for valid tab meta', () => {
    const result = validateTabMeta({ 1: validEntry });
    expect(result.valid).toBe(true);
  });

  it('should pass for grouped tab', () => {
    const result = validateTabMeta({ 1: { ...validEntry, groupId: 5, isSpecialGroup: true } });
    expect(result.valid).toBe(true);
  });

  it('should fail for null input', () => {
    const result = validateTabMeta(null);
    expect(result.valid).toBe(false);
  });

  it('should fail for invalid status', () => {
    const result = validateTabMeta({ 1: { ...validEntry, status: 'gone' } });
    expect(result.valid).toBe(false);
  });

  it('should fail for negative tabId', () => {
    const result = validateTabMeta({ 1: { ...validEntry, tabId: -1 } });
    expect(result.valid).toBe(false);
  });

  it('should fail for non-boolean isSpecialGroup', () => {
    const result = validateTabMeta({ 1: { ...validEntry, isSpecialGroup: 'yes' } });
    expect(result.valid).toBe(false);
  });

  it('should fail for string groupId', () => {
    const result = validateTabMeta({ 1: { ...validEntry, groupId: 'abc' } });
    expect(result.valid).toBe(false);
  });

  it('should pass for empty object', () => {
    const result = validateTabMeta({});
    expect(result.valid).toBe(true);
  });
});

describe('validateWindowState', () => {
  const validState = {
    1: {
      specialGroups: { yellow: null, red: null },
      groupZones: {},
    },
  };

  it('should pass for valid window state', () => {
    const result = validateWindowState(validState);
    expect(result.valid).toBe(true);
  });

  it('should pass with special group IDs set', () => {
    const result = validateWindowState({
      1: {
        specialGroups: { yellow: 5, red: 10 },
        groupZones: { 5: 'yellow', 10: 'red', 3: 'green' },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('should fail for null input', () => {
    const result = validateWindowState(null);
    expect(result.valid).toBe(false);
  });

  it('should fail for invalid zone value', () => {
    const result = validateWindowState({
      1: {
        specialGroups: { yellow: null, red: null },
        groupZones: { 5: 'gone' },
      },
    });
    expect(result.valid).toBe(false);
  });

  it('should fail for string specialGroups.yellow', () => {
    const result = validateWindowState({
      1: {
        specialGroups: { yellow: 'abc', red: null },
        groupZones: {},
      },
    });
    expect(result.valid).toBe(false);
  });

  it('should fail for missing specialGroups', () => {
    const result = validateWindowState({
      1: { groupZones: {} },
    });
    expect(result.valid).toBe(false);
  });

  it('should pass for empty object', () => {
    const result = validateWindowState({});
    expect(result.valid).toBe(true);
  });
});
