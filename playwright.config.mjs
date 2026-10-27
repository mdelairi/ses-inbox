export default {
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  outputDir: './test-results',
  use: { baseURL: 'http://127.0.0.1:4317', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4317', reuseExistingServer: true, timeout: 10000 },
};
