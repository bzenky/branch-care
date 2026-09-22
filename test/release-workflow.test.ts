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
  assert.ok(packaging.includes("name: bzenky-branch-care-0.1.0-${{ github.sha }}"));
  assert.equal((packaging.match(/release-artifact\/bzenky-branch-care-0\.1\.0\.tgz(?:\.sha256)?$/gm) ?? []).length, 2);
  assert.ok(packaging.includes("if-no-files-found: error"));
  assert.ok(packaging.includes("retention-days: 7"));
  assert.equal((source.match(/actions\/upload-artifact@/g) ?? []).length, 1);
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
