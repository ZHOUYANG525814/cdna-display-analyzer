#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv.slice(2).map((item) => resolve(item));
const defaults = [
  resolve(root, "pnpm-lock.yaml"),
  resolve(root, "packages/core-wasm/Cargo.lock"),
  resolve(root, "packages/core-wasm/pkg-web/cdna_core_wasm_bg.wasm"),
  resolve(root, "packages/targeted-wasm/pkg-web/cdna_core_wasm_bg.wasm"),
  resolve(root, "apps/web/dist"),
];
const paths = requested.length > 0 ? [...defaults, ...requested] : defaults;
const files = [];
for (const path of paths) await collect(path, files);
const unique = [...new Set(files)].sort();
const entries = [];
for (const path of unique) {
  const info = await stat(path);
  entries.push({
    path: relative(root, path) || ".",
    bytes: info.size,
    sha256: await sha256File(path),
  });
}
const manifest = {
  schemaVersion: "paper-freeze-manifest/v1",
  generatedAt: new Date().toISOString(),
  git: {
    commit: git(["rev-parse", "HEAD"]),
    describe: git(["describe", "--always", "--dirty"]),
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    playwright: dependencyVersion("@playwright/test"),
  },
  files: entries,
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");

async function collect(path, output) {
  let info;
  try { info = await stat(path); } catch { return; }
  if (info.isFile()) { output.push(path); return; }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", ".git", "test-results", "playwright-report"].includes(entry.name)) continue;
    await collect(resolve(path, entry.name), output);
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function git(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
  catch { return null; }
}

function dependencyVersion(name) {
  try {
    return execFileSync(
      process.execPath,
      ["-e", `console.log(require(${JSON.stringify(name + "/package.json")}).version)`],
      { cwd: resolve(root, "apps/web"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch { return null; }
}
