import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import {
  nativeConfigurationFileSystem,
  writeRepositoryConfiguration,
  type EffectiveRepositoryConfiguration
} from "../src/config.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { assertExit, branch, commit, git, makeDirectory, makeRepo, refs, runCli } from "./helpers.js";

function configPath(root: string): string { return resolve(root, ".branch-care.json"); }
function writeConfig(root: string, value: unknown): void { writeFileSync(configPath(root), `${JSON.stringify(value, null, 2)}\n`); }
function parseOutput(output: string): EffectiveRepositoryConfiguration { return JSON.parse(output) as EffectiveRepositoryConfiguration; }

function configuredCandidatesFixture() {
  const fixture = makeRepo();
  branch(fixture.dir, "alpha");
  branch(fixture.dir, "beta");
  branch(fixture.dir, "team/kept");
  writeConfig(fixture.dir, { protectedBranches: ["team/*", "beta"] });
  return fixture;
}

test("nested invocation loads repository-root configuration", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const nested = resolve(fixture.dir, "one", "two"); mkdirSync(nested, { recursive: true });
  writeConfig(fixture.dir, { baseBranch: "main", staleAfterDays: 7, protectedBranches: ["team/*"] });
  writeConfig(resolve(fixture.dir, "one"), { baseBranch: "missing" });
  const result = runCli(nested, ["config"]); assertExit(result, 0);
  assert.deepEqual(parseOutput(result.stdout), {
    baseBranch: "main", staleAfterDays: 7,
    protectedBranches: ["main", "master", "develop", "staging", "production", "release/*", "team/*"]
  });
});

test("status applies all repository configuration fields", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  git(fixture.dir, "checkout", "-q", "-b", "old-topic");
  commit(fixture.dir, "old.txt", "old", "old", "2020-01-01T00:00:00Z");
  git(fixture.dir, "checkout", "-q", "main");
  branch(fixture.dir, "develop");
  writeConfig(fixture.dir, { baseBranch: "develop", staleAfterDays: 1, protectedBranches: ["old-*"] });
  const result = runCli(fixture.dir, ["status"]); assertExit(result, 0);
  assert.match(result.stdout, /Base branch: develop/);
  assert.match(result.stdout, /Stale branches\nold-topic/);
  assert.match(result.stdout, /Protected branches[\s\S]*old-topic/);
});

test("cleanup commands share configured candidates", async (t) => {
  const fixture = configuredCandidatesFixture(); t.after(fixture.cleanup);
  const dry = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(dry, 0);
  assert.match(dry.stdout, /Would delete:\nalpha\n/);
  assert.doesNotMatch(dry.stdout, /Would delete:[\s\S]*(beta|team\/kept)/);
  let choices: string[] = [];
  const code = await runClean({
    repository: new Repository(new GitClient(fixture.dir)), dryRun: false, interactive: true,
    prompts: { select: async (options) => { choices = options.map(({ value }) => value); return []; }, confirm: async () => false },
    output: { out: () => {}, err: () => {} }
  });
  assert.equal(code, 0);
  assert.deepEqual(choices, ["alpha"]);
});

test("CLI base overrides repository base", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "develop");
  writeConfig(fixture.dir, { baseBranch: "develop" });
  const result = runCli(fixture.dir, ["status", "--base", "main"]); assertExit(result, 0);
  assert.match(result.stdout, /Base branch: main/);
});

test("cleanup revalidation reloads changed configuration", async (t) => {
  for (const mode of ["protected", "base"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup);
    if (mode === "protected") branch(fixture.dir, "alpha");
    else {
      branch(fixture.dir, "other-base");
      git(fixture.dir, "checkout", "-q", "-b", "alpha");
      commit(fixture.dir, "alpha.txt", "alpha", "alpha");
      git(fixture.dir, "checkout", "-q", "main");
      git(fixture.dir, "merge", "--ff-only", "alpha");
    }
    const before = refs(fixture.dir);
    const errors: string[] = [];
    const code = await runClean({
      repository: new Repository(new GitClient(fixture.dir)), dryRun: false, interactive: true,
      prompts: {
        select: async () => ["alpha"],
        confirm: async () => { writeConfig(fixture.dir, mode === "protected" ? { protectedBranches: ["alpha"] } : { baseBranch: "other-base" }); return true; }
      },
      output: { out: () => {}, err: (line) => errors.push(line) }
    });
    assert.equal(code, 1);
    assert.equal(refs(fixture.dir), before);
    assert.match(errors.join("\n"), mode === "protected" ? /is protected/ : /no longer merged/);
  }
});

test("malformed JSON fails without mutation", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "alpha");
  writeFileSync(configPath(fixture.dir), "{ nope"); const before = refs(fixture.dir);
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(result, 1);
  assert.ok(result.stderr.includes(basename(fixture.dir)), result.stderr);
  assert.ok(result.stderr.includes(".branch-care.json"), result.stderr);
  assert.match(result.stderr, /JSON|position|property name/i);
  assert.equal(refs(fixture.dir), before);
});

test("missing bases identify configuration and CLI sources", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const before = refs(fixture.dir);
  writeConfig(fixture.dir, { baseBranch: "configured-missing" });
  const configured = runCli(fixture.dir, ["status"]); assertExit(configured, 1);
  assert.match(configured.stderr, /configured-missing.*repository configuration/i);
  writeConfig(fixture.dir, { baseBranch: "main" });
  const cli = runCli(fixture.dir, ["status", "--base", "cli-missing"]); assertExit(cli, 1);
  assert.match(cli.stderr, /cli-missing.*CLI/i);
  assert.equal(refs(fixture.dir), before);
});

test("invalid configuration blocks every command", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "alpha");
  const bytes = "{\n  \"staleAfterDays\": 0\n}\n"; writeFileSync(configPath(fixture.dir), bytes); const before = refs(fixture.dir);
  for (const args of [["status"], ["clean", "--dry-run"], ["clean"], ["config"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 1); assert.match(result.stderr, /staleAfterDays/);
  }
  assert.equal(refs(fixture.dir), before);
  assert.equal(readFileSync(configPath(fixture.dir), "utf8"), bytes);
});

test("config prints canonical default JSON", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["config"]); assertExit(result, 0);
  assert.deepEqual(Object.keys(parseOutput(result.stdout)), ["baseBranch", "staleAfterDays", "protectedBranches"]);
  assert.deepEqual(parseOutput(result.stdout), {
    baseBranch: null, staleAfterDays: 60,
    protectedBranches: ["main", "master", "develop", "staging", "production", "release/*"]
  });
});

test("config inspection leaves automatic base null", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  git(fixture.dir, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
  git(fixture.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const result = runCli(fixture.dir, ["config"]); assertExit(result, 0);
  assert.equal(parseOutput(result.stdout).baseBranch, null);
});

test("config base writes complete root file atomically", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const nested = resolve(fixture.dir, "nested"); mkdirSync(nested);
  const result = runCli(nested, ["config", "--base", "main"]); assertExit(result, 0);
  assert.equal(readFileSync(configPath(fixture.dir), "utf8"), result.stdout);
  assert.equal(existsSync(resolve(nested, ".branch-care.json")), false);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout) as object), ["baseBranch", "staleAfterDays", "protectedBranches"]);

  const operations: Array<{ operation: string; from: string; to?: string }> = [];
  const configuration = parseOutput(result.stdout);
  writeRepositoryConfiguration(fixture.dir, configuration, {
    writeFile: (path, contents) => {
      operations.push({ operation: "write", from: path });
      nativeConfigurationFileSystem.writeFile(path, contents);
    },
    rename: (from, to) => {
      operations.push({ operation: "rename", from, to });
      nativeConfigurationFileSystem.rename(from, to);
    },
    unlink: (path) => {
      operations.push({ operation: "unlink", from: path });
      nativeConfigurationFileSystem.unlink(path);
    }
  });
  assert.equal(operations.length, 2);
  const [write, rename] = operations;
  assert.equal(write?.operation, "write");
  assert.ok(write?.from.startsWith(`${configPath(fixture.dir)}.tmp-`), write?.from);
  assert.notEqual(write?.from, configPath(fixture.dir));
  assert.deepEqual(rename, { operation: "rename", from: write?.from, to: configPath(fixture.dir) });
  assert.equal(operations.some(({ operation, from }) => operation === "unlink" || from === configPath(fixture.dir)), false);
});

test("config base preserves stale and protected settings", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "develop");
  writeConfig(fixture.dir, { baseBranch: "main", staleAfterDays: 9, protectedBranches: ["z/*", "a"] });
  const result = runCli(fixture.dir, ["config", "--base", "develop"]); assertExit(result, 0);
  assert.deepEqual(parseOutput(result.stdout), {
    baseBranch: "develop", staleAfterDays: 9,
    protectedBranches: ["main", "master", "develop", "staging", "production", "release/*", "a", "z/*"]
  });
});

test("config base output equals stored canonical JSON", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["config", "--base", "main"]); assertExit(result, 0);
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout, readFileSync(configPath(fixture.dir), "utf8"));
});

test("config missing base preserves existing bytes", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const bytes = "{ \"staleAfterDays\": 12 }\n"; writeFileSync(configPath(fixture.dir), bytes);
  const result = runCli(fixture.dir, ["config", "--base", "missing"]); assertExit(result, 1);
  assert.match(result.stderr, /missing/);
  assert.equal(readFileSync(configPath(fixture.dir), "utf8"), bytes);
});

test("config rejects a non-repository", (t) => {
  const fixture = makeDirectory(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["config"]); assertExit(result, 1);
  assert.match(result.stderr, /Not a Git repository/);
  assert.equal(existsSync(configPath(fixture.dir)), false);
});

test("config usage errors exit two without a file", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const args of [["config", "--unknown"], ["config", "--base"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2); assert.match(result.stderr, /Usage:/i);
  }
  assert.equal(existsSync(configPath(fixture.dir)), false);
});

test("configuration replacement leaves no temporary file", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const configuration: EffectiveRepositoryConfiguration = {
    baseBranch: "main", staleAfterDays: 60,
    protectedBranches: ["main", "master", "develop", "staging", "production", "release/*"]
  };
  writeRepositoryConfiguration(fixture.dir, configuration);
  assert.deepEqual(readdirSync(fixture.dir).filter((name) => name.startsWith(".branch-care.json.tmp-")), []);
  assert.throws(() => writeRepositoryConfiguration(fixture.dir, configuration, {
    ...nativeConfigurationFileSystem,
    rename: () => { throw new Error("injected replacement failure"); }
  }), /injected replacement failure/);
  assert.deepEqual(readdirSync(fixture.dir).filter((name) => name.startsWith(".branch-care.json.tmp-")), []);
});
