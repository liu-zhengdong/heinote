import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests", testMatch: ["admin-shots-spec.ts"], workers: 1, timeout: 120000, use: { headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } });
