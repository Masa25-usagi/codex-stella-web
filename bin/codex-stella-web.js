#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, "..", "dist", "cli.js");

if (existsSync(distPath)) {
  await import(distPath);
} else {
  // If dist hasn't been built yet, use tsx/node loader
  const srcPath = join(__dirname, "..", "src", "cli.ts");
  const { spawnSync } = await import("node:child_process");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, ["tsx", srcPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 0);
}
