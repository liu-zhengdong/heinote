#!/usr/bin/env node
/**
 * Packages the deployable runtime for GitHub Releases (UC-32).
 * Usage: node scripts/package-runtime.mjs <tag>
 * Builds dist, stages the files a running server needs, writes a zip archive
 * and its SHA-256 under release/, and prints the upload command.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/package-runtime.mjs <tag>   # e.g. v1.2.0");
  process.exit(2);
}
const version = tag.replace(/^v/i, "");
const root = resolve(process.cwd());
const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: "inherit", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("npm", ["run", "build"], { cwd: root });

const staging = mkdtempSync(join(tmpdir(), "heinote-runtime-"));
const files = ["package.json", "package-lock.json", "dist", "server", "src", "schema.ts", "tsconfig.json", "tsconfig.server.json", "scripts"];
for (const file of files) cpSync(join(root, file), join(staging, file), { recursive: true });
writeFileSync(join(staging, "runtime-manifest.json"), JSON.stringify({
  name: "heinote", version, files: ["package.json", "package-lock.json", "dist", "server", "src", "schema.ts", "runtime-manifest.json"],
}, null, 2));

const out = join(root, "release");
mkdirSync(out, { recursive: true });
const archive = join(out, `heinote-runtime-${tag}.tar.gz`);
// tar.gz rather than zip: the slim runtime image ships tar but not unzip.
run("tar", ["-czf", archive, "-C", staging, "."], { cwd: root });
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${digest}  ${archive.split("/").pop()}\n`);

console.log(`\nArchive: ${archive}`);
console.log(`SHA-256: ${digest}`);
console.log(`\nAttach to the release:`);
console.log(`  gh release upload ${tag} "${archive}" "${archive}.sha256"`);
