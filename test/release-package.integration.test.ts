import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { findExecutable, projectRoot } from "./helpers.js";

const npmCli = findExecutable("npm");
const tarballName = "bzenky-branch-care-0.1.0.tgz";
const checksumName = `${tarballName}.sha256`;

function runNpm(args: string[]) {
  const result = spawnSync(npmCli, args, { cwd: projectRoot, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024, shell: process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "branch-care-release-test-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function create(directory: string) {
  return runNpm(["run", "release:package", "--", "--output", directory]);
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("canonical packaging creates only scoped tarball and checksum", () => {
  const output = fixture();
  try {
    const before = spawnSync("git", ["diff", "--binary"], { cwd: projectRoot, encoding: "utf8" }).stdout;
    const result = create(output.directory);
    assert.deepEqual(readdirSync(output.directory).sort(), [tarballName, checksumName].sort());
    assert.match(result.stdout, /@bzenky\/branch-care@0\.1\.0/);
    assert.match(result.stdout, /SHA-256 [0-9a-f]{64}/);
    assert.equal(spawnSync("git", ["diff", "--binary"], { cwd: projectRoot, encoding: "utf8" }).stdout, before);
  } finally { output.cleanup(); }
});

test("canonical packaging proves repeatable bytes and verified checksum", () => {
  const output = fixture();
  try {
    create(output.directory);
    const tarball = resolve(output.directory, tarballName);
    const hash = sha256(tarball);
    assert.equal(readFileSync(resolve(output.directory, checksumName), "utf8"), `${hash}  ${tarballName}\n`);
    const result = runNpm(["run", "release:verify", "--", "--artifact", tarball, "--checksum", resolve(output.directory, checksumName)]);
    assert.match(result.stdout, new RegExp(`SHA-256 ${hash}`));
  } finally { output.cleanup(); }
});

test("canonical tarball passes clean consumer verification", () => {
  const output = fixture();
  try {
    create(output.directory);
    const result = runNpm(["run", "release:verify", "--", "--artifact", resolve(output.directory, tarballName), "--checksum", resolve(output.directory, checksumName)]);
    assert.match(result.stdout, /Verified 48 package files and all consumer paths/);
  } finally { output.cleanup(); }
});

test("canonical tarball passes isolated global installation", () => {
  const output = fixture();
  try {
    const prefixBefore = runNpm(["config", "get", "prefix"]).stdout.trim();
    create(output.directory);
    assert.equal(runNpm(["config", "get", "prefix"]).stdout.trim(), prefixBefore);
  } finally { output.cleanup(); }
});

test("canonical tarball passes explicit npm exec without registry resolution", () => {
  const output = fixture();
  try {
    create(output.directory);
    const artifact = resolve(output.directory, tarballName);
    assert.ok(artifact.startsWith(resolve(output.directory)));
    const source = readFileSync(resolve(projectRoot, "scripts/release-package.mjs"), "utf8");
    assert.match(source, /`--package=\$\{tarball\}`/);
    assert.doesNotMatch(source, /--package=(?:@bzenky\/branch-care|branch-care)["'`]/);
  } finally { output.cleanup(); }
});
