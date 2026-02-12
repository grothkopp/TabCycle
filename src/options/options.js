import { STORAGE_KEYS, DEFAULT_THRESHOLDS, TIME_MODE } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('options');

const UNIT_TO_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

function msToFriendly(ms) {
  if (ms % UNIT_TO_MS.days === 0 && ms >= UNIT_TO_MS.days) {
    return { value: ms / UNIT_TO_MS.days, unit: 'days' };
  }
  if (ms % UNIT_TO_MS.hours === 0 && ms >= UNIT_TO_MS.hours) {
    return { value: ms / UNIT_TO_MS.hours, unit: 'hours' };
  }
  return { value: ms / UNIT_TO_MS.minutes, unit: 'minutes' };
}

function friendlyToMs(value, unit) {
  return value * (UNIT_TO_MS[unit] || UNIT_TO_MS.hours);
}

function clearErrors() {
  document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
  document.querySelectorAll('.threshold-input input').forEach((el) => { el.classList.remove('invalid'); });
}

function showError(fieldId, message) {
  const errorEl = document.getElementById(`${fieldId}-error`);
  const inputEl = document.getElementById(fieldId);
  if (errorEl) errorEl.textContent = message;
  if (inputEl) inputEl.classList.add('invalid');
}

function showSaveStatus(message, isError) {
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = message;
  statusEl.classList.toggle('error-status', isError);
  statusEl.classList.add('visible');
  setTimeout(() => statusEl.classList.remove('visible'), 2500);
}

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = result[STORAGE_KEYS.SETTINGS] || {
      timeMode: TIME_MODE.ACTIVE,
      thresholds: {
        greenToYellow: DEFAULT_THRESHOLDS.GREEN_TO_YELLOW,
        yellowToRed: DEFAULT_THRESHOLDS.YELLOW_TO_RED,
        redToGone: DEFAULT_THRESHOLDS.RED_TO_GONE,
      },
    };

    const timeModeRadio = document.querySelector(`input[name="timeMode"][value="${settings.timeMode}"]`);
    if (timeModeRadio) timeModeRadio.checked = true;

    const g2y = msToFriendly(settings.thresholds.greenToYellow);
    document.getElementById('greenToYellow').value = g2y.value;
    document.getElementById('greenToYellowUnit').value = g2y.unit;

    const y2r = msToFriendly(settings.thresholds.yellowToRed);
    document.getElementById('yellowToRed').value = y2r.value;
    document.getElementById('yellowToRedUnit').value = y2r.unit;

    const r2g = msToFriendly(settings.thresholds.redToGone);
    document.getElementById('redToGone').value = r2g.value;
    document.getElementById('redToGoneUnit').value = r2g.unit;

    logger.info('Settings loaded');
  } catch (err) {
    logger.error('Failed to load settings', { error: err.message });
    showSaveStatus('Failed to load settings', true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  clearErrors();

  const timeMode = document.querySelector('input[name="timeMode"]:checked').value;

  const g2yValue = parseFloat(document.getElementById('greenToYellow').value);
  const g2yUnit = document.getElementById('greenToYellowUnit').value;
  const y2rValue = parseFloat(document.getElementById('yellowToRed').value);
  const y2rUnit = document.getElementById('yellowToRedUnit').value;
  const r2gValue = parseFloat(document.getElementById('redToGone').value);
  const r2gUnit = document.getElementById('redToGoneUnit').value;

  let hasError = false;

  if (!g2yValue || g2yValue <= 0) {
    showError('greenToYellow', 'Must be a positive number');
    hasError = true;
  }
  if (!y2rValue || y2rValue <= 0) {
    showError('yellowToRed', 'Must be a positive number');
    hasError = true;
  }
  if (!r2gValue || r2gValue <= 0) {
    showError('redToGone', 'Must be a positive number');
    hasError = true;
  }

  if (hasError) return;

  const greenToYellow = friendlyToMs(g2yValue, g2yUnit);
  const yellowToRed = friendlyToMs(y2rValue, y2rUnit);
  const redToGone = friendlyToMs(r2gValue, r2gUnit);

  if (greenToYellow >= yellowToRed) {
    showError('greenToYellow', 'Must be less than Yellow → Red');
    showError('yellowToRed', 'Must be greater than Green → Yellow');
    return;
  }
  if (yellowToRed >= redToGone) {
    showError('yellowToRed', 'Must be less than Red → Gone');
    showError('redToGone', 'Must be greater than Yellow → Red');
    return;
  }

  const settings = {
    timeMode,
    thresholds: { greenToYellow, yellowToRed, redToGone },
  };

  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    showSaveStatus('Settings saved', false);
    logger.info('Settings saved', { timeMode, greenToYellow, yellowToRed, redToGone });
  } catch (err) {
    logger.error('Failed to save settings', { error: err.message });
    showSaveStatus('Failed to save settings', true);
  }
}

document.addEventListener('DOMContentLoaded', loadSettings);
document.getElementById('settings-form').addEventListener('submit', saveSettings);
