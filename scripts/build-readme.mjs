#!/usr/bin/env node
/**
 * Rewrite the README's catalog table from registry.json.
 *
 * Run it after adding or changing an entry — `scripts/validate.mjs`
 * (and so CI) fails if you forget.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withCatalog } from "./catalog.mjs";

const root = new URL("..", import.meta.url);
const readmePath = fileURLToPath(new URL("README.md", root));

const registry = JSON.parse(readFileSync(fileURLToPath(new URL("registry.json", root)), "utf8"));
const before = readFileSync(readmePath, "utf8");
const after = withCatalog(before, registry);

if (before === after) {
  console.log("README.md catalog is already up to date.");
} else {
  writeFileSync(readmePath, after);
  console.log("README.md catalog rewritten from registry.json.");
}
