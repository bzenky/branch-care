import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import test from "node:test";
import { assertExit, branch, cliPath, git, makeDirectory, makeEmptyDirectory, makeRepo, refs, runCli, runCliInteractive, snapshotDirectory, type Fixture } from "./helpers.js";

interface RemoteFixture {
  local: Fixture;
  bare: Fixture;
  cleanup(): void;
}

function makeRemote(name = "origin"): RemoteFixture {
  const local = makeRepo();
  const bare = makeEmptyDirectory("branch-care-bare-");
  git(bare.dir, "init", "-q", "--bare");
  git(local.dir, "remote", "add", name, bare.dir);
  git(local.dir, "push", "-q", "-u", name, "main");
  return { local, bare, cleanup: () => { local.cleanup(); bare.cleanup(); } };
}

function addStaleTracking(fixture: RemoteFixture, remote = "origin", name = "stale"): void {
  branch(fixture.local.dir, name);
  git(fixture.local.dir, "push", "-q", remote, name);
  git(fixture.bare.dir, "update-ref", "-d", `refs/heads/${name}`);
}

function remoteRefs(cwd: string): string {
  return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes");
}

function allRefs(cwd: string): string {
  return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags");
}

function serverRefs(gitDirectory: string): string {
  return git(gitDirectory, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags");
}

function fetchHead(cwd: string): string | undefined {
  const path = resolvePath(cwd, ".git", "FETCH_HEAD");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function runCliWithGitAudit(cwd: string, args: string[]): { result: ReturnType<typeof runCli>; calls: string[][] } {
  const bin = makeEmptyDirectory("branch-care-audit-git-");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = resolvePath(bin.dir, "git");
  const audit = resolvePath(bin.dir, "calls.jsonl");
  writeFileSync(wrapper, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args) + "\\n");
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  try {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH ?? ""}` }
    });
    const calls = existsSync(audit)
      ? readFileSync(audit, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
      : [];
    return { result, calls };
  } finally {
    bin.cleanup();
  }
}

function runCliWithRemoteDiscoveryFailure(cwd: string, message: string): ReturnType<typeof runCli> {
  const bin = makeEmptyDirectory("branch-care-fake-git-");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = resolvePath(bin.dir, "git");
  writeFileSync(wrapper, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "remote" && args.length === 1) {
  process.stderr.write(${JSON.stringify(message)} + "\\n");
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  try {
    return spawnSync(process.execPath, [cliPath, "prune", "--dry-run"], {
      cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH ?? ""}` }
    });
  } finally {
    bin.cleanup();
  }
}

test("prune resolves explicit and sole configured remotes", (t) => {
  const sole = makeRemote("upstream"); t.after(sole.cleanup);
  const automatic = runCli(sole.local.dir, ["prune", "--dry-run"]); assertExit(automatic, 0);
  assert.match(automatic.stdout, /^Prune preview: upstream$/m);

  const explicit = makeRemote(); t.after(explicit.cleanup);
  git(explicit.local.dir, "remote", "add", "upstream", explicit.bare.dir);
  git(explicit.local.dir, "config", "remote.upstream.fetch", "+refs/heads/*:refs/remotes/upstream/*");
  const selected = runCli(explicit.local.dir, ["prune", "--remote", "origin", "--dry-run"]); assertExit(selected, 0);
  assert.match(selected.stdout, /^Prune preview: origin$/m);
  assert.doesNotMatch(selected.stdout, /^Prune preview: upstream$/m);
});

test("prune rejects an unknown remote before network access", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  const before = allRefs(fixture.local.dir);
  const audited = runCliWithGitAudit(fixture.local.dir, ["prune", "--remote", "missing", "--dry-run"]);
  assertExit(audited.result, 1);
  assert.equal(audited.result.stdout, "");
  assert.equal(audited.result.stderr.trim(), "Remote 'missing' is not configured.");
  assert.equal(allRefs(fixture.local.dir), before);
  assert.equal(audited.calls.some(([command]) => command === "fetch"), false, audited.calls.map((args) => args.join(" ")).join("\n"));
});

test("prune with no remotes is a safe no-op", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const before = snapshotDirectory(fixture.dir);
  const result = runCli(fixture.dir, ["prune"]); assertExit(result, 0);
  assert.equal(result.stdout, "No remotes are configured.\n");
  assert.equal(result.stderr, "");
  assert.equal(snapshotDirectory(fixture.dir), before);
});

test("prune requires selection for multiple remotes", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const remote of ["zeta", "Alpha", "beta", "beta"]) {
    if (git(fixture.dir, "remote").split("\n").includes(remote)) continue;
    git(fixture.dir, "remote", "add", remote, `/unreachable/${remote}`);
  }
  const result = runCli(fixture.dir, ["prune", "--dry-run"]); assertExit(result, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Multiple remotes are configured: Alpha, beta, zeta\. Use --remote <name>\./);
  assert.doesNotMatch(result.stderr, /Could not read from remote/);
});

test("prune rejects every unsafe refspec class before fetch", (t) => {
  const cases: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["malformed", "bad"],
    ["tag", "refs/heads/*:refs/tags/*"],
    ["local-head", "refs/heads/*:refs/heads/*"],
    ["other-remote", "refs/heads/*:refs/remotes/upstream/*"],
    ["other-namespace", "refs/heads/*:refs/custom/*"]
  ];
  for (const [label, refspec] of cases) {
    const fixture = makeRepo(); t.after(fixture.cleanup);
    git(fixture.dir, "remote", "add", "origin", `/network-must-not-run/${label}`);
    if (refspec === undefined) git(fixture.dir, "config", "--unset-all", "remote.origin.fetch");
    else git(fixture.dir, "config", "--replace-all", "remote.origin.fetch", refspec);
    const before = allRefs(fixture.dir);
    const result = runCli(fixture.dir, ["prune", "--remote", "origin", "--dry-run"]); assertExit(result, 1);
    assert.equal(result.stdout, "", label);
    assert.match(result.stderr, /Unsafe fetch configuration for remote 'origin'/, label);
    assert.doesNotMatch(result.stderr, /Could not read from remote/, label);
    assert.equal(allRefs(fixture.dir), before, label);
  }
});

test("prune dry-run leaves repository and server state unchanged", (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  addStaleTracking(fixture);
  git(fixture.local.dir, "tag", "keep-local");
  writeFileSync(resolvePath(fixture.local.dir, ".git", "FETCH_HEAD"), "sentinel fetch head\n");
  const beforeDirectory = snapshotDirectory(fixture.local.dir);
  const beforeRefs = allRefs(fixture.local.dir);
  const beforeServer = serverRefs(fixture.bare.dir);
  const beforeConfig = git(fixture.local.dir, "config", "--local", "--list", "--null");
  const beforeFetchHead = fetchHead(fixture.local.dir);

  const result = runCli(fixture.local.dir, ["prune", "--dry-run"]); assertExit(result, 0);
  assert.match(result.stdout, /^Prune preview: origin$/m);
  assert.match(result.stdout, /\[deleted\].*stale/);
  assert.match(result.stdout, /Dry run: no refs were changed\./);
  assert.equal(allRefs(fixture.local.dir), beforeRefs);
  assert.equal(serverRefs(fixture.bare.dir), beforeServer);
  assert.equal(git(fixture.local.dir, "config", "--local", "--list", "--null"), beforeConfig);
  assert.equal(fetchHead(fixture.local.dir), beforeFetchHead);
  assert.equal(snapshotDirectory(fixture.local.dir), beforeDirectory);
});

test("prune preparation and preview failures are closed and redacted", (t) => {
  const outside = makeDirectory(); t.after(outside.cleanup);
  const nonRepo = runCli(outside.dir, ["prune", "--dry-run"]); assertExit(nonRepo, 1);
  assert.equal(nonRepo.stdout, ""); assert.match(nonRepo.stderr, /Not a Git repository/);

  const discovery = makeRepo(); t.after(discovery.cleanup);
  const discoveryResult = runCliWithRemoteDiscoveryFailure(discovery.dir, "remote discovery unavailable");
  assertExit(discoveryResult, 1); assert.equal(discoveryResult.stdout, ""); assert.match(discoveryResult.stderr, /remote discovery unavailable/);

  const unsafe = makeRepo(); t.after(unsafe.cleanup);
  git(unsafe.dir, "remote", "add", "origin", "/must-not-connect");
  git(unsafe.dir, "config", "--replace-all", "remote.origin.fetch", "refs/heads/*:refs/tags/*");
  const unsafeResult = runCli(unsafe.dir, ["prune", "--dry-run"]); assertExit(unsafeResult, 1);
  assert.equal(unsafeResult.stdout, ""); assert.match(unsafeResult.stderr, /Unsafe fetch configuration/);

  const failed = makeRepo(); t.after(failed.cleanup);
  const secretUrl = "/private/credential-bearing-location";
  git(failed.dir, "remote", "add", "origin", secretUrl);
  const audited = runCliWithGitAudit(failed.dir, ["prune", "--dry-run"]);
  assertExit(audited.result, 1);
  assert.equal(audited.result.stdout, "");
  assert.match(audited.result.stderr, /<remote>/);
  assert.doesNotMatch(audited.result.stderr, /credential-bearing-location/);
  assert.doesNotMatch(audited.result.stderr, /Prune preview:/);
  const fetchCalls = audited.calls.filter(([command]) => command === "fetch");
  assert.equal(fetchCalls.length, 1, audited.calls.map((args) => args.join(" ")).join("\n"));
  assert.ok(fetchCalls[0]?.includes("--dry-run"));
});

test("prune requires an interactive terminal before network access", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  git(fixture.dir, "remote", "add", "origin", "/network-must-not-run/noninteractive");
  const result = runCli(fixture.dir, ["prune"]); assertExit(result, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Interactive confirmation is required. Use --dry-run to preview safely.");
  assert.doesNotMatch(result.stderr, /Could not read from remote/);
});

test("confirmed prune changes only selected remote tracking state", async (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup);
  const submodule = makeRepo(); t.after(submodule.cleanup);
  addStaleTracking(fixture);
  git(fixture.bare.dir, "update-ref", "refs/heads/new-server", "refs/heads/main");
  git(fixture.local.dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule.dir, "deps/sample");
  git(fixture.local.dir, "tag", "keep-local");
  writeFileSync(resolvePath(fixture.local.dir, ".git", "FETCH_HEAD"), "sentinel fetch head\n");
  const beforeHeads = refs(fixture.local.dir);
  const beforeTags = git(fixture.local.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags");
  const beforeServer = serverRefs(fixture.bare.dir);
  const beforeConfig = git(fixture.local.dir, "config", "--local", "--list", "--null");
  const beforeWorktree = readFileSync(resolvePath(fixture.local.dir, "seed.txt"), "utf8");
  const beforeGitmodules = readFileSync(resolvePath(fixture.local.dir, ".gitmodules"), "utf8");
  const beforeSubmoduleHead = git(resolvePath(fixture.local.dir, "deps", "sample"), "rev-parse", "HEAD");
  const beforeFetchHead = fetchHead(fixture.local.dir);
  assert.match(remoteRefs(fixture.local.dir), /refs\/remotes\/origin\/stale/);
  assert.doesNotMatch(remoteRefs(fixture.local.dir), /refs\/remotes\/origin\/new-server/);

  const result = await runCliInteractive(fixture.local.dir, ["prune"], [
    { waitFor: "Apply fetch and prune for 'origin'?", input: "y\r" }
  ]);
  assertExit(result, 0);
  assert.match(result.stdout, /Pruned remote 'origin'\./);
  assert.doesNotMatch(remoteRefs(fixture.local.dir), /refs\/remotes\/origin\/stale/);
  assert.match(remoteRefs(fixture.local.dir), /refs\/remotes\/origin\/new-server/);
  assert.equal(refs(fixture.local.dir), beforeHeads);
  assert.equal(git(fixture.local.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags"), beforeTags);
  assert.equal(serverRefs(fixture.bare.dir), beforeServer);
  assert.equal(git(fixture.local.dir, "config", "--local", "--list", "--null"), beforeConfig);
  assert.equal(readFileSync(resolvePath(fixture.local.dir, "seed.txt"), "utf8"), beforeWorktree);
  assert.equal(readFileSync(resolvePath(fixture.local.dir, ".gitmodules"), "utf8"), beforeGitmodules);
  assert.equal(git(resolvePath(fixture.local.dir, "deps", "sample"), "rev-parse", "HEAD"), beforeSubmoduleHead);
  assert.equal(fetchHead(fixture.local.dir), beforeFetchHead);
});

test("prune usage failures exit two without network access", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  git(fixture.dir, "remote", "add", "origin", "/network-must-not-run/usage");
  for (const args of [["prune", "--unknown"], ["prune", "--remote"], ["prune", "unexpected"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/i);
    assert.doesNotMatch(result.stderr, /Could not read from remote/);
  }
});
