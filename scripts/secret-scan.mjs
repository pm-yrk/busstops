#!/usr/bin/env node
/**
 * Repository secret scan (docs/14_SECURITY.md). Fails the build if anything that looks like a
 * live credential is tracked in git. Deliberately conservative: false positives are cheap,
 * a leaked provider key is not.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "Cloudflare API token", re: /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_-]{30,}/ },
  { name: "Assigned BODS key", re: /\bBODS_API_KEY\s*[:=]\s*['"]?[A-Za-z0-9]{16,}/ },
  { name: "Assigned TfL key", re: /\bTFL_APP_KEY\s*[:=]\s*['"]?[A-Za-z0-9]{16,}/ },
  {
    name: "Generic assigned secret",
    re: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9/+_-]{28,}['"]/i,
  },
];

const ALLOWED_PATH_PREFIXES = ["docs/", "package-lock.json"];
const SKIP_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".pdf",
];
const MAX_BYTES = 2 * 1024 * 1024;

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const findings = [];

for (const file of files) {
  if (SKIP_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
  if (file === "scripts/secret-scan.mjs") continue;
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > MAX_BYTES) continue;

  const content = readFileSync(file, "utf8");
  for (const { name, re } of PATTERNS) {
    const match = content.match(re);
    if (match) {
      if (ALLOWED_PATH_PREFIXES.some((p) => file.startsWith(p))) continue;
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line} — possible ${name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Secret scan found potential credentials in tracked files:\n");
  for (const finding of findings) console.error(`  ${finding}`);
  console.error("\nRemove the value, rotate the credential, and store it as a platform secret.");
  process.exit(1);
}

console.log(`Secret scan clean across ${files.length} tracked files.`);
