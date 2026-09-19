import { defineConfig, devices } from '@playwright/test'

function requiredOwnedUrl(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be injected by the owned E2E runner`)
  return value
}

const baseURL = requiredOwnedUrl('KCODER_STUDIO_E2E_BASE_URL')
const artifactsRoot = process.env.KCODER_STUDIO_E2E_ARTIFACTS_ROOT
if (!artifactsRoot)
  throw new Error('KCODER_STUDIO_E2E_ARTIFACTS_ROOT must be injected by the owned E2E runner')

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifactsRoot}/playwright-results.json` }],
    ['html', { open: 'never', outputFolder: `${artifactsRoot}/playwright-report` }],
  ],
  outputDir: `${artifactsRoot}/playwright-results`,
  use: {
    baseURL,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
})
