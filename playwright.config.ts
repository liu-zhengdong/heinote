import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["browser.test.ts", "collaboration-browser.test.ts", "sidebar-browser.test.ts", "select-browser.test.ts", "github-browser.test.ts", "account-settings-browser.test.ts", "account-settings-recovery-browser.test.ts", "account-settings-zoom-browser.test.ts", "agent-databases-browser.test.ts", "account-avatar-browser.test.ts", "knowledge-bases-browser.test.ts"],
  workers: 1,
  timeout: 45000,
  use: { headless: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, trace: "retain-on-failure" },
});
