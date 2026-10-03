#!/usr/bin/env node
/**
 * The Chromium already on this machine, printed as a path.
 *
 * `npm run test:e2e` downloads nothing in CI because the image carries a browser and the config
 * takes `CHROMIUM_PATH`. Locally the two drifted apart and that quietly cost a whole class of
 * verification: the image here has `chromium-1194`, the pinned `@playwright/test` wants a later
 * revision, and `playwright test` answered "browser is not installed" — so the end-to-end suite
 * read as unrunnable and new specs went to CI unexercised, which is how a container restart came
 * to lose an uncommitted check nobody had run.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` holds several revisions side by side and any of them drives the
 * CDP protocol these tests use, so the newest one found is the answer. Prints nothing and exits
 * non-zero when there is none, so the caller fails loudly rather than launching a download.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
if (!existsSync(root)) {
  process.stderr.write(`No browser directory at ${root}\n`);
  process.exit(1);
}

const candidates = readdirSync(root)
  // Headless shell first would be cheaper, but these tests measure painted pixels and a visible
  // viewport, so the full browser is the one that answers the question they ask.
  .filter((name) => /^chromium-\d+$/.test(name))
  .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((name) => join(root, name, "chrome-linux", "chrome"))
  .filter((path) => existsSync(path));

if (candidates.length === 0) {
  process.stderr.write(`No chromium-<revision>/chrome-linux/chrome under ${root}\n`);
  process.exit(1);
}

process.stdout.write(candidates[0]);
