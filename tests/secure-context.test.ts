import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The browser withholds some APIs from a page that is not a secure context —
 *  anything reached over plain HTTP on a LAN address instead of https or
 *  localhost. Calling one directly blanks the page or silently breaks a
 *  feature, so the ones used here go through a helper that falls back. */
const replacements = [
  { pattern: /(?<![\w.])crypto\.randomUUID\s*\(/, helper: "uuid() from core/ids", allowed: ["core/ids.ts"] },
  { pattern: /navigator\.clipboard/, helper: "copyText() from core/clipboard", allowed: ["core/clipboard.ts"] },
];

const root = join(import.meta.dirname, "..", "src");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sources(root).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));

test("the scan sees the source tree", () => {
  assert.ok(files.length > 50, `scanned only ${files.length} files`);
});

for (const { pattern, helper, allowed } of replacements) {
  test(`src calls ${helper} instead of the raw API`, () => {
    const offenders = files.filter((file) => !allowed.includes(file.path) && pattern.test(file.text)).map((file) => file.path);
    assert.deepEqual(offenders, [], `use ${helper} in ${offenders.join(", ")}`);
  });
}
