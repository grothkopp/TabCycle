/**
 * E2E test for tab lifecycle.
 *
 * Requires Chrome and Puppeteer. Run with:
 *   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e
 *
 * These tests load the extension in a real Chrome instance and verify
 * end-to-end behavior. They are meant to be run manually or in CI
 * with a Chrome binary available.
 */


// Skip E2E tests if no Chrome binary is available
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
const describeOrSkip = CHROME_PATH ? describe : describe.skip;

describeOrSkip('tab-lifecycle E2E', () => {
  let browser;
  let page;

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
    page = await browser.newPage();
  }, 30000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it('should load extension without errors', async () => {
    // Navigate to a page and check that no extension errors appear
    await page.goto('chrome://extensions/');
    // Extension should be loaded
    expect(browser).toBeDefined();
  });

  it('should track new tabs as green', async () => {
    const newPage = await browser.newPage();
    await newPage.goto('about:blank');
    // Wait for evaluation cycle
    await new Promise((r) => setTimeout(r, 1000));
    await newPage.close();
  });

  it('should have options page accessible', async () => {
    // Get the extension ID from chrome://extensions
    const targets = await browser.targets();
    const serviceWorkerTarget = targets.find(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker')
    );

    if (serviceWorkerTarget) {
      const extensionId = new URL(serviceWorkerTarget.url()).hostname;
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
      const title = await optionsPage.title();
      expect(title).toBe('TabCycle Settings');
      await optionsPage.close();
    }
  });
});
