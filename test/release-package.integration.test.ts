import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { findExecutable, projectRoot, snapshotDirectory } from "./helpers.js";

const npmCli = findExecutable("npm");
const tarballName = "bzenky-branch-care-1.0.0.tgz";
const checksumName = `${tarballName}.sha256`;
const harness = resolve(projectRoot, "test/release-adversarial-harness.mjs");
function realNpmCliPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const result = spawnSync(npmCli, ["root", "--global"], { encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr);
  return resolve(result.stdout.trim(), "npm/bin/npm-cli.js");
}
function observedVerify(artifact: string, checksum: string, report: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [harness, "verify", "observe", artifact, checksum, report], { cwd: projectRoot, env: { ...env, npm_execpath: realNpmCliPath() }, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(report, "utf8")) as { observations: Array<Record<string, any>> };
}

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
    assert.match(result.stdout, /@bzenky\/branch-care@1\.0\.0/);
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
  const output = fixture(); const caller = fixture(); const repositoryNpmrc = resolve(projectRoot, ".npmrc");
  assert.equal(existsSync(repositoryNpmrc), false, "test requires no pre-existing repository .npmrc");
  try {
    const callerCache = resolve(caller.directory, "cache"); mkdirSync(callerCache); writeFileSync(resolve(caller.directory, ".npmrc"), `cache=${callerCache}\n`);
    const before = snapshotDirectory(caller.directory);
    create(output.directory);
    writeFileSync(repositoryNpmrc, "registry=https://repository.invalid/\n//repository.invalid/:_authToken=repository-secret\n");
    const report = resolve(output.directory, "local-report.json");
    const hostile = { ...process.env, HOME: caller.directory, USERPROFILE: caller.directory, npm_config_registry: "https://hostile.invalid/", NPM_CONFIG_TOKEN: "secret", npm_config_proxy: "http://proxy.invalid", NPM_CONFIG_PREFIX: resolve(caller.directory, "hostile-prefix") };
    const observed = observedVerify(resolve(output.directory, tarballName), resolve(output.directory, checksumName), report, hostile);
    assert.equal(snapshotDirectory(caller.directory), before);
    const local = observed.observations.find((entry) => Array.isArray(entry.args) && entry.args[0] === "install" && !entry.args.includes("--global"));
    assert.ok(local); assert.ok(local.env.npm_config_cache.includes("branch-care-verify-")); assert.ok(local.env.npm_config_userconfig.includes("branch-care-verify-"));
    assert.equal(resolve(local.args.at(-1)), local.args.at(-1)); assert.ok(local.args.at(-1).includes("branch-care-verify-"));
    for (const entry of observed.observations.filter((item) => Array.isArray(item.args))) {
      assert.notEqual(resolve(entry.cwd), projectRoot, `npm cwd must be private for ${entry.args.join(" ")}`);
      for (const key of Object.keys(entry.env)) {
        const lower = key.toLowerCase();
        if (lower.startsWith("npm_config_")) assert.ok(["npm_config_cache", "npm_config_userconfig"].includes(lower), `hostile npm variable leaked: ${key}`);
        assert.equal(/token|auth|registry|proxy/.test(lower), false, `credential or network variable leaked: ${key}`);
      }
    }
  } finally { if (existsSync(repositoryNpmrc)) unlinkSync(repositoryNpmrc); output.cleanup(); caller.cleanup(); }
});

test("canonical tarball passes isolated global installation", () => {
  const output = fixture();
  const caller = fixture();
  try {
    const callerCache = resolve(caller.directory, "caller-cache"); const callerPrefix = resolve(caller.directory, "caller-prefix");
    mkdirSync(callerCache); mkdirSync(callerPrefix); writeFileSync(resolve(caller.directory, ".npmrc"), `cache=${callerCache}\nprefix=${callerPrefix}\n`); writeFileSync(resolve(caller.directory, "sentinel"), "unchanged");
    const before = snapshotDirectory(caller.directory);
    create(output.directory);
    const report = resolve(output.directory, "global-report.json");
    const observed = observedVerify(resolve(output.directory, tarballName), resolve(output.directory, checksumName), report, { ...process.env, HOME: caller.directory, USERPROFILE: caller.directory });
    assert.equal(snapshotDirectory(caller.directory), before);
    const global = observed.observations.find((entry) => entry.global)?.global;
    assert.ok(global?.shimExists); assert.ok(global.prefix.startsWith(global.temporaryRoot)); assert.ok(global.cache.startsWith(global.temporaryRoot));
    assert.ok(global.globalBin.startsWith(global.prefix)); assert.ok(global.cacheEntries.length > 0);
    assert.equal(readdirSync(callerPrefix).length, 0); assert.deepEqual(readdirSync(callerCache), []);
    const globalInstalls = observed.observations.filter((entry) => Array.isArray(entry.args) && entry.args[0] === "install" && entry.args.includes("--global"));
    assert.equal(globalInstalls.length, 1); assert.ok(globalInstalls[0]!.args.includes(global.prefix)); assert.ok(globalInstalls[0]!.args.includes(global.cache));
  } finally { output.cleanup(); caller.cleanup(); }
});

test("V1 version is exact across every pre-publication consumer", () => {
  const output = fixture();
  try {
    const metadata = runNpm(["run", "release:metadata"]);
    assert.match(metadata.stdout, /^package-name=@bzenky\/branch-care$/m);
    assert.match(metadata.stdout, /^package-version=1\.0\.0$/m);
    assert.match(metadata.stdout, new RegExp(`^tarball=${tarballName.replaceAll(".", "\\.")}$`, "m"));
    create(output.directory);
    const artifact = resolve(output.directory, tarballName); const checksum = resolve(output.directory, checksumName);
    const verification = runNpm(["run", "release:verify", "--", "--artifact", artifact, "--checksum", checksum]);
    assert.match(verification.stdout, /@bzenky\/branch-care@1\.0\.0/);
    assert.match(verification.stdout, /Verified 48 package files and all consumer paths/);
    assert.match(verification.stdout, new RegExp(`SHA-256 ${sha256(artifact)}`));
  } finally { output.cleanup(); }
});

test("canonical tarball passes explicit npm exec without registry resolution", () => {
  const output = fixture();
  try {
    create(output.directory);
    const report = resolve(output.directory, "exec-report.json");
    const observed = observedVerify(resolve(output.directory, tarballName), resolve(output.directory, checksumName), report);
    const executions = observed.observations.filter((entry) => Array.isArray(entry.args) && entry.args[0] === "exec");
    assert.equal(executions.length, 2);
    for (const execution of executions) {
      const selector = execution.args.find((arg: string) => arg.startsWith("--package="));
      assert.ok(selector); const selectedPath = selector.slice("--package=".length);
      assert.equal(resolve(selectedPath), selectedPath); assert.ok(selectedPath.includes("branch-care-verify-"));
      assert.equal(selector.includes("--package=@bzenky/branch-care"), false); assert.equal(selector === "--package=branch-care", false);
      assert.ok(execution.env.npm_config_cache.startsWith(execution.cwd.includes("inspect") ? dirname(execution.cwd) : resolve(selectedPath, "..", "..")) || execution.env.npm_config_cache.includes("branch-care-verify-"));
      assert.ok(execution.env.npm_config_userconfig.includes("branch-care-verify-"));
    }
  } finally { output.cleanup(); }
});
