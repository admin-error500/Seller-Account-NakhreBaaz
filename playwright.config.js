import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.browser.js',
  use: {
    baseURL: 'http://localhost:4174',
    launchOptions: process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4174 --strictPort',
    url: 'http://localhost:4174',
    timeout: 60000,
    env: {
      VITE_SUPABASE_URL: 'https://seller-test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'local-browser-test-key'
    }
  },
  timeout: 60000,
});
