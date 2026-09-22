import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { findExecutable, packageJson, projectRoot } from "./helpers.js";

test("scoped package metadata and lockfile stay release-ready", () => {
  const pkg = packageJson();
  assert.equal(pkg.name, "@bzenky/branch-care");
  assert.equal(pkg.author, "bzenky");
  assert.equal(pkg.private, true);
  assert.equal((pkg.bin as Record<string, string>)["branch-care"], "./dist/src/index.js");
  assert.equal((pkg.engines as Record<string, string>).node, ">=22");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.files, ["dist/src", "!dist/src/undo-history.d.ts", "!dist/src/undo-history.d.ts.map", "!dist/src/undo-history.js.map", "!dist/src/commands/undo.d.ts", "!dist/src/commands/undo.d.ts.map", "!dist/src/commands/undo.js.map", "!dist/src/analysis.js.map", "!dist/src/types.js.map"]);
  assert.equal((pkg.repository as Record<string, string>).url, "git+https://github.com/bzenky/branch-care.git");
  assert.equal(pkg.homepage, "https://github.com/bzenky/branch-care#readme");
  assert.equal((pkg.bugs as Record<string, string>).url, "https://github.com/bzenky/branch-care/issues");
  assert.deepEqual(pkg.keywords, ["git", "branch", "cleanup", "cli", "maintenance"]);

  const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8")) as Record<string, unknown>;
  assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version);
  const root = (lock.packages as Record<string, Record<string, unknown>>)[""]!;
  for (const field of ["name", "version", "author", "license", "engines", "dependencies"]) assert.deepEqual(root[field], pkg[field], field);
  assert.deepEqual(root.bin, { "branch-care": "dist/src/index.js" });
});

function dryRunPack(): Record<string, unknown> {
  const npm = findExecutable("npm");
  const result = spawnSync(npm, ["pack", "--dry-run", "--json"], { cwd: projectRoot, encoding: "utf8", timeout: 30_000, shell: process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as Array<Record<string, unknown>>)[0]!;
}

function approvedInventory(): string[] {
  return JSON.parse(readFileSync(resolve(projectRoot, "scripts/package-files.json"), "utf8")) as string[];
}

test("packed scoped package matches the exact approved inventory", () => {
  const packed = dryRunPack();
  assert.equal(packed.name, "@bzenky/branch-care");
  assert.equal(packed.version, "0.1.0");
  assert.equal(packed.filename, "bzenky-branch-care-0.1.0.tgz");
  const paths = (packed.files as Array<{ path: string }>).map(({ path }) => path).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.equal(paths.length, 48);
  assert.deepEqual(paths, approvedInventory());
  for (const required of ["package.json", "README.md", "LICENSE", "dist/src/index.js", "dist/src/git/repository.js", "dist/src/commands/undo.js"]) assert.ok(paths.includes(required));
});

test("packed inventory excludes every private and development class", () => {
  const paths = (dryRunPack().files as Array<{ path: string }>).map(({ path }) => path);
  const prohibited = [/test/i, /(?<!\.d)\.ts$/, /\.specs/, /branch-care-functional-spec/, /^\.github/, /\.env|credential|token/i, /\.branch-care\.json/, /^SECURITY\.md$/, /receipt|history\.lock/i, /refs\/branch-care\/undo/i];
  for (const pattern of prohibited) assert.equal(paths.some((path) => pattern.test(path)), false, String(pattern));
});

test("runtime dependencies match approved doors", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.ok(dependencies.commander);
  assert.ok(dependencies["@inquirer/prompts"]);
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
});

test("test-file concurrency is bounded for cross-platform process stability", () => {
  const scripts = packageJson().scripts as Record<string, string>;
  assert.equal(scripts.test, "npm run build && node --test --test-concurrency=2 dist/test/*.test.js");
});

test("Windows PTY remains development-only", () => {
  const pkg = packageJson();
  const dependencies = pkg.dependencies as Record<string, string>;
  const devDependencies = pkg.devDependencies as Record<string, string>;
  assert.ok(devDependencies["@homebridge/node-pty-prebuilt-multiarch"]);
  assert.equal(dependencies["@homebridge/node-pty-prebuilt-multiarch"], undefined);
});

test("package remains private until the V1 release gate", () => {
  const pkg = packageJson();
  assert.equal(pkg.private, true);
  assert.equal(pkg.version, "0.1.0");
  assert.equal((pkg.engines as Record<string, string>).node, ">=22");
  assert.deepEqual(Object.keys(pkg.dependencies as Record<string, string>).sort(), ["@inquirer/prompts", "commander"]);
});

test("package metadata preserves the V0.10 release boundary", () => {
  const pkg = packageJson();
  assert.equal(pkg.private, true);
  assert.equal(pkg.version, "0.1.0");
  assert.equal((pkg.engines as Record<string, string>).node, ">=22");
  assert.deepEqual(Object.keys(pkg.dependencies as Record<string, string>).sort(), ["@inquirer/prompts", "commander"]);
  assert.equal((pkg.scripts as Record<string, string>)["package:smoke"], "npm run build && node scripts/package-smoke.mjs");
});

test("package metadata preserves the undo history release boundary", () => {
  const pkg = packageJson(); assert.equal(pkg.private, true); assert.equal(pkg.version, "0.1.0"); assert.equal((pkg.engines as Record<string, string>).node, ">=22"); assert.deepEqual(Object.keys(pkg.dependencies as Record<string, string>).sort(), ["@inquirer/prompts", "commander"]);
});

test("configuration uses native JSON and wildcard matching", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
  assert.equal(Object.keys(dependencies).some((name) => /json|glob|minimatch|micromatch/i.test(name)), false);
});

test("JSON status uses native serialization and Git facts", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
  assert.equal(Object.keys(dependencies).some((name) => /json|schema|remote|git/i.test(name)), false);
});
