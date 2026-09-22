import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { findExecutable, projectRoot } from "./helpers.js";

const npmCli = findExecutable("npm");
const tarball = "bzenky-branch-care-0.1.0.tgz";
const sidecar = `${tarball}.sha256`;

function run(args: string[]) {
  return spawnSync(process.execPath, args, { cwd: projectRoot, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
}

function npm(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(npmCli, args, { cwd: projectRoot, env, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024, shell: process.platform === "win32" });
}

test("release package failure table rejects every unverified artifact", () => {
  const root = mkdtempSync(resolve(tmpdir(), "branch-care-failure-table-"));
  try {
    const missing = resolve(root, "missing");
    const missingResult = npm(["run", "release:package", "--", "--output", missing]);
    assert.notEqual(missingResult.status, 0); assert.match(missingResult.stderr, /does not exist/);

    const nonempty = resolve(root, "nonempty"); mkdirSync(nonempty); writeFileSync(resolve(nonempty, "sentinel"), "safe");
    const nonemptyResult = npm(["run", "release:package", "--", "--output", nonempty]);
    assert.notEqual(nonemptyResult.status, 0); assert.match(nonemptyResult.stderr, /must be empty/);

    for (const stage of ["pack", "inventory", "repeat pack", "sidecar", "local install", "global install", "binary", "npm exec"]) {
      const output = resolve(root, stage.replaceAll(" ", "-")); mkdirSync(output);
      const result = npm(["run", "release:package", "--", "--output", output], { ...process.env, BRANCH_CARE_RELEASE_TEST_FAILURE: stage });
      assert.notEqual(result.status, 0, stage);
      assert.match(result.stderr, new RegExp(stage.replace(" ", "\\s*"), "i"), stage);
      assert.doesNotMatch(result.stdout, /accepted canonical artifact/);
      assert.deepEqual(readdirSync(output), [], `${stage} left a partial candidate`);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("release package commands share one non-publishing implementation", () => {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["release:package"], "node scripts/release-create.mjs");
  assert.equal(manifest.scripts["release:verify"], "node scripts/release-verify.mjs");
  for (const entry of ["scripts/release-create.mjs", "scripts/release-verify.mjs"]) {
    assert.match(readFileSync(resolve(projectRoot, entry), "utf8"), /\.\/release-package\.mjs/);
  }
  const implementation = readFileSync(resolve(projectRoot, "scripts/release-package.mjs"), "utf8");
  for (const forbidden of ["npm publish", "npm login", "npm token", "git tag", "gh release", "deploy"]) assert.equal(implementation.includes(forbidden), false);
  const invalid = npm(["run", "release:verify", "--", "--artifact", resolve(projectRoot, tarball), "--checksum", resolve(projectRoot, sidecar)]);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /does not exist/);
});
