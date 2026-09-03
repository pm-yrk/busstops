import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration (docs/15_TESTING.md).
 *
 * The app is built and served exactly as it will be deployed, and the API is intercepted per test
 * rather than run live. That is deliberate: these tests are about the interface — that a stale
 * state is visible, that a suppressed figure shows its reason, that the map has a usable list
 * alternative — and pinning the data makes those assertions deterministic. Upstream behaviour is
 * covered by the contract and worker suites instead.
 */

const PORT = 4173;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A flaky test is a failing test until it is fixed, so no retries hide one.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Use the Chromium already present in the image rather than downloading another copy. The
    // bundled revision Playwright expects and the one installed here differ, and a browser
    // download in CI is both slow and a needless external dependency.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    // Location is never requested automatically; tests that need it grant it explicitly.
    permissions: [],
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "phone",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
    {
      // The narrowest width the design system supports; horizontal scroll here is a defect.
      name: "phone-small",
      use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 640 } },
    },
  ],

  webServer: {
    command: `npm run build --workspace @busstops/web && npx vite preview --port ${PORT} --strictPort`,
    cwd: "apps/web",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
