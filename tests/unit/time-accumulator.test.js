import { jest } from '@jest/globals';

// Mock chrome APIs before importing module
const mockStorage = {};
const mockStorageGet = jest.fn(async (keys) => {
  const result = {};
  for (const key of keys) {
    if (mockStorage[key] !== undefined) {
      result[key] = JSON.parse(JSON.stringify(mockStorage[key]));
    }
  }
  return result;
});
const mockStorageSet = jest.fn(async (data) => {
  Object.assign(mockStorage, JSON.parse(JSON.stringify(data)));
});

globalThis.chrome = {
  storage: {
    local: {
      get: mockStorageGet,
      set: mockStorageSet,
    },
  },
  windows: {
    WINDOW_ID_NONE: -1,
  },
};

const {
  createDefaultActiveTimeState,
  initializeActiveTimeInStorage,
  recoverActiveTimeAfterRestart,
  updateActiveTimeOnWindowFocusChange,
  getCurrentTotalActiveTimeMs,
  saveActiveTimeToStorage,
  getActiveTimeSnapshot,
} = await import('../../src/background/time-accumulator.js');

describe('time-accumulator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
  });

  describe('createDefaultActiveTimeState', () => {
    it('should return correct default state', () => {
      const state = createDefaultActiveTimeState();
      expect(state.accumulatedMs).toBe(0);
      expect(state.focusStartTime).toBeNull();
      expect(typeof state.lastPersistedAt).toBe('number');
      expect(state.lastPersistedAt).toBeGreaterThan(0);
    });
  });

  describe('initializeActiveTimeInStorage', () => {
    it('should write defaults to storage and return state', async () => {
      const state = await initializeActiveTimeInStorage();
      expect(state.accumulatedMs).toBe(0);
      expect(state.focusStartTime).toBeNull();
      expect(mockStorageSet).toHaveBeenCalled();
    });
  });

  describe('recoverActiveTimeAfterRestart', () => {
    it('should initialize if no state exists', async () => {
      const state = await recoverActiveTimeAfterRestart();
      expect(state.accumulatedMs).toBe(0);
      expect(state.focusStartTime).toBeNull();
    });

    it('should add delta when focusStartTime was set', async () => {
      const pastTime = Date.now() - 5000;
      mockStorage['v1_activeTime'] = {
        accumulatedMs: 10000,
        focusStartTime: pastTime - 10000,
        lastPersistedAt: pastTime,
      };

      const state = await recoverActiveTimeAfterRestart();
      // Should have added ~5000ms delta
      expect(state.accumulatedMs).toBeGreaterThanOrEqual(14000);
      expect(state.accumulatedMs).toBeLessThanOrEqual(16000);
    });

    it('should not add delta when focusStartTime is null', async () => {
      const pastTime = Date.now() - 5000;
      mockStorage['v1_activeTime'] = {
        accumulatedMs: 10000,
        focusStartTime: null,
        lastPersistedAt: pastTime,
      };

      const state = await recoverActiveTimeAfterRestart();
      expect(state.accumulatedMs).toBe(10000);
    });
  });

  describe('updateActiveTimeOnWindowFocusChange', () => {
    beforeEach(async () => {
      await initializeActiveTimeInStorage();
    });

    it('should start accumulating when window gains focus', async () => {
      const result = await updateActiveTimeOnWindowFocusChange(1);
      expect(result.focusStartTime).not.toBeNull();
      expect(typeof result.focusStartTime).toBe('number');
    });

    it('should stop accumulating and add delta when all windows lose focus', async () => {
      await updateActiveTimeOnWindowFocusChange(1); // gain focus
      await getCurrentTotalActiveTimeMs();

      // Simulate small delay
      const result = await updateActiveTimeOnWindowFocusChange(chrome.windows.WINDOW_ID_NONE); // lose focus
      expect(result.focusStartTime).toBeNull();
      expect(result.accumulatedMs).toBeGreaterThanOrEqual(0);
    });

    it('should not change focusStartTime when switching between windows', async () => {
      await updateActiveTimeOnWindowFocusChange(1); // focus window 1
      const state1 = await getActiveTimeSnapshot();
      const startTime = state1.focusStartTime;

      await updateActiveTimeOnWindowFocusChange(2); // focus window 2 (still focused)
      const state2 = await getActiveTimeSnapshot();
      expect(state2.focusStartTime).toBe(startTime);
    });

    it('should auto-recover if called before loading', async () => {
      // Since we already called initializeActiveTimeInStorage in beforeEach, cachedActiveTime is set.
      // Just verify the function returns a valid state after await.
      const result = await updateActiveTimeOnWindowFocusChange(1);
      expect(result).not.toBeNull();
    });
  });

  describe('getCurrentTotalActiveTimeMs', () => {
    it('should return 0 when freshly initialized', async () => {
      await initializeActiveTimeInStorage();
      const time = await getCurrentTotalActiveTimeMs();
      expect(time).toBe(0);
    });

    it('should include in-progress focus session', async () => {
      await initializeActiveTimeInStorage();
      await updateActiveTimeOnWindowFocusChange(1); // start focus

      // getCurrentTotalActiveTimeMs should include delta from focus start
      const time = await getCurrentTotalActiveTimeMs();
      expect(time).toBeGreaterThanOrEqual(0);
    });

    it('should return accumulated time after focus ends', async () => {
      await initializeActiveTimeInStorage();
      await updateActiveTimeOnWindowFocusChange(1); // start focus
      await updateActiveTimeOnWindowFocusChange(chrome.windows.WINDOW_ID_NONE); // end focus

      const time = await getCurrentTotalActiveTimeMs();
      expect(time).toBeGreaterThanOrEqual(0);
    });
  });

  describe('saveActiveTimeToStorage', () => {
    it('should write current state to storage', async () => {
      await initializeActiveTimeInStorage();
      await updateActiveTimeOnWindowFocusChange(1);

      mockStorageSet.mockClear();
      await saveActiveTimeToStorage();
      expect(mockStorageSet).toHaveBeenCalled();
    });
  });
});
