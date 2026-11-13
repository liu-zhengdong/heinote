import { defineConfig } from "@playwright/test";

// Evidence capture only — manual specs that take screenshots and write into
// .evidence/. Run: `npx playwright test -c playwright.shots.config.ts`.
// These are excluded from playwright.config.ts testMatch so `npm run test:e2e`
// stays green; a shots spec is not a regression gate.
export default defineConfig({
  testDir: "./tests",
  testMatch: "*-shots-spec.ts",
  workers: 1,
  timeout: 120000,
  use: { headless: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 },
});
