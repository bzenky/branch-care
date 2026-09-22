import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packageName = "@bzenky/branch-care";
export const packageVersion = "0.1.0";
export const tarballName = "bzenky-branch-care-0.1.0.tgz";
export const sidecarName = `${tarballName}.sha256`;
export const approvedPaths = Object.freeze(JSON.parse(readFileSync(resolve(projectRoot, "scripts/package-files.json"), "utf8")));
const timeout = 120_000;
const maxBuffer = 2 * 1024 * 1024;
const cleanupOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

function fail(stage, message) {
  throw new Error(`${stage}: ${message}`);
}

function injected(stage, options) {
  if (options?.failStage === stage) fail(stage, "injected failure");
}

function npmCli() {
  const cli = process.env.npm_execpath;
  if (!cli || !isAbsolute(cli)) fail("npm", "run this command through npm so npm_execpath is an absolute path");
  return cli;
}

function runNpm(args, { cwd = projectRoot, env = process.env, stage }) {
  const result = spawnSync(process.execPath, [npmCli(), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer,
    windowsHide: true
  });
  if (result.error) fail(stage, result.error.message);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `npm exited ${result.status}`).trim().slice(0, 4000);
    fail(stage, detail);
  }
  return result.stdout;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bytewiseSort(paths) {
  return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function validatePackRecord(record) {
  assert.equal(record?.name, packageName, `pack identity must be ${packageName}`);
  assert.equal(record?.version, packageVersion, `pack version must be ${packageVersion}`);
  assert.equal(record?.filename, tarballName, `pack filename must be ${tarballName}`);
  const paths = bytewiseSort((record?.files ?? []).map((file) => file.path));
  assert.deepEqual(paths, approvedPaths, "packed paths differ from scripts/package-files.json");
  for (const required of ["package.json", "README.md", "LICENSE", "dist/src/index.js"]) {
    assert.ok(paths.includes(required), `packed files are missing ${required}`);
  }
  const prohibited = [
    /(^|\/)test(s)?\//i, /(?<!\.d)\.ts$/, /\.specs\//, /branch-care-functional-spec\.md$/,
    /^\.github\//, /(^|\/)(\.env|.*credential.*|.*token.*)$/i, /\.branch-care\.json$/,
    /^SECURITY\.md$/, /(^|\/)undo\/.*(receipt|history\.lock)/i, /refs\/branch-care\/undo/i
  ];
  for (const path of paths) {
    assert.ok(!prohibited.some((pattern) => pattern.test(path)), `prohibited package path: ${path}`);
  }
  return paths;
}

export function packInto(destination, options = {}) {
  injected("pack", options);
  const output = runNpm(["pack", "--json", "--pack-destination", destination], { stage: "pack" });
  let records;
  try { records = JSON.parse(output); } catch { fail("pack", "npm pack returned invalid JSON"); }
  if (!Array.isArray(records) || records.length !== 1) fail("pack", "npm pack must return exactly one record");
  if (options.failStage === "inventory") records[0].files = records[0].files.slice(1);
  try { validatePackRecord(records[0]); } catch (error) { fail("inventory", error.message); }
  return resolve(destination, records[0].filename);
}


function assertManifest(manifest) {
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.author, "bzenky");
  assert.equal(manifest.version, packageVersion);
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.engines?.node, ">=22");
  assert.equal(manifest.bin?.["branch-care"], "./dist/src/index.js");
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["@inquirer/prompts", "commander"]);
}

function executableAt(root) {
  return resolve(root, "node_modules", ".bin", process.platform === "win32" ? "branch-care.cmd" : "branch-care");
}

function runBinary(executable, args, cwd, stage) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer,
    shell: process.platform === "win32",
    windowsHide: true
  });
  if (result.error) fail(stage, result.error.message);
  if (result.status !== 0 || result.stderr !== "") fail(stage, (result.stderr || `binary exited ${result.status}`).trim());
  return result.stdout;
}

function checkCli(executable, cwd, stage, includeUndo = false) {
  assert.equal(runBinary(executable, ["--version"], cwd, stage).trim(), packageVersion, `${stage}: wrong version`);
  const help = runBinary(executable, [], cwd, stage);
  assert.match(help, /Usage: branch-care/);
  assert.match(help, /status \[options\]/);
  assert.match(help, /clean \[options\]/);
  if (includeUndo) {
    const undo = runBinary(executable, ["undo", "--help"], cwd, stage);
    assert.match(undo, /--list/);
    assert.match(undo, /--discard <operation-id>/);
  }
}

export function verifySidecar(tarball, sidecar, options = {}) {
  injected("sidecar", options);
  const expected = readFileSync(sidecar, "utf8");
  const match = expected.match(/^([0-9a-f]{64})  ([^\r\n]+)\n$/);
  if (!match || match[2] !== tarballName) fail("sidecar", `expected '<sha256>  ${tarballName}'`);
  const actual = hashFile(tarball);
  if (match[1] !== actual) fail("sidecar", `checksum mismatch: expected ${match[1]}, received ${actual}`);
  return actual;
}

export function verifyCanonical({ artifact, checksum, failStage } = {}) {
  if (!artifact || !checksum) fail("input", "--artifact and --checksum are required");
  const tarball = resolve(artifact);
  const sidecar = resolve(checksum);
  if (basename(tarball) !== tarballName || basename(sidecar) !== sidecarName) fail("input", "canonical artifact filenames are required");
  if (!existsSync(tarball) || !statSync(tarball).isFile()) fail("input", `artifact does not exist: ${tarball}`);
  if (!existsSync(sidecar) || !statSync(sidecar).isFile()) fail("input", `checksum does not exist: ${sidecar}`);
  const options = { failStage };
  const hash = verifySidecar(tarball, sidecar, options);
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "branch-care-verify-"));
  try {
    const inspect = resolve(temporaryRoot, "inspect");
    mkdirSync(inspect);
    const packedOutput = runNpm(["pack", "--json", "--dry-run", tarball], { cwd: inspect, stage: "inventory" });
    const [record] = JSON.parse(packedOutput);
    if (failStage === "inventory") record.files = record.files.slice(1);
    try { validatePackRecord(record); } catch (error) { fail("inventory", error.message); }

    injected("local install", options);
    const consumer = resolve(temporaryRoot, "consumer");
    mkdirSync(consumer);
    writeFileSync(resolve(consumer, "package.json"), '{"name":"branch-care-consumer","private":true}\n');
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer, stage: "local install" });
    assertManifest(JSON.parse(readFileSync(resolve(consumer, "node_modules/@bzenky/branch-care/package.json"), "utf8")));
    injected("binary", options);
    checkCli(executableAt(consumer), consumer, "installed binary", true);

    injected("global install", options);
    const prefix = resolve(temporaryRoot, "global-prefix");
    const globalCache = resolve(temporaryRoot, "global-cache");
    mkdirSync(prefix); mkdirSync(globalCache);
    const originalPrefix = runNpm(["config", "get", "prefix"], { stage: "global prefix" }).trim();
    runNpm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, "--cache", globalCache, tarball], { stage: "global install" });
    const globalBin = process.platform === "win32" ? resolve(prefix, "branch-care.cmd") : resolve(prefix, "bin", "branch-care");
    assert.ok(existsSync(globalBin), `global install: missing isolated shim ${globalBin}`);
    checkCli(globalBin, prefix, "global binary");
    assert.equal(runNpm(["config", "get", "prefix"], { stage: "global prefix" }).trim(), originalPrefix, "global prefix changed");

    injected("npm exec", options);
    const execCache = resolve(temporaryRoot, "exec-cache");
    mkdirSync(execCache);
    const execEnv = { ...process.env, npm_config_cache: execCache };
    for (const args of [["--version"], ["--help"]]) {
      const output = runNpm(["exec", "--yes", `--package=${tarball}`, "--", "branch-care", ...args], { env: execEnv, stage: "npm exec" });
      if (args[0] === "--version") assert.equal(output.trim(), packageVersion);
      else assert.match(output, /Usage: branch-care/);
    }
    return { hash, paths: approvedPaths };
  } finally {
    rmSync(temporaryRoot, cleanupOptions);
  }
}

export function createCanonical({ output, failStage } = {}) {
  if (!output) fail("output", "--output is required");
  const destination = resolve(output);
  if (!existsSync(destination) || !statSync(destination).isDirectory()) fail("output", `directory does not exist: ${destination}`);
  if (readdirSync(destination).length !== 0) fail("output", `directory must be empty: ${destination}`);
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "branch-care-create-"));
  const options = { failStage };
  try {
    const first = resolve(temporaryRoot, "first");
    const second = resolve(temporaryRoot, "second");
    mkdirSync(first); mkdirSync(second);
    const firstTarball = packInto(first, options);
    const secondTarball = packInto(second, options);
    if (failStage === "repeat pack") writeFileSync(secondTarball, Buffer.concat([readFileSync(secondTarball), Buffer.from("changed")]));
    const firstHash = hashFile(firstTarball);
    const secondHash = hashFile(secondTarball);
    if (!readFileSync(firstTarball).equals(readFileSync(secondTarball)) || firstHash !== secondHash) {
      fail("repeat pack", `packed bytes differ (${firstHash} != ${secondHash})`);
    }
    const artifact = resolve(destination, tarballName);
    const checksum = resolve(destination, sidecarName);
    copyFileSync(firstTarball, artifact);
    writeFileSync(checksum, `${firstHash}  ${tarballName}\n`);
    verifyCanonical({ artifact, checksum, failStage });
    return { artifact, checksum, hash: firstHash, paths: approvedPaths };
  } catch (error) {
    rmSync(resolve(destination, tarballName), { force: true });
    rmSync(resolve(destination, sidecarName), { force: true });
    throw error;
  } finally {
    rmSync(temporaryRoot, cleanupOptions);
  }
}
