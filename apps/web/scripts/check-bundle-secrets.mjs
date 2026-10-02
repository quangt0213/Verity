#!/usr/bin/env node
// Post-build guard: fail the build if anything that looks like a server secret
// ended up in the static bundle that Maypop will serve to every visitor.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Names of server-only secrets. Their names alone appearing in the bundle is a red flag. */
export const SECRET_NAMES = [
  "NIMBLE_API_KEY",
  "RAWTREE_API_KEY",
  "SESSION_SECRET",
  "DATABASE_URL",
  "INTERNAL_JOB_SECRET",
];

const SECRET_NAME_PATTERN = /(SECRET|PASSWORD|PRIVATE|TOKEN|API_?KEY|ACCESS_?KEY|DATABASE_URL)/i;

/** Credential shapes that should never appear in client code. */
export const SECRET_SHAPES = [
  { name: "database URL with credentials", pattern: /postgres(?:ql)?:\/\/[^\s"'`/:@]+:[^\s"'`@]+@/i },
  { name: "PEM private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "RawTree API key", pattern: /\brt_[A-Za-z0-9]{24,}\b/ },
];

/**
 * @param {string} text
 * @param {string[]} secretValues literal secret values known to the build environment
 * @returns {string[]} human-readable findings
 */
export function scanText(text, secretValues = []) {
  const findings = [];
  for (const name of SECRET_NAMES) if (text.includes(name)) findings.push(`secret variable name "${name}"`);
  for (const { name, pattern } of SECRET_SHAPES) if (pattern.test(text)) findings.push(name);
  for (const value of secretValues) if (value.length >= 8 && text.includes(value)) findings.push("a secret value from the environment");
  return findings;
}

function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

/** Secret values from the process env and any local env files in the repo. */
export function collectSecretValues(repoRoot) {
  const sources = [process.env];
  for (const rel of [".env", ".env.local", "apps/api/.env", "apps/api/.env.local"]) {
    const path = join(repoRoot, rel);
    if (existsSync(path)) sources.push(parseEnvFile(path));
  }
  const values = new Set();
  for (const env of sources) {
    for (const [name, value] of Object.entries(env)) {
      if (!value || name.startsWith("VITE_") || !SECRET_NAME_PATTERN.test(name)) continue;
      values.add(value);
    }
  }
  return [...values];
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = resolve(here, "../dist");
  const repoRoot = resolve(here, "../../..");
  if (!existsSync(dist)) {
    console.error("check-bundle-secrets: dist/ not found; run vite build first.");
    process.exit(1);
  }
  const secretValues = collectSecretValues(repoRoot);
  let failed = false;
  let scanned = 0;
  for (const file of walk(dist)) {
    if (!/\.(js|mjs|css|html|json|map|txt|svg)$/.test(file)) continue;
    scanned += 1;
    const findings = scanText(readFileSync(file, "utf8"), secretValues);
    if (findings.length) {
      failed = true;
      console.error(`✗ ${file}: ${[...new Set(findings)].join(", ")}`);
    }
  }
  if (failed) {
    console.error("Bundle secret check FAILED. Server secrets must never be compiled into the frontend.");
    process.exit(1);
  }
  console.log(`✓ Bundle secret check passed (${scanned} files scanned).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
