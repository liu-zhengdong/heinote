import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const svgPath = process.argv[2];
const outPath = process.argv[3] ?? svgPath.replace(/\.svg$/, ".preview.png");
const svg = readFileSync(svgPath, "utf8");
const size = 512;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size } });
await page.setContent(`<html><body style="margin:0;display:flex;align-items:center;justify-content:center;background:transparent;">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: outPath });
await browser.close();
console.log("saved:", outPath);
