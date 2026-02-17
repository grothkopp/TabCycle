/**
 * E2E test for settings changes.
 *
 * Requires Chrome and Puppeteer. Run with:
 *   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e
 */

import { jest } from '@jest/globals';

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
const describeOrSkip = CHROME_PATH ? describe : describe.skip;

describeOrSkip('settings-change E2E', () => {
  let browser;

  beforeAll(async () => {
    const puppeteer = await import('puppeteer');
    browser = await puppeteer.default.launch({
      headless: false,
      executablePath: CHROME_PATH,
      args: [
        `--disable-extensions-except=${process.cwd()}/src`,
        `--load-extension=${process.cwd()}/src`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  }, 30000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it('should save and reload settings', async () => {
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );

    if (!serviceWorkerTarget) {
      console.warn('Service worker not found, skipping test');
      return;
    }

    const extensionId = new URL(serviceWorkerTarget.url()).hostname;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);

    // Change time mode to wall clock
    await page.click('input[name="timeMode"][value="wallclock"]');

    // Change Green→Yellow threshold to 2 hours
    await page.evaluate(() => {
      document.getElementById('greenToYellow').value = '2';
      document.getElementById('greenToYellowUnit').value = 'hours';
    });

    // Save
    await page.click('#save-btn');
    await new Promise((r) => setTimeout(r, 500));

    // Reload page and verify persistence
    await page.reload();
    await new Promise((r) => setTimeout(r, 500));

    const timeMode = await page.evaluate(() =>
      document.querySelector('input[name="timeMode"]:checked').value
    );
    expect(timeMode).toBe('wallclock');

    const g2yValue = await page.evaluate(() =>
      document.getElementById('greenToYellow').value
    );
    expect(g2yValue).toBe('2');

    await page.close();
  });

  it('should display two-section layout with Aging and Auto-Tab-Groups', async () => {
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );
    if (!serviceWorkerTarget) {
      console.warn('Service worker not found, skipping test');
      return;
    }

    const extensionId = new URL(serviceWorkerTarget.url()).hostname;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await new Promise((r) => setTimeout(r, 500));

    // Verify two sections exist
    const hasAgingSection = await page.evaluate(() =>
      document.getElementById('aging-section') !== null
    );
    expect(hasAgingSection).toBe(true);

    const hasAutoGroupSection = await page.evaluate(() =>
      document.getElementById('auto-tab-groups-section') !== null
    );
    expect(hasAutoGroupSection).toBe(true);

    // Verify v2 toggle elements exist
    const v2Toggles = await page.evaluate(() => {
      const ids = [
        'agingEnabled', 'tabSortingEnabled', 'tabgroupSortingEnabled',
        'tabgroupColoringEnabled', 'greenToYellowEnabled', 'yellowToRedEnabled',
        'redToGoneEnabled', 'autoGroupEnabled', 'autoGroupNamingEnabled',
      ];
      return ids.every((id) => document.getElementById(id) !== null);
    });
    expect(v2Toggles).toBe(true);

    // Verify group name fields exist
    const hasGroupNames = await page.evaluate(() =>
      document.getElementById('yellowGroupName') !== null &&
      document.getElementById('redGroupName') !== null
    );
    expect(hasGroupNames).toBe(true);

    await page.close();
  });

  it('should grey out children when aging is disabled', async () => {
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );
    if (!serviceWorkerTarget) {
      console.warn('Service worker not found, skipping test');
      return;
    }

    const extensionId = new URL(serviceWorkerTarget.url()).hostname;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await new Promise((r) => setTimeout(r, 500));

    // Uncheck agingEnabled
    await page.click('#agingEnabled');
    await new Promise((r) => setTimeout(r, 200));

    // Transitions container should be disabled/greyed
    const transitionsDisabled = await page.evaluate(() => {
      const container = document.querySelector('.transitions-container');
      return container && container.classList.contains('disabled-group');
    });
    expect(transitionsDisabled).toBe(true);

    // Re-enable aging
    await page.click('#agingEnabled');
    await new Promise((r) => setTimeout(r, 200));

    const transitionsEnabled = await page.evaluate(() => {
      const container = document.querySelector('.transitions-container');
      return container && !container.classList.contains('disabled-group');
    });
    expect(transitionsEnabled).toBe(true);

    await page.close();
  });

  it('should keep auto-group and auto-naming toggles independent', async () => {
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );
    if (!serviceWorkerTarget) {
      console.warn('Service worker not found, skipping test');
      return;
    }

    const extensionId = new URL(serviceWorkerTarget.url()).hostname;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await new Promise((r) => setTimeout(r, 500));

    // Disable autoGroupEnabled — autoGroupNamingEnabled should still be checkable
    await page.click('#autoGroupEnabled');
    await new Promise((r) => setTimeout(r, 200));

    const namingEnabled = await page.evaluate(() => {
      const el = document.getElementById('autoGroupNamingEnabled');
      return el && !el.disabled;
    });
    expect(namingEnabled).toBe(true);

    // Disable autoGroupNamingEnabled — autoGroupEnabled should still be checkable
    await page.click('#autoGroupNamingEnabled');
    await new Promise((r) => setTimeout(r, 200));

    const groupEnabled = await page.evaluate(() => {
      const el = document.getElementById('autoGroupEnabled');
      return el && !el.disabled;
    });
    expect(groupEnabled).toBe(true);

    await page.close();
  });

  it('should save v2 toggle settings via options page', async () => {
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );
    if (!serviceWorkerTarget) {
      console.warn('Service worker not found, skipping test');
      return;
    }

    const extensionId = new URL(serviceWorkerTarget.url()).hostname;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await new Promise((r) => setTimeout(r, 500));

    // Disable agingEnabled
    const agingChecked = await page.evaluate(() => document.getElementById('agingEnabled').checked);
    if (agingChecked) {
      await page.click('#agingEnabled');
    }

    // Save
    await page.click('#save-btn');
    await new Promise((r) => setTimeout(r, 500));

    // Reload and verify
    await page.reload();
    await new Promise((r) => setTimeout(r, 500));

    const agingAfterReload = await page.evaluate(() =>
      document.getElementById('agingEnabled').checked
    );
    expect(agingAfterReload).toBe(false);

    // Re-enable for other tests
    await page.click('#agingEnabled');
    await page.click('#save-btn');
    await new Promise((r) => setTimeout(r, 500));

    await page.close();
  });

  it('should have collapsible details collapsed by default', async () => {
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );
    if (!serviceWorkerTarget) {
      console.warn('Service worker not found, skipping test');
      return;
    }

    const extensionId = new URL(serviceWorkerTarget.url()).hostname;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await new Promise((r) => setTimeout(r, 500));

    // The aging details section should be collapsed by default
    const agingDetailsOpen = await page.evaluate(() => {
      const details = document.getElementById('aging-details');
      return details && details.open;
    });
    expect(agingDetailsOpen).toBe(false);

    // Click to expand
    await page.click('#aging-details summary');
    await new Promise((r) => setTimeout(r, 200));

    const agingDetailsOpenAfter = await page.evaluate(() => {
      const details = document.getElementById('aging-details');
      return details && details.open;
    });
    expect(agingDetailsOpenAfter).toBe(true);

    await page.close();
  });
});
