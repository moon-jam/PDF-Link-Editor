import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright drives the real app in a headless browser as an automated check.
 * The webServer builds the app and serves the production preview so the tests
 * run against what users actually get. Artifacts (video/trace) are kept only
 * on failure, for debugging.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1366, height: 900 },
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
