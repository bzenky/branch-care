import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { findExecutable, projectRoot } from "./helpers.js";

const npmCli = findExecutable("npm");
const harness = resolve(projectRoot, "test/release-adversarial-harness.mjs");
const tarball = "bzenky-branch-care-0.1.0.tgz";
const sidecar = `${tarball}.sha256`;
const cleanup = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
function realNpmCliPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const root = spawnSync(npmCli, ["root", "--global"], { encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(root.status, 0, root.stderr);
  return resolve(root.stdout.trim(), "npm/bin/npm-cli.js");
}

function npm(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(npmCli, args, { cwd: projectRoot, env, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024, shell: process.platform === "win32" });
}
function harnessRun(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [harness, ...args], { cwd: projectRoot, env: { ...process.env, npm_execpath: realNpmCliPath(), ...env }, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
}
function hash(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function writeChecksum(directory: string) { writeFileSync(resolve(directory, sidecar), `${hash(resolve(directory, tarball))}  ${tarball}\n`); }
function createCanonical(directory: string) {
  const result = npm(["run", "release:package", "--", "--output", directory]);
  assert.equal(result.status, 0, result.stderr);
}
function assertRejected(result: ReturnType<typeof spawnSync>, pattern: RegExp) {
  assert.notEqual(result.status, 0); assert.match(String(result.stderr), pattern); assert.doesNotMatch(String(result.stdout), /accepted canonical artifact/);
}

test("release package failure table rejects every unverified artifact", () => {
  const root = mkdtempSync(resolve(tmpdir(), "branch-care-failure-table-"));
  try {
    const missing = resolve(root, "missing");
    assertRejected(npm(["run", "release:package", "--", "--output", missing]), /ENOENT|does not exist/);
    const nonempty = resolve(root, "nonempty"); mkdirSync(nonempty); writeFileSync(resolve(nonempty, "sentinel"), "safe");
    assertRejected(npm(["run", "release:package", "--", "--output", nonempty]), /must be empty/);

    const canonical = resolve(root, "canonical"); mkdirSync(canonical); createCanonical(canonical);
    const artifact = resolve(canonical, tarball); const checksum = resolve(canonical, sidecar);

    const malformed = resolve(root, "malformed"); mkdirSync(malformed); copyFileSync(artifact, resolve(malformed, tarball)); writeFileSync(resolve(malformed, sidecar), "not a checksum\n");
    assertRejected(harnessRun(["verify", "none", resolve(malformed, tarball), resolve(malformed, sidecar)]), /sidecar: expected/);

    const mismatch = resolve(root, "mismatch"); mkdirSync(mismatch); copyFileSync(artifact, resolve(mismatch, tarball)); writeFileSync(resolve(mismatch, sidecar), `${"0".repeat(64)}  ${tarball}\n`);
    assertRejected(harnessRun(["verify", "none", resolve(mismatch, tarball), resolve(mismatch, sidecar)]), /checksum mismatch/);

    const corrupt = resolve(root, "corrupt"); mkdirSync(corrupt); writeFileSync(resolve(corrupt, tarball), "not a tarball"); writeChecksum(corrupt);
    assertRejected(harnessRun(["verify", "none", resolve(corrupt, tarball), resolve(corrupt, sidecar)]), /inventory:/);

    const race = resolve(root, "copy-race"); mkdirSync(race); copyFileSync(artifact, resolve(race, tarball)); copyFileSync(checksum, resolve(race, sidecar));
    assertRejected(harnessRun(["verify", "replace-during-copy", resolve(race, tarball), resolve(race, sidecar)]), /changed while it was copied/);
    assertRejected(harnessRun(["verify", "binary-failure", artifact, checksum]), /installed binary/);

    const wrapper = resolve(root, "npm-wrapper.cjs");
    writeFileSync(wrapper, `const {spawnSync}=require('node:child_process');const a=process.argv.slice(2),s=process.env.FAIL_NPM_STAGE;const local=a[0]==='install'&&!a.includes('--global'),global=a[0]==='install'&&a.includes('--global'),exec=a[0]==='exec';if((s==='local install'&&local)||(s==='global install'&&global)||(s==='npm exec'&&exec)){console.error('forced '+s+' process failure');process.exit(71)}const r=spawnSync(process.execPath,[process.env.REAL_NPM_CLI,...a],{stdio:'inherit',env:process.env});process.exit(r.status??72);\n`);
    const realNpmCli = realNpmCliPath();
    assert.equal(resolve(realNpmCli), realNpmCli);
    for (const stage of ["local install", "global install", "npm exec"]) {
      const result = harnessRun(["verify", "none", artifact, checksum], { ...process.env, npm_execpath: wrapper, REAL_NPM_CLI: realNpmCli, FAIL_NPM_STAGE: stage });
      assertRejected(result, new RegExp(`${stage}:.*forced ${stage} process failure`, "s"));
    }

    for (const mode of ["artifact-collision", "artifact-symlink", "replace-owned-artifact"]) {
      const output = resolve(root, mode); mkdirSync(output);
      const result = harnessRun(["create", mode, output], { ...process.env, npm_execpath: realNpmCli });
      assertRejected(result, /EEXIST|symbolic|checksum mismatch|source changed|regular file/);
      assert.ok(existsSync(resolve(output, tarball)) || lstatSync(resolve(output, tarball)).isSymbolicLink(), `${mode} must preserve the competing path`);
      if (mode === "artifact-symlink") assert.equal(lstatSync(resolve(output, tarball)).isSymbolicLink(), true);
      else assert.match(readFileSync(resolve(output, tarball), "utf8"), /intruder|replacement/);
      assert.equal(existsSync(resolve(output, sidecar)), false, `${mode} must clean only its owned sidecar`);
    }
  } finally { rmSync(root, cleanup); }
});

test("release verification rejects symlinks and detects snapshot races", () => {
  const root = mkdtempSync(resolve(tmpdir(), "branch-care-symlink-race-"));
  try {
    const canonical = resolve(root, "canonical"); mkdirSync(canonical); createCanonical(canonical);
    const artifact = resolve(canonical, tarball); const checksum = resolve(canonical, sidecar);
    const links = resolve(root, "links"); mkdirSync(links);
    symlinkSync(artifact, resolve(links, tarball)); symlinkSync(checksum, resolve(links, sidecar));
    assertRejected(harnessRun(["verify", "none", resolve(links, tarball), checksum]), /symbolic links are not allowed/);
    assertRejected(harnessRun(["verify", "none", artifact, resolve(links, sidecar)]), /symbolic links are not allowed/);
    const accepted = harnessRun(["verify", "replace-after-snapshot", artifact, checksum]);
    assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /accepted canonical artifact/);
  } finally { rmSync(root, cleanup); }
});

test("canonical output rejects directory symlinks and replacement races", () => {
  const root = mkdtempSync(resolve(tmpdir(), "branch-care-output-race-"));
  try {
    const real = resolve(root, "real"); mkdirSync(real); const link = resolve(root, "link"); symlinkSync(real, link, "dir");
    assertRejected(npm(["run", "release:package", "--", "--output", link]), /symbolic links are not allowed/);
    const raced = resolve(root, "raced"); mkdirSync(raced);
    const result = harnessRun(["create", "output-directory-race", raced], { ...process.env, npm_execpath: realNpmCliPath() });
    assertRejected(result, /directory changed/); assert.deepEqual(readdirSync(raced), []);
  } finally { rmSync(root, cleanup); }
});

test("release package commands share one non-publishing implementation", () => {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["release:package"], "node scripts/release-create.mjs"); assert.equal(manifest.scripts["release:verify"], "node scripts/release-verify.mjs");
  for (const entry of ["scripts/release-create.mjs", "scripts/release-verify.mjs"]) assert.match(readFileSync(resolve(projectRoot, entry), "utf8"), /\.\/release-package\.mjs/);
  const implementation = readFileSync(resolve(projectRoot, "scripts/release-package.mjs"), "utf8");
  for (const forbidden of ["npm publish", "npm login", "npm token", "git tag", "gh release", "deploy"]) assert.equal(implementation.includes(forbidden), false);
  const invalid = npm(["run", "release:verify", "--", "--artifact", resolve(projectRoot, tarball), "--checksum", resolve(projectRoot, sidecar)]);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /ENOENT|does not exist/);
});
