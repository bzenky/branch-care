import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { assertExit, packageJson, projectRoot, runCli } from "./helpers.js";

function projectFile(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8").replaceAll("\r\n", "\n");
}

test("CI runs the full Node 22 gate on exactly three operating systems", () => {
  const workflow = projectFile(".github/workflows/ci.yml");
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) assert.equal((workflow.match(new RegExp(os, "g")) ?? []).length, 1);
  for (const text of ["fail-fast: false", "node-version: 22", "cache: npm", "run: npm ci", "run: npm test", "run: npm run package:smoke"]) {
    assert.ok(workflow.includes(text), `workflow must include ${text}`);
  }
});

test("cross-platform harness has no Unix command dependency", () => {
  const files = ["test/helpers.ts", "test/pty-driver.mjs", "test/prune.integration.test.ts", "test/remote.integration.test.ts", "test/remote-clean.integration.test.ts"];
  const source = files.map(projectFile).join("\n");
  for (const forbidden of ['execFileSync("which"', 'execFileSync("where"', 'spawn("script"', 'spawn("expect"', '"/dev/null"', '`#!${process.execPath}', 'PATH: `${bin.dir}:']) {
    assert.equal(source.includes(forbidden), false, `portable harness must exclude ${forbidden}`);
  }
});

test("root help exposes undo while root menu remains unchanged", () => {
  const source = projectFile("src/index.ts"); const help = projectFile("dist/src/index.js");
  const commands = [...help.matchAll(/\.command\(\"([^\"]+)\"/g)].map((match) => match[1]);
  assert.deepEqual(commands, ["status", "remote", "prune", "config", "clean", "undo"]);
  assert.match(source, /menuChoices[\s\S]*Show local status[\s\S]*Exit/); assert.doesNotMatch(source.slice(source.indexOf("menuChoices"), source.indexOf("export interface MenuOptions")), /undo/i);
  const result = runCli(projectRoot, ["--help"]); assertExit(result, 0); assert.equal(result.stderr, "");
  assert.match(result.stdout, /undo \[options\] \[operation-id\]/); assert.match(result.stdout, /help \[command\]/);
});

test("generated help documents every public grammar and mutation gate", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["root", ["--help"], ["--base <branch>", "status [options]", "remote [options]", "prune [options]", "config [options]", "clean [options]", "undo [options] [operation-id]", "help [command]"]],
    ["status", ["status", "--help"], ["--base <branch>", "--json"]],
    ["remote", ["remote", "--help"], ["--base <branch>", "locally known remote branches"]],
    ["config", ["config", "--help"], ["--base <branch>", ".branch-care.json", "baseBranch", "staleAfterDays", "protectedBranches"]],
    ["prune", ["prune", "--help"], ["--remote <name>", "--dry-run", "interactive stdin and stdout", "default-No", "Dry-run is non-interactive", "contact only the selected remote", "never deletes server branches"]],
    ["clean", ["clean", "--help"], ["--base <branch>", "--dry-run", "--remote [name]", "--older-than <duration>", "interactive stdin and stdout", "default-No", "--dry-run is non-interactive", "Local cleanup performs no network access", "selected server", "exact name"]],
    ["undo", ["undo", "--help"], ["[operation-id]", "--list", "--discard <operation-id>", "interactive stdin and stdout", "default-No", "no dry-run option", "--list is read-only and non-interactive", "pinned server", "exact remote name"]]
  ];
  for (const [name, args, expected] of cases) {
    const result = runCli(projectRoot, args); assertExit(result, 0); assert.equal(result.stderr, "", name);
    for (const text of expected) assert.ok(result.stdout.includes(text), `${name} help must include ${text}`);
    if (name === "undo") assert.doesNotMatch(result.stdout, /^\s+--dry-run\b/m);
  }
});

test("README has one consistent current scope and CLI result contract", () => {
  const readme = projectFile("README.md");
  for (const text of ["seven-choice one-shot root menu", "complete cleanup recovery workflow", "Successful domain output", "stdout", "stderr", "exit `1`", "exit `2`", "safe no-op"]) assert.ok(readme.includes(text), text);
  assert.doesNotMatch(readme, /Not yet implemented:[\s\S]*(dashboard|recovery)/i);
});

test("README documents cleanup reconciliation and cancellation boundaries", () => {
  const readme = projectFile("README.md");
  for (const text of ["performs no remote access", "only applicable recovery for the selected remote against its pinned endpoint", "never reconciles or mutates recovery state", "Active-prompt cancellation is an exit-`0` safe no-op"]) assert.ok(readme.includes(text), text);
});

test("help and README document the complete interactive root menu contract", () => {
  const readme = projectFile("README.md");
  const help = readFileSync(resolve(projectRoot, "dist/src/index.js"), "utf8");
  for (const text of [
    "branch-care --base develop", "Show local status", "Clean local branches", "Show remote status",
    "Prune remote-tracking references", "Clean remote branches", "Show repository configuration", "Exit",
    "one-shot", "Select a remote:", "No action was run.", "stdin or stdout", "explicit subcommands"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
  assert.match(help, /opens a one-shot menu in an interactive terminal; otherwise prints this help/);
});

test("README documents the public repository Actions artifact boundary", () => {
  const readme = projectFile("README.md");
  for (const text of ["manually dispatch", "repository is public", "GitHub Actions access controls", "retained for 7 days", "bzenky-branch-care-0.1.0-<full-commit-sha>", "not an npm publication", "GitHub Release asset", "deployment", "secret storage"]) assert.ok(readme.includes(text), text);
  assert.equal(readme.includes("private repository's GitHub Actions permissions"), false);
  assert.equal(readme.includes("non-public artifact"), false);
});

test("README release artifact commands match verified consumer paths", () => {
  const readme = projectFile("README.md");
  for (const text of ["Node.js 22", "SHA-256 mismatch", "npm install --global --ignore-scripts --prefix ./branch-care-review ./bzenky-branch-care-0.1.0.tgz", "branch-care --version", "branch-care --help", "npm exec --yes --package=/absolute/path/to/bzenky-branch-care-0.1.0.tgz -- branch-care --version", "npm install -g @bzenky/branch-care", "unavailable and unsupported before V1"]) assert.ok(readme.includes(text), text);
});

test("registry name evidence is dated scoped and non-authoritative", () => {
  const readme = projectFile("README.md");
  for (const text of ["@bzenky/branch-care", "2026-09-22", "unauthenticated", "E404", "informational evidence only", "does not establish ownership", "reserve the name", "guarantee continued availability", "gate this non-publishing workflow"]) assert.ok(readme.includes(text), text);
});

test("license and security boundaries remain release-ready", () => {
  const manifest = packageJson();
  const inventory = JSON.parse(projectFile("scripts/package-files.json")) as string[];
  const security = projectFile("SECURITY.md");
  assert.equal(manifest.license, "MIT");
  assert.ok(inventory.includes("LICENSE"));
  assert.equal(inventory.includes("SECURITY.md"), false);
  for (const text of ["private vulnerability reporting", "Do not include credentials, access tokens, or private repository contents."]) assert.ok(security.includes(text), text);
});

test("README documents three-platform CI support", () => {
  const readme = projectFile("README.md");
  for (const text of ["Node.js 22", "Windows", "Ubuntu/Linux", "macOS", "not been published to npm"]) assert.ok(readme.includes(text));
});

test("README documents the configuration contract", () => {
  const readme = projectFile("README.md");
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
  const readme = projectFile("README.md");
  for (const text of [
    "branch-care remote", "refs/remotes/", "origin/HEAD", "concrete remote-tracking refs", "merged into the resolved local base branch",
    "missing-upstream section", "upstream state is `gone`", "no `fetch`", "fetch --prune", "`prune`", "remote deletion",
    "server", "later explicit fetch or prune operation", "status --json"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
});

test("README documents prune contracts", () => {
  const readme = projectFile("README.md");
  for (const text of [
    "branch-care prune --dry-run", "branch-care prune --remote origin", "exactly one remote", "sole configured remote",
    "default is No", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "create or refresh remote-tracking refs",
    "does not delete branches from the server"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
  assert.match(readme, /The preview is advisory rather than a frozen server snapshot: server state can change between preview and confirmed execution\./);
});

test("cleanup age filter documentation is complete", () => {
  const readme = projectFile("README.md");
  for (const text of [
    "--older-than <duration>", "positive whole days", "lowercase `d`", "inclusive", "complete days",
    "local and remote cleanup", "unchanged", "only narrows", "already safe"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
});

test("README documents remote deletion contracts", () => {
  const readme = projectFile("README.md");
  for (const text of [
    "branch-care clean --remote origin --dry-run", "branch-care clean --remote origin", "one remote", "merged into the resolved local base",
    "live server tip", "initially unchecked", "Delete 2 branches from 'origin'?", "Type 'origin' to confirm remote deletion:",
    "final revalidation", "--force-with-lease=refs/heads/<branch>:<expected-oid>", "--atomic", "no non-atomic fallback",
    "Multiple configured push URLs are refused", "does not delete local branches", "redacts configured remote URLs", "branch-care prune --remote <name>"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
});

test("undo help and README document the complete recovery contract", () => {
  const readme = projectFile("README.md"); const help = readFileSync(resolve(projectRoot, "dist/src/index.js"), "utf8");
  for (const text of ["branch-care undo", "branch-care undo <operation-id>", "branch-care undo --list", "branch-care undo --discard <operation-id>", "default is No", "exact remote name", "10", "no expiration", "no automatic eviction", "partial", "retry", "atomic", "absence", "common Git directory", "refs/branch-care/undo", "garbage collection", "working tree", "index", "tags", "pull requests", "CI", "hosting metadata", "automation"]) assert.ok(readme.includes(text), `README must include ${text}`);
  for (const text of ["newest", "default-No", "atomic absence-leased", "10 operations", "without expiration", "common Git directory", "retryable"]) assert.ok(help.includes(text), `undo help must include ${text}`);
});

test("README documents JSON and upstream contracts", () => {
  const readme = projectFile("README.md");
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
