import { defineConfig, devices } from '@playwright/test';

const SMOKE_TEST_PORT = process.env.SMOKE_TEST_PORT || '3100';
const SMOKE_TEST_URL = `http://localhost:${SMOKE_TEST_PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: 'smoke.spec.js',
  timeout: 15000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    // Use a dedicated smoke-test port so local app on 3000 stays untouched.
    baseURL: SMOKE_TEST_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${SMOKE_TEST_PORT}`,
    url: SMOKE_TEST_URL,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
