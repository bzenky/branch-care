import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import test from "node:test";
import { runRemoteClean, type RemoteCleanRepository } from "../src/commands/remote-clean.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { isInteractiveTerminal } from "../src/index.js";
import type { RemoteDeleteCandidate } from "../src/types.js";
import { assertExit, branch, commit, findExecutable, git, makeDirectory, makeEmptyDirectory, makeRepo, prependPath, refs, runCli, runCliInteractive, snapshotDirectory, writeNodeLauncher, type Fixture } from "./helpers.js";

interface RemoteFixture { local: Fixture; bare: Fixture; cleanup(): void }

function makeRemote(initialBranch = "main"): RemoteFixture {
  const local = makeRepo(initialBranch);
  const bare = makeEmptyDirectory("branch-care-delete-bare-");
  git(bare.dir, "init", "-q", "--bare");
  git(local.dir, "remote", "add", "origin", bare.dir);
  git(local.dir, "push", "-q", "-u", "origin", initialBranch);
  git(bare.dir, "symbolic-ref", "HEAD", `refs/heads/${initialBranch}`);
  return { local, bare, cleanup: () => { local.cleanup(); bare.cleanup(); } };
}

function pushBranch(fixture: RemoteFixture, name: string, withCommit = false): void {
  branch(fixture.local.dir, name);
  if (withCommit) {
    git(fixture.local.dir, "checkout", "-q", name);
    commit(fixture.local.dir, `${name.replaceAll("/", "-")}.txt`, `${name}\n`, name);
    git(fixture.local.dir, "checkout", "-q", "main");
  }
  git(fixture.local.dir, "push", "-q", "origin", name);
}

function serverRefs(bare: string): string {
  return git(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags");
}

function allLocalRefs(cwd: string): string {
  return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags");
}

function fetchHead(cwd: string): string | undefined {
  const path = resolvePath(cwd, ".git", "FETCH_HEAD");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function runCliWithGitAudit(cwd: string, args: string[]): { result: ReturnType<typeof runCli>; calls: string[][] } {
  const bin = makeEmptyDirectory("branch-care-delete-audit-");
  const realGit = findExecutable("git");
  const audit = resolvePath(bin.dir, "calls.jsonl");
  writeNodeLauncher(bin.dir, "git", `
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args) + "\\n");
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  try {
    const result = spawnSync(process.execPath, [resolvePath(process.cwd(), "dist/src/index.js"), ...args], {
      cwd, encoding: "utf8", env: { ...process.env, PATH: prependPath(bin.dir) }
    });
    const calls = existsSync(audit)
      ? readFileSync(audit, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
      : [];
    return { result, calls };
  } finally { bin.cleanup(); }
}

test("remote clean refusal states perform no network operation", (t) => {
  const zero = makeRepo(); t.after(zero.cleanup);
  const zeroResult = runCliWithGitAudit(zero.dir, ["clean", "--remote", "--dry-run"]);
  assertExit(zeroResult.result, 0); assert.equal(zeroResult.result.stdout, "No remotes are configured.\n");
  assert.equal(zeroResult.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);

  const unknown = makeRemote(); t.after(unknown.cleanup);
  const unknownResult = runCliWithGitAudit(unknown.local.dir, ["clean", "--remote", "missing", "--dry-run"]);
  assertExit(unknownResult.result, 1); assert.match(unknownResult.result.stderr, /Remote 'missing' is not configured/);
  assert.equal(unknownResult.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);

  git(unknown.local.dir, "remote", "add", "upstream", unknown.bare.dir);
  git(unknown.local.dir, "config", "remote.upstream.fetch", "+refs/heads/*:refs/remotes/upstream/*");
  const ambiguous = runCliWithGitAudit(unknown.local.dir, ["clean", "--remote", "--dry-run"]);
  assertExit(ambiguous.result, 1); assert.match(ambiguous.result.stderr, /Multiple remotes are configured: origin, upstream/);
  assert.equal(ambiguous.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);
});

test("remote clean rejects every unsafe mapping before network access", (t) => {
  const mappings: Array<string[]> = [
    [], ["bad"],
    ["refs/heads/*:refs/remotes/origin/*", "refs/heads/release/*:refs/remotes/origin/release/*"],
    ["refs/heads/topic:refs/remotes/origin/topic"],
    ["refs/heads/*:refs/remotes/origin/renamed/*"],
    ["refs/heads/*:refs/remotes/upstream/*"]
  ];
  for (const mappingsForCase of mappings) {
    const fixture = makeRemote(); t.after(fixture.cleanup);
    git(fixture.local.dir, "config", "--unset-all", "remote.origin.fetch");
    for (const mapping of mappingsForCase) git(fixture.local.dir, "config", "--add", "remote.origin.fetch", mapping);
    const audited = runCliWithGitAudit(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]);
    assertExit(audited.result, 1);
    assert.match(audited.result.stderr, /Unsafe (fetch configuration|remote deletion mapping)/);
    assert.equal(audited.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);
  }
});

test("remote clean resolves one push destination authority", async (t) => {
  const fallback = makeRemote(); t.after(fallback.cleanup); pushBranch(fallback, "safe");
  const fallbackAudit = runCliWithGitAudit(fallback.local.dir, ["clean", "--remote", "origin", "--dry-run"]);
  assertExit(fallbackAudit.result, 0);
  const fallbackInventory = fallbackAudit.calls.find(([command]) => command === "ls-remote");
  assert.equal(fallbackInventory?.includes("origin"), true);

  const single = makeRemote(); t.after(single.cleanup); pushBranch(single, "safe");
  git(single.local.dir, "config", "remote.origin.pushurl", single.bare.dir);
  const singleAudit = runCliWithGitAudit(single.local.dir, ["clean", "--remote", "origin", "--dry-run"]);
  assertExit(singleAudit.result, 0);
  const singleInventory = singleAudit.calls.find(([command]) => command === "ls-remote");
  assert.equal(singleInventory?.includes(single.bare.dir), true);
  assert.doesNotMatch(singleAudit.result.stdout + singleAudit.result.stderr, new RegExp(single.bare.dir.replaceAll("/", "\\/")));
  const calls: string[][] = [];
  const runner = async (cwd: string, args: readonly string[]) => { calls.push([...args]); return new GitClient(cwd).run(args); };
  const lines: string[] = [];
  const deleteCode = await runRemoteClean({
    repository: new Repository(new GitClient(single.local.dir, runner)), remote: "origin", dryRun: false, interactive: true,
    prompts: { select: async () => ["origin/safe"], confirm: async () => true, input: async () => "origin" },
    output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) }
  });
  assert.equal(deleteCode, 0, lines.join("\n"));
  const deletionPush = calls.find(([command]) => command === "push");
  assert.equal(deletionPush?.includes("origin"), true);
  assert.equal(deletionPush?.includes(single.bare.dir), false);
  assert.ok(calls.filter(([command]) => command === "ls-remote").every((args) => args.includes(single.bare.dir)));

  const multiple = makeRemote(); t.after(multiple.cleanup);
  git(multiple.local.dir, "config", "--add", "remote.origin.pushurl", multiple.bare.dir);
  git(multiple.local.dir, "config", "--add", "remote.origin.pushurl", "/second/push/destination");
  const multipleAudit = runCliWithGitAudit(multiple.local.dir, ["clean", "--remote", "origin", "--dry-run"]);
  assertExit(multipleAudit.result, 1);
  assert.match(multipleAudit.result.stderr, /Configure at most one push URL/);
  assert.equal(multipleAudit.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);
});

test("remote clean honors base precedence and rejects detached HEAD", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  branch(fixture.local.dir, "develop");
  git(fixture.local.dir, "checkout", "-q", "develop");
  commit(fixture.local.dir, "feature.txt", "feature\n", "feature");
  git(fixture.local.dir, "branch", "feature");
  git(fixture.local.dir, "push", "-q", "origin", "feature");
  git(fixture.local.dir, "checkout", "-q", "main");

  const automaticMain = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(automaticMain, 0);
  assert.equal(automaticMain.stdout, "No remote branches are safe to delete.\n");
  const command = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--base", "develop", "--dry-run"]); assertExit(command, 0);
  assert.match(command.stdout, /origin\/feature/);
  const global = runCli(fixture.local.dir, ["--base", "develop", "clean", "--remote", "origin", "--dry-run"]); assertExit(global, 0);
  assert.match(global.stdout, /origin\/feature/);
  writeFileSync(resolvePath(fixture.local.dir, ".branch-care.json"), '{"baseBranch":"develop"}\n');
  const configured = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(configured, 0);
  assert.match(configured.stdout, /origin\/feature/);

  git(fixture.local.dir, "checkout", "-q", "--detach", "HEAD");
  const detached = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(detached, 1);
  assert.equal(detached.stdout, ""); assert.match(detached.stderr, /Remote cleanup requires an attached current branch/);

  for (const base of ["master", "develop"]) {
    const fallback = makeRemote(base); t.after(fallback.cleanup); pushBranch(fallback, "safe");
    const result = runCli(fallback.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(result, 0);
    assert.match(result.stdout, /origin\/safe/, base);
  }

  const originHead = makeRemote(); t.after(originHead.cleanup);
  branch(originHead.local.dir, "trunk");
  git(originHead.local.dir, "checkout", "-q", "trunk");
  commit(originHead.local.dir, "origin-head.txt", "origin head\n", "origin head");
  git(originHead.local.dir, "branch", "feature");
  git(originHead.local.dir, "push", "-q", "origin", "trunk", "feature");
  git(originHead.local.dir, "checkout", "-q", "main");
  git(originHead.local.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  const originHeadResult = runCli(originHead.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(originHeadResult, 0);
  assert.match(originHeadResult.stdout, /origin\/feature/);
});

test("remote clean candidate table covers every safety exclusion", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  for (const name of ["safe", "current", "trunk", "release/1", "team/secret"]) pushBranch(fixture, name);
  pushBranch(fixture, "unmerged", true);
  git(fixture.bare.dir, "symbolic-ref", "HEAD", "refs/heads/trunk");
  writeFileSync(resolvePath(fixture.local.dir, ".branch-care.json"), '{"protectedBranches":["team/*"]}\n');
  git(fixture.local.dir, "checkout", "-q", "current");
  const result = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(result, 0);
  assert.match(result.stdout, /origin\/safe/);
  for (const name of ["main", "current", "trunk", "release/1", "team/secret", "unmerged"]) {
    assert.doesNotMatch(result.stdout, new RegExp(`origin/${name.replace("/", "\\/")}(?:\\n|$)`));
  }
});

test("remote clean rejects missing and advanced server tips", (t) => {
  const missing = makeRemote(); t.after(missing.cleanup); pushBranch(missing, "safe");
  git(missing.bare.dir, "update-ref", "-d", "refs/heads/safe");
  const missingResult = runCli(missing.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(missingResult, 1);
  assert.equal(missingResult.stdout, "");
  assert.match(missingResult.stderr, /Remote state for 'origin\/safe' differs.*branch-care prune --remote origin/);

  const advanced = makeRemote(); t.after(advanced.cleanup); pushBranch(advanced, "safe");
  const oldOid = git(advanced.local.dir, "rev-parse", "refs/remotes/origin/safe");
  git(advanced.local.dir, "checkout", "-q", "safe");
  commit(advanced.local.dir, "advanced.txt", "advanced\n", "advanced");
  git(advanced.local.dir, "push", "-q", "origin", "safe");
  git(advanced.local.dir, "checkout", "-q", "main");
  git(advanced.local.dir, "update-ref", "refs/remotes/origin/safe", oldOid);
  const advancedResult = runCli(advanced.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(advancedResult, 1);
  assert.equal(advancedResult.stdout, ""); assert.match(advancedResult.stderr, /Remote state for 'origin\/safe' differs/);
});

test("remote clean server errors redact configured URLs", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const secretUrl = "/private/credential-bearing-remote";
  git(fixture.dir, "remote", "add", "origin", secretUrl);
  const result = runCli(fixture.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(result, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /<remote>/);
  assert.doesNotMatch(result.stderr, /credential-bearing-remote/);
});

test("remote clean empty set is a safe no-op", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  const before = serverRefs(fixture.bare.dir);
  const result = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(result, 0);
  assert.equal(result.stdout, "No remote branches are safe to delete.\n");
  assert.equal(serverRefs(fixture.bare.dir), before);
});

test("remote clean dry-run has exact output and preserves all state", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup); pushBranch(fixture, "safe");
  const submodule = makeRepo(); t.after(submodule.cleanup);
  git(fixture.local.dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule.dir, "deps/sample");
  git(fixture.local.dir, "tag", "keep-local");
  writeFileSync(resolvePath(fixture.local.dir, ".git", "FETCH_HEAD"), "sentinel\n");
  const beforeDirectory = snapshotDirectory(fixture.local.dir);
  const beforeRefs = allLocalRefs(fixture.local.dir);
  const beforeServer = serverRefs(fixture.bare.dir);
  const beforeFetchHead = fetchHead(fixture.local.dir);
  const result = runCli(fixture.local.dir, ["clean", "--remote", "origin", "--dry-run"]); assertExit(result, 0);
  assert.equal(result.stdout, "Remote dry run\nRemote: origin\n\nWould delete from server:\norigin/safe\n\nNo remote branches were removed.\n");
  assert.equal(allLocalRefs(fixture.local.dir), beforeRefs);
  assert.equal(serverRefs(fixture.bare.dir), beforeServer);
  assert.equal(fetchHead(fixture.local.dir), beforeFetchHead);
  assert.equal(snapshotDirectory(fixture.local.dir), beforeDirectory);
});

test("remote clean requires TTY before network access", (t) => {
  assert.equal(isInteractiveTerminal(true, true), true);
  assert.equal(isInteractiveTerminal(false, true), false);
  assert.equal(isInteractiveTerminal(true, false), false);
  assert.equal(isInteractiveTerminal(false, false), false);
  assert.equal(isInteractiveTerminal(undefined, true), false);
  assert.equal(isInteractiveTerminal(true, undefined), false);
  const fixture = makeRemote(); t.after(fixture.cleanup); pushBranch(fixture, "safe");
  const audited = runCliWithGitAudit(fixture.local.dir, ["clean", "--remote", "origin"]);
  assertExit(audited.result, 1);
  assert.equal(audited.result.stdout, "");
  assert.equal(audited.result.stderr.trim(), "Interactive remote selection is required. Use --dry-run to preview safely.");
  assert.equal(audited.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);
});

test("remote clean atomically deletes only selected exact server tips", async (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  for (const name of ["alpha", "beta", "keep"]) pushBranch(fixture, name);
  const beforeHeads = refs(fixture.local.dir);
  const beforeKeepTracking = git(fixture.local.dir, "rev-parse", "refs/remotes/origin/keep");
  const beforeServerMain = git(fixture.bare.dir, "rev-parse", "refs/heads/main");
  const repository = new Repository(new GitClient(fixture.local.dir));
  const lines: string[] = [];
  const code = await runRemoteClean({
    repository, remote: "origin", dryRun: false, interactive: true,
    prompts: { select: async () => ["origin/beta", "origin/alpha"], confirm: async () => true, input: async () => "origin" },
    output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) }
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.doesNotMatch(serverRefs(fixture.bare.dir), /refs\/heads\/(alpha|beta)/);
  assert.match(serverRefs(fixture.bare.dir), /refs\/heads\/keep/);
  assert.equal(git(fixture.bare.dir, "rev-parse", "refs/heads/main"), beforeServerMain);
  assert.equal(refs(fixture.local.dir), beforeHeads);
  assert.equal(git(fixture.local.dir, "rev-parse", "refs/remotes/origin/keep"), beforeKeepTracking);
  assert.deepEqual(lines.slice(-3), ["Deleted origin/alpha", "Deleted origin/beta", "Deleted 2 remote branches."]);

  const singular = makeRemote(); t.after(singular.cleanup); pushBranch(singular, "solo");
  const singularLines: string[] = [];
  const singularCode = await runRemoteClean({
    repository: new Repository(new GitClient(singular.local.dir)), remote: "origin", dryRun: false, interactive: true,
    prompts: { select: async () => ["origin/solo"], confirm: async () => true, input: async () => "origin" },
    output: { out: (line) => singularLines.push(line), err: (line) => singularLines.push(`ERR:${line}`) }
  });
  assert.equal(singularCode, 0, singularLines.join("\n"));
  assert.deepEqual(singularLines.slice(-2), ["Deleted origin/solo", "Deleted 1 remote branch."]);
});

test("remote clean interactive flow requires selection and both prompts", async (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup); pushBranch(fixture, "safe");
  const result = await runCliInteractive(fixture.local.dir, ["clean", "--remote", "origin"], [
    { waitFor: "Remote branches safe to delete:", input: " \r" },
    { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" },
    { waitFor: "Type 'origin' to confirm remote deletion:", input: "origin\r" }
  ]);
  assertExit(result, 0);
  assert.match(result.stdout, /Selected remote branches:/);
  assert.match(result.stdout, /Deleted origin\/safe/);
  assert.doesNotMatch(serverRefs(fixture.bare.dir), /refs\/heads\/safe/);
});

test("remote clean lease race preserves the entire server batch", async (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  for (const name of ["alpha", "beta"]) pushBranch(fixture, name);
  pushBranch(fixture, "race", true);
  const repository = new Repository(new GitClient(fixture.local.dir));
  const wrapped: RemoteCleanRepository = {
    resolveRemoteDeletionTarget: (remote) => repository.resolveRemoteDeletionTarget(remote),
    analyzeRemoteDeletion: (remote, base) => repository.analyzeRemoteDeletion(remote, base),
    revalidateRemoteDeletion: (remote, selected, base) => repository.revalidateRemoteDeletion(remote, selected, base),
    deleteRemoteBranches: async (remote, candidates) => {
      git(fixture.bare.dir, "update-ref", "refs/heads/alpha", "refs/heads/race");
      return repository.deleteRemoteBranches(remote, candidates);
    }
  };
  const lines: string[] = [];
  const code = await runRemoteClean({
    repository: wrapped, remote: "origin", dryRun: false, interactive: true,
    prompts: { select: async () => ["origin/alpha", "origin/beta"], confirm: async () => true, input: async () => "origin" },
    output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) }
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /Remote deletion failed:/);
  assert.doesNotMatch(lines.join("\n"), /Deleted origin\//);
  assert.match(serverRefs(fixture.bare.dir), /refs\/heads\/alpha/);
  assert.match(serverRefs(fixture.bare.dir), /refs\/heads\/beta/);

  const redaction = makeRemote(); t.after(redaction.cleanup); pushBranch(redaction, "safe");
  const secretPushUrl = "https://user:token@example.test/private.git";
  git(redaction.local.dir, "config", `url.${redaction.bare.dir}.insteadOf`, secretPushUrl);
  git(redaction.local.dir, "config", "remote.origin.pushurl", secretPushUrl);
  const redactingRunner = async (cwd: string, args: readonly string[]) => {
    if (args[0] === "push") throw new Error(`push rejected at ${secretPushUrl}`);
    return new GitClient(cwd).run(args);
  };
  const redactionLines: string[] = [];
  const redactionCode = await runRemoteClean({
    repository: new Repository(new GitClient(redaction.local.dir, redactingRunner)), remote: "origin", dryRun: false, interactive: true,
    prompts: { select: async () => ["origin/safe"], confirm: async () => true, input: async () => "origin" },
    output: { out: (line) => redactionLines.push(line), err: (line) => redactionLines.push(`ERR:${line}`) }
  });
  assert.equal(redactionCode, 1);
  assert.match(redactionLines.join("\n"), /Remote deletion failed: push rejected at <remote>/);
  assert.doesNotMatch(redactionLines.join("\n"), /user:token|example\.test/);
});

test("remote clean usage failures exit two before network access", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  for (const args of [
    ["clean", "--remote", "origin", "--unknown"], ["clean", "--remote", "origin", "--base"],
    ["clean", "--remote", "origin", "unexpected"], ["--base", "clean", "--remote", "origin"]
  ]) {
    const audited = runCliWithGitAudit(fixture.local.dir, args);
    assertExit(audited.result, 2);
    assert.equal(audited.result.stdout, ""); assert.match(audited.result.stderr, /Usage:/i);
    assert.equal(audited.calls.some(([command]) => ["ls-remote", "push", "fetch"].includes(command ?? "")), false);
  }
});
