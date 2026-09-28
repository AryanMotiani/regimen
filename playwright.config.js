import { defineConfig } from '@playwright/test'

// End-to-end tests load the built extension into Chromium and drive the real
// web app. Run `npm run build` first (CI does), then `npm run test:e2e`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort --host 0.0.0.0',
    cwd: 'apps/web',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
})
