import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { projectRoot } from "./helpers.js";

const workflowPath = resolve(projectRoot, ".github/workflows/release-readiness.yml");
const workflow = () => readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");

function section(source: string, start: string, end?: string) {
  const from = source.indexOf(start); assert.ok(from >= 0, start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.ok(to >= 0, end);
  return source.slice(from, to);
}

test("release workflow is manual read-only and cannot publish", () => {
  const source = workflow();
  assert.equal(section(source, "on:\n", "\npermissions:"), "on:\n  workflow_dispatch:\n");
  assert.equal(section(source, "permissions:\n", "\njobs:"), "permissions:\n  contents: read\n");
  for (const forbidden of [/^\s{2}(?:push|pull_request|schedule|release):/m, /packages: write/, /contents: write/, /id-token: write/, /actions: write/, /deployments: write/, /NODE_AUTH_TOKEN/, /NPM_TOKEN/, /^\s+environment:/m, /npm publish/, /git tag/, /gh release/, /^\s+deploy:/m]) assert.equal(forbidden.test(source), false, String(forbidden));
});

test("release workflow validates exactly three Node 22 platforms", () => {
  const source = workflow();
  const validate = section(source, "  validate:\n", "\n  package:\n");
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) assert.equal((validate.match(new RegExp(os, "g")) ?? []).length, 1, os);
  assert.equal((validate.match(/^\s+- (?:ubuntu|macos|windows)-latest$/gm) ?? []).length, 3);
  for (const required of ["fail-fast: false", "ref: ${{ github.sha }}", "node-version: 22", "run: npm ci", "run: npm test", "run: npm run package:smoke"]) assert.ok(validate.includes(required), required);
});

test("release workflow gates one canonical package on the full matrix", () => {
  const source = workflow();
  const validate = section(source, "  validate:\n", "\n  package:\n");
  const packaging = section(source, "  package:\n");
  assert.equal((source.match(/^  package:$/gm) ?? []).length, 1);
  assert.ok(packaging.includes("needs: validate"));
  assert.ok(packaging.includes("runs-on: ubuntu-latest"));
  assert.ok(packaging.includes("ref: ${{ github.sha }}"));
  assert.ok(packaging.includes("run: npm ci"));
  assert.ok(packaging.includes("npm run release:package"));
  assert.ok(packaging.includes("npm run release:verify"));
  assert.equal(validate.includes("upload-artifact"), false);
});

test("release workflow uploads exactly one verified seven-day artifact", () => {
  const source = workflow();
  const packaging = section(source, "  package:\n");
  assert.ok(packaging.indexOf("npm run release:verify") < packaging.indexOf("actions/upload-artifact@v4"));
  assert.ok(packaging.includes("name: ${{ steps.metadata.outputs.artifact-base }}-${{ github.sha }}"));
  assert.equal((packaging.match(/release-artifact\/\$\{\{ steps\.metadata\.outputs\.(?:tarball|sidecar) \}\}$/gm) ?? []).length, 2);
  assert.ok(packaging.includes("if-no-files-found: error"));
  assert.ok(packaging.includes("retention-days: 7"));
  assert.equal((source.match(/actions\/upload-artifact@/g) ?? []).length, 1);
});

test("release workflow consumes manifest-derived artifact metadata", () => {
  const source = workflow(); const packaging = section(source, "  package:\n");
  const metadata = packaging.indexOf("id: metadata"); const create = packaging.indexOf("npm run release:package"); const verify = packaging.indexOf("npm run release:verify"); const upload = packaging.indexOf("actions/upload-artifact@v4");
  assert.ok(metadata >= 0 && metadata < create && create < verify && verify < upload);
  assert.ok(packaging.includes("run: npm run release:metadata"));
  for (const output of ["steps.metadata.outputs.tarball", "steps.metadata.outputs.sidecar", "steps.metadata.outputs.artifact-base"]) assert.ok(packaging.includes(output), output);
  for (const required of ["needs: validate", "runs-on: ubuntu-latest", "ref: ${{ github.sha }}", "retention-days: 7"]) assert.ok(packaging.includes(required), required);
  assert.equal(section(source, "permissions:\n", "\njobs:"), "permissions:\n  contents: read\n");
});

test("release identity remains consistent across every public and automation surface", () => {
  const source = workflow(); const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as Record<string, any>;
  const release = readFileSync(resolve(projectRoot, "scripts/release-package.mjs"), "utf8"); const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  assert.equal(manifest.name, "@bzenky/branch-care"); assert.equal(manifest.version, "1.0.0"); assert.equal(manifest.private, undefined); assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.equal(manifest.bin["branch-care"], "./dist/src/index.js"); assert.equal(manifest.engines.node, ">=22");
  assert.match(release, /loadReleaseMetadata/); assert.match(release, /manifest\?\.name/); assert.match(release, /manifest\?\.version/);
  assert.equal(section(source, "  package:\n").includes("bzenky-branch-care-1.0.0"), false);
  for (const text of ["@bzenky/branch-care", "bzenky-branch-care-1.0.0.tgz", "branch-care --help"]) assert.ok(readme.includes(text), text);
});

test("V1 preparation retains a credential-free non-publishing automation boundary", () => {
  const source = workflow();
  assert.equal(section(source, "on:\n", "\npermissions:"), "on:\n  workflow_dispatch:\n");
  assert.equal(section(source, "permissions:\n", "\njobs:"), "permissions:\n  contents: read\n");
  for (const forbidden of [/npm publish/, /NODE_AUTH_TOKEN/, /NPM_TOKEN/, /OTP/i, /packages: write/, /id-token: write/, /git tag/, /git push/, /gh release/, /deploy/i]) assert.equal(forbidden.test(source), false, String(forbidden));
  const scripts = ["scripts/release-package.mjs", "scripts/release-create.mjs", "scripts/release-verify.mjs", "scripts/release-metadata.mjs"].map((path) => readFileSync(resolve(projectRoot, path), "utf8")).join("\n");
  for (const forbidden of ["npm publish", "npm token", "npm login", "--otp", "git tag", "gh release", "deploy"]) assert.equal(scripts.toLowerCase().includes(forbidden), false, forbidden);
});

test("V1 release procedure fails closed across every publication precondition", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  for (const text of ["package or version already exists", "authenticated npm principal is not `bzenky`", "candidate checksum differs", "authentication or two-factor confirmation cannot complete safely", "publication result is nonzero or ambiguous", "stop before creating a Git tag or GitHub Release", "never automatically retry, unpublish, overwrite, deprecate, or publish another version"]) assert.ok(readme.includes(text), text);
});

test("release workflow failure and repeat-dispatch boundaries are explicit", () => {
  const source = workflow();
  assert.ok(source.includes("needs: validate"));
  assert.equal(source.includes("if: always()"), false);
  assert.ok(source.includes("${{ github.sha }}"));
  assert.equal(source.includes("${{ github.run_id }}"), false);
  assert.equal(source.includes("continue-on-error"), false);
  for (const mutation of ["npm publish", "git push", "git tag", "gh release", "deployment"]) assert.equal(source.toLowerCase().includes(mutation), false);
});
