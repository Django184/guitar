import { defineConfig, devices } from '@playwright/test';
import { A2_WAV } from './e2e/paths';

const PORT = 4173;
/** Pour viser un serveur déjà lancé : E2E_BASE_URL=http://127.0.0.1:5173/ npx playwright test */
const external = process.env.E2E_BASE_URL;

const micArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${A2_WAV}`,
  '--autoplay-policy=no-user-gesture-required',
];

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'e2e-results.json' }]],
  outputDir: 'test-results',
  use: {
    baseURL: external ?? `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
  },
  webServer: external
    ? undefined
    : {
        command: `npm run preview -- --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: !process.env.CI,
      },
  projects: [
    {
      name: 'ordinateur',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions: { args: micArgs } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], launchOptions: { args: micArgs } },
    },
  ],
});
