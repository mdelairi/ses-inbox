export default {
  testDir: './tests/browser',
  // A fresh browser profile takes a few seconds to open IndexedDB and seed the sample
  // mailbox, and some journeys reload several times; parallel workers stretch both.
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  outputDir: './test-results',
  use: { baseURL: 'http://127.0.0.1:4317', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4317', reuseExistingServer: true, timeout: 10000 },
};
