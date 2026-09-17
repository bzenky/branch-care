import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { projectRoot } from "./helpers.js";

test("README documents the configuration contract", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  for (const text of [
    ".branch-care.json", "baseBranch", "staleAfterDays", "protectedBranches",
    "repository root", "--base <branch>", "origin/HEAD", "additive", "zero or more",
    "including `/`", "invalid", "exit code `1`", "branch-care config", "branch-care config --base"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
  assert.ok(readme.includes([
    "1. `--base <branch>`",
    "2. Repository `baseBranch` from `.branch-care.json`",
    "3. Local branch referenced by `origin/HEAD`",
    "4. `main`",
    "5. `master`",
    "6. `develop`"
  ].join("\n")), "README must document CLI > repository > origin/HEAD > main > master > develop");
});

test("README documents remote contracts", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  for (const text of [
    "branch-care remote", "refs/remotes/", "origin/HEAD", "concrete remote-tracking refs", "merged into the resolved local base branch",
    "missing-upstream section", "upstream state is `gone`", "no `fetch`", "fetch --prune", "`prune`", "remote deletion",
    "server", "later explicit fetch or prune operation", "status --json"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
});

test("README documents prune contracts", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  for (const text of [
    "branch-care prune --dry-run", "branch-care prune --remote origin", "exactly one remote", "sole configured remote",
    "default is No", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "create or refresh remote-tracking refs",
    "does not delete branches from the server"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
  assert.match(readme, /The preview is advisory rather than a frozen server snapshot: server state can change between preview and confirmed execution\./);
});

test("README documents JSON and upstream contracts", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  const exampleMatch = readme.match(/A complete schema-version-1 document has this shape:\n\n```json\n([\s\S]*?)\n```/);
  assert.ok(exampleMatch, "README must contain one complete schema-version-1 JSON example");
  const example = JSON.parse(exampleMatch[1]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(example), ["schemaVersion", "repository", "baseBranch", "currentBranch", "detachedHead", "staleAfterDays", "branches"]);
  assert.equal(example.schemaVersion, 1);
  assert.deepEqual(Object.keys(example.baseBranch as object), ["name", "source"]);
  assert.ok(Array.isArray(example.branches) && example.branches.length > 0);
  assert.deepEqual(Object.keys(example.branches[0] as object), [
    "name", "lastCommitAt", "daysSinceLastCommit", "author", "upstream", "upstreamState",
    "isCurrent", "isMerged", "isStale", "isProtected", "isDeletionCandidate"
  ]);
  for (const text of [
    "branch-care status --json", '"schemaVersion": 1', '"repository":', '"baseBranch":', '"currentBranch":',
    '"detachedHead":', '"staleAfterDays":', '"branches":', '"lastCommitAt":', '"daysSinceLastCommit":',
    '"author":', '"upstream":', '"upstreamState":', '"isCurrent":', '"isMerged":', '"isStale":',
    '"isProtected":', '"isDeletionCandidate":', "`cli`", "`repository`", "`originHead`", "`main`", "`master`", "`develop`",
    "`none`", "`tracking`", "`gone`", "stdout", "stderr", "bytewise ascending", "no fetch", "no prune"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
});
