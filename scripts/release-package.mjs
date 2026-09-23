import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadReleaseMetadata(manifestPath = resolve(projectRoot, "package.json")) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { fail("manifest", `${manifestPath}: ${error.message}`); }
  const name = manifest?.name;
  const version = manifest?.version;
  if (typeof name !== "string" || name.length > 214 || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
    fail("manifest", "package name must be a lowercase scoped npm name no longer than 214 characters");
  }
  const semver = typeof version === "string"
    ? version.match(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
    : null;
  const prerelease = semver?.[4]?.split(".") ?? [];
  if (!semver || prerelease.some((identifier) => /^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    fail("manifest", "package version must be a valid semantic version");
  }
  const artifactBase = `${name.slice(1).replace("/", "-")}-${version}`;
  const tarball = `${artifactBase}.tgz`;
  return Object.freeze({ manifest, packageName: name, packageVersion: version, tarballName: tarball, sidecarName: `${tarball}.sha256`, artifactBase });
}

const releaseMetadata = loadReleaseMetadata();
export const { packageName, packageVersion, tarballName, sidecarName, artifactBase } = releaseMetadata;
export const approvedPaths = Object.freeze(JSON.parse(readFileSync(resolve(projectRoot, "scripts/package-files.json"), "utf8")));
const timeout = 120_000;
const maxBuffer = 2 * 1024 * 1024;
const cleanupOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
const noFollow = constants.O_NOFOLLOW ?? 0;

function fail(stage, message) { throw new Error(`${stage}: ${message}`); }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameSnapshotMetadata(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function fingerprint(stat, hash) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, hash }; }
function sameFingerprint(left, right) { return sameSnapshotMetadata(left, right) && left.hash === right.hash; }
function regularLstat(path, stage) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch (error) { fail(stage, `${path}: ${error.message}`); }
  if (stat.isSymbolicLink()) fail(stage, `symbolic links are not allowed: ${path}`);
  if (!stat.isFile()) fail(stage, `regular file required: ${path}`);
  return stat;
}
function directoryLstat(path, stage) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch (error) { fail(stage, `${path}: ${error.message}`); }
  if (stat.isSymbolicLink()) fail(stage, `symbolic links are not allowed: ${path}`);
  if (!stat.isDirectory()) fail(stage, `directory required: ${path}`);
  return stat;
}
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function identityAt(path) {
  const stat = regularLstat(path, "cleanup");
  return fingerprint(stat, hashFile(path));
}

function copyRegularSnapshot(source, destination, stage, hooks) {
  const beforePath = regularLstat(source, stage);
  hooks?.beforeSnapshotOpen?.(source);
  let sourceFd;
  let destinationFd;
  const hash = createHash("sha256");
  try {
    sourceFd = openSync(source, constants.O_RDONLY | noFollow);
    const opened = fstatSync(sourceFd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(beforePath, opened)) fail(stage, `source changed before it could be opened: ${source}`);
    destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (true) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hooks?.duringSnapshotCopy?.(source, copied);
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) offset += writeSync(destinationFd, buffer, offset, count - offset);
      copied += count;
    }
    const afterFd = fstatSync(sourceFd, { bigint: true });
    const afterPath = regularLstat(source, stage);
    if (!sameSnapshotMetadata(opened, afterFd) || !sameSnapshotMetadata(opened, afterPath) || BigInt(copied) !== opened.size) {
      fail(stage, `source changed while it was copied: ${source}`);
    }
    return hash.digest("hex");
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
}

function npmCli() {
  const cli = process.env.npm_execpath;
  if (!cli || !isAbsolute(cli)) fail("npm", "run this command through npm so npm_execpath is an absolute path");
  return cli;
}
function runNpm(args, { cwd = projectRoot, env = process.env, stage, observe }) {
  observe?.({ args: [...args], cwd, env: { ...env } });
  const result = spawnSync(process.execPath, [npmCli(), ...args], { cwd, env, encoding: "utf8", timeout, maxBuffer, windowsHide: true });
  if (result.error) fail(stage, result.error.message);
  if (result.status !== 0) fail(stage, (result.stderr || result.stdout || `npm exited ${result.status}`).trim().slice(0, 4000));
  return result.stdout;
}
function isolatedNpmEnvironment(root, cacheName) {
  const home = resolve(root, "home");
  const cache = resolve(root, cacheName);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const userconfig = resolve(root, "npmrc");
  try { writeFileSync(userconfig, "", { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec", "WINDIR", "windir", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "CI"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, npm_config_cache: cache, npm_config_userconfig: userconfig, NPM_CONFIG_CACHE: cache, NPM_CONFIG_USERCONFIG: userconfig });
  return { env, cache, home, userconfig };
}
function bytewiseSort(paths) { return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); }

export function validatePackRecord(record) {
  assert.equal(record?.name, packageName, `pack identity must be ${packageName}`);
  assert.equal(record?.version, packageVersion, `pack version must be ${packageVersion}`);
  assert.equal(record?.filename, tarballName, `pack filename must be ${tarballName}`);
  const paths = bytewiseSort((record?.files ?? []).map((file) => file.path));
  assert.deepEqual(paths, approvedPaths, "packed paths differ from scripts/package-files.json");
  for (const required of ["package.json", "README.md", "LICENSE", "dist/src/index.js"]) assert.ok(paths.includes(required), `packed files are missing ${required}`);
  const prohibited = [/(^|\/)test(s)?\//i, /(?<!\.d)\.ts$/, /\.specs\//, /branch-care-functional-spec\.md$/, /^\.github\//, /(^|\/)(\.env|.*credential.*|.*token.*)$/i, /\.branch-care\.json$/, /^SECURITY\.md$/, /(^|\/)undo\/.*(receipt|history\.lock)/i, /refs\/branch-care\/undo/i];
  for (const path of paths) assert.ok(!prohibited.some((pattern) => pattern.test(path)), `prohibited package path: ${path}`);
  return paths;
}
export function packInto(destination) {
  const output = runNpm(["pack", "--json", "--pack-destination", destination], { stage: "pack" });
  let records;
  try { records = JSON.parse(output); } catch { fail("pack", "npm pack returned invalid JSON"); }
  if (!Array.isArray(records) || records.length !== 1) fail("pack", "npm pack must return exactly one record");
  try { validatePackRecord(records[0]); } catch (error) { fail("inventory", error.message); }
  return resolve(destination, records[0].filename);
}
function assertManifest(manifest) {
  assert.equal(manifest.name, packageName); assert.equal(manifest.author, "bzenky"); assert.equal(manifest.version, packageVersion);
  assert.equal(manifest.private, undefined); assert.deepEqual(manifest.publishConfig, { access: "public" }); assert.equal(manifest.license, "MIT"); assert.equal(manifest.engines?.node, ">=22");
  assert.equal(manifest.bin?.["branch-care"], "./dist/src/index.js");
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["@inquirer/prompts", "commander"]);
}
function executableAt(root) { return resolve(root, "node_modules", ".bin", process.platform === "win32" ? "branch-care.cmd" : "branch-care"); }
function runBinary(executable, args, cwd, stage) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer, shell: process.platform === "win32", windowsHide: true });
  if (result.error) fail(stage, result.error.message);
  if (result.status !== 0 || result.stderr !== "") fail(stage, (result.stderr || `binary exited ${result.status}`).trim());
  return result.stdout;
}
function checkCli(executable, cwd, stage, includeUndo = false) {
  assert.equal(runBinary(executable, ["--version"], cwd, stage).trim(), packageVersion, `${stage}: wrong version`);
  const help = runBinary(executable, [], cwd, stage); assert.match(help, /Usage: branch-care/); assert.match(help, /status \[options\]/); assert.match(help, /clean \[options\]/);
  if (includeUndo) { const undo = runBinary(executable, ["undo", "--help"], cwd, stage); assert.match(undo, /--list/); assert.match(undo, /--discard <operation-id>/); }
}
function parseSidecar(contents) {
  const match = contents.match(/^([0-9a-f]{64})  ([^\r\n]+)\n$/);
  if (!match || match[2] !== tarballName) fail("sidecar", `expected '<sha256>  ${tarballName}'`);
  return match[1];
}

export function verifyCanonical({ artifact, checksum, hooks = {} } = {}) {
  if (!artifact || !checksum) fail("input", "--artifact and --checksum are required");
  const sourceTarball = resolve(artifact); const sourceSidecar = resolve(checksum);
  if (basename(sourceTarball) !== tarballName || basename(sourceSidecar) !== sidecarName) fail("input", "canonical artifact filenames are required");
  regularLstat(sourceTarball, "input"); regularLstat(sourceSidecar, "input");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "branch-care-verify-"));
  try {
    const snapshot = resolve(temporaryRoot, "snapshot"); mkdirSync(snapshot, { mode: 0o700 });
    const tarball = resolve(snapshot, tarballName); const sidecar = resolve(snapshot, sidecarName);
    const copiedHash = copyRegularSnapshot(sourceTarball, tarball, "artifact snapshot", hooks);
    copyRegularSnapshot(sourceSidecar, sidecar, "sidecar snapshot", hooks);
    chmodSync(tarball, 0o400); chmodSync(sidecar, 0o400);
    hooks.afterSnapshot?.({ sourceTarball, sourceSidecar, tarball, sidecar });
    const expectedHash = parseSidecar(readFileSync(sidecar, "utf8"));
    const snapshotHash = hashFile(tarball);
    if (copiedHash !== snapshotHash || expectedHash !== snapshotHash) fail("sidecar", `checksum mismatch: expected ${expectedHash}, received ${snapshotHash}`);

    const npmState = isolatedNpmEnvironment(temporaryRoot, "npm-cache");
    const npmOptions = (stage, cwd) => ({ stage, cwd, env: npmState.env, observe: hooks.onNpmRun });
    const inspect = resolve(temporaryRoot, "inspect"); mkdirSync(inspect);
    const [record] = JSON.parse(runNpm(["pack", "--json", "--dry-run", tarball], npmOptions("inventory", inspect)));
    try { validatePackRecord(record); } catch (error) { fail("inventory", error.message); }
    const consumer = resolve(temporaryRoot, "consumer"); mkdirSync(consumer);
    writeFileSync(resolve(consumer, "package.json"), '{"name":"branch-care-consumer","private":true}\n', { flag: "wx", mode: 0o600 });
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], npmOptions("local install", consumer));
    assertManifest(JSON.parse(readFileSync(resolve(consumer, "node_modules/@bzenky/branch-care/package.json"), "utf8")));
    hooks.afterLocalInstall?.({ consumer, executable: executableAt(consumer), tarball, temporaryRoot });
    checkCli(executableAt(consumer), consumer, "installed binary", true);

    const prefix = resolve(temporaryRoot, "global-prefix"); mkdirSync(prefix);
    const originalPrefix = runNpm(["config", "get", "prefix"], npmOptions("global prefix", npmState.home)).trim();
    hooks.beforeGlobalInstall?.({ prefix, cache: npmState.cache, originalPrefix, temporaryRoot });
    runNpm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, "--cache", npmState.cache, tarball], npmOptions("global install", prefix));
    const globalBin = process.platform === "win32" ? resolve(prefix, "branch-care.cmd") : resolve(prefix, "bin", "branch-care");
    assert.ok(existsSync(globalBin), `global install: missing isolated shim ${globalBin}`);
    checkCli(globalBin, prefix, "global binary");
    assert.equal(runNpm(["config", "get", "prefix"], npmOptions("global prefix", npmState.home)).trim(), originalPrefix, "global prefix changed");
    hooks.afterGlobalInstall?.({ prefix, cache: npmState.cache, globalBin, originalPrefix, temporaryRoot });

    const execCwd = resolve(temporaryRoot, "exec"); mkdirSync(execCwd);
    for (const args of [["--version"], ["--help"]]) {
      const output = runNpm(["exec", "--yes", `--package=${tarball}`, "--", "branch-care", ...args], npmOptions("npm exec", execCwd));
      if (args[0] === "--version") assert.equal(output.trim(), packageVersion); else assert.match(output, /Usage: branch-care/);
    }
    hooks.afterVerification?.({ tarball, sidecar, temporaryRoot, npmState, prefix, globalBin });
    return { hash: snapshotHash, paths: approvedPaths };
  } finally { rmSync(temporaryRoot, cleanupOptions); }
}

function createExclusiveCopy(source, destination) {
  const hash = copyRegularSnapshot(source, destination, "output artifact");
  return fingerprint(regularLstat(destination, "output artifact"), hash);
}
function createExclusiveSidecar(destination, contents) {
  writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
  return identityAt(destination);
}
function assertPublishedUnchanged(path, expected, stage) {
  const current = fingerprint(regularLstat(path, stage), hashFile(path));
  if (!sameFingerprint(current, expected)) fail(stage, `published file changed before completion: ${path}`);
}

export function createCanonical({ output, hooks = {} } = {}) {
  if (!output) fail("output", "--output is required");
  const destination = resolve(output);
  const directoryIdentity = directoryLstat(destination, "output");
  if (readdirSync(destination).length !== 0) fail("output", `directory must be empty: ${destination}`);
  if (!sameIdentity(directoryIdentity, directoryLstat(destination, "output"))) fail("output", "directory changed during validation");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "branch-care-create-"));
  const artifact = resolve(destination, tarballName); const checksum = resolve(destination, sidecarName);
  try {
    const first = resolve(temporaryRoot, "first"); const second = resolve(temporaryRoot, "second"); mkdirSync(first); mkdirSync(second);
    const firstTarball = packInto(first); const secondTarball = packInto(second);
    const firstHash = hashFile(firstTarball); const secondHash = hashFile(secondTarball);
    if (!readFileSync(firstTarball).equals(readFileSync(secondTarball)) || firstHash !== secondHash) fail("repeat pack", `packed bytes differ (${firstHash} != ${secondHash})`);
    const stagedSidecar = resolve(first, sidecarName);
    writeFileSync(stagedSidecar, `${firstHash}  ${tarballName}\n`, { flag: "wx", mode: 0o600 });
    verifyCanonical({ artifact: firstTarball, checksum: stagedSidecar, hooks });

    hooks.beforeOutputCreate?.({ destination, artifact, checksum });
    if (!sameIdentity(directoryIdentity, directoryLstat(destination, "output"))) fail("output", "directory changed before artifact creation");
    const publishedArtifact = createExclusiveCopy(firstTarball, artifact);
    hooks.afterArtifactCreate?.({ artifact, checksum });
    if (!sameIdentity(directoryIdentity, directoryLstat(destination, "output"))) fail("output", "directory changed after artifact creation");
    const publishedChecksum = createExclusiveSidecar(checksum, `${firstHash}  ${tarballName}\n`);
    if (!sameIdentity(directoryIdentity, directoryLstat(destination, "output"))) fail("output", "directory changed after checksum creation");
    assertPublishedUnchanged(artifact, publishedArtifact, "output artifact");
    assertPublishedUnchanged(checksum, publishedChecksum, "output checksum");
    return { artifact, checksum, hash: firstHash, paths: approvedPaths };
  } finally { rmSync(temporaryRoot, cleanupOptions); }
}
