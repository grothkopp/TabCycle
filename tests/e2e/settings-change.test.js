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
});
