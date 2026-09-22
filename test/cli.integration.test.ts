import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { runRemoteClean } from "../src/commands/remote-clean.js";
import { isInteractiveTerminal, parseOlderThan, removeAddedSignalListeners, snapshotSignalListeners } from "../src/index.js";
import { assertExit, branch, cliPath, git, makeDirectory, makeEmptyDirectory, makeRepo, packageJson, refs, runCli, runCliInteractive, snapshotDirectory, withPrependedPath, writeNodeLauncher } from "./helpers.js";

test("entry point uses natural termination for every exit class", async (t) => {
  const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
  assert.doesNotMatch(source, /process\.(?:exit|reallyExit)\s*\(/); assert.match(source, /const ENTRY_SIGNALS = \["SIGHUP", "SIGINT", "SIGTERM"\] as const/); assert.match(source, /removeAddedSignalListeners\(signalListeners\);\s+await finishEntryStdio\(\)/); assert.match(source, /Promise\.all\(\[finishOutput\(process\.stdout\), finishOutput\(process\.stderr\)\]\)/); assert.match(source, /stream\.once\("finish", complete\)/); assert.match(source, /stream\.end\(\)/); assert.match(source, /process\.stdin\.pause\(\)/); assert.match(source, /stdin\.unref\?\.\(\)/); assert.match(source, /if \(!stdin\.destroyed\) stdin\.destroy\(\)/);
  const original = (): void => {}; const added = (): void => {}; process.on("SIGTERM", original);
  try {
    const snapshot = snapshotSignalListeners(); process.on("SIGTERM", original); process.on("SIGTERM", added); process.on("SIGTERM", added); removeAddedSignalListeners(snapshot);
    assert.equal(process.listeners("SIGTERM").filter((listener) => listener === original).length, 1); assert.equal(process.listeners("SIGTERM").includes(added), false);
  } finally { process.removeListener("SIGTERM", original); process.removeListener("SIGTERM", added); }
  const directory = makeDirectory(); t.after(directory.cleanup);
  for (const [args, code] of [[["--help"], 0], [["status"], 1], [["unknown"], 2]] as const) assertExit(runCli(directory.dir, [...args]), code);
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic");
  const cancelled = await runCliInteractive(fixture.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "\u0003" }]);
  assertExit(cancelled, 0); assert.match(cancelled.stdout, /No branches were removed/);
});

test("large piped JSON survives output backpressure completely", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const largeAuthor = "A".repeat(9_000);
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "large status metadata"], { cwd: fixture.dir, env: { ...process.env, GIT_AUTHOR_NAME: largeAuthor, GIT_AUTHOR_EMAIL: "large@example.test", GIT_COMMITTER_NAME: "Branch Tester", GIT_COMMITTER_EMAIL: "branch@example.test" } });
  const oid = git(fixture.dir, "rev-parse", "HEAD");
  const updates = Array.from({ length: 127 }, (_, index) => `create refs/heads/topic-${String(index).padStart(3, "0")} ${oid}`).join("\n");
  execFileSync("git", ["update-ref", "--stdin"], { cwd: fixture.dir, input: `start\n${updates}\nprepare\ncommit\n`, maxBuffer: 1024 * 1024 });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, "status", "--json"], { cwd: fixture.dir, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; child.stdout.pause();
    child.stderr.on("data", (chunk) => stderr.push(chunk)); child.on("error", reject);
    setTimeout(() => { child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stdout.resume(); }, 300);
    child.on("close", (code) => resolveResult({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.ok(Buffer.byteLength(result.stdout) >= 1024 * 1024);
  assert.equal(result.stdout.endsWith("\n") && !result.stdout.endsWith("\n\n"), true); assert.equal((JSON.parse(result.stdout) as { schemaVersion: number }).schemaVersion, 1);
});

test("piped output completes for every stream and exit class", (t) => {
  const repo = makeRepo(); const directory = makeDirectory(); t.after(repo.cleanup); t.after(directory.cleanup);
  const cases = [[repo.dir, ["--help"], 0, "stdout"], [repo.dir, ["--version"], 0, "stdout"], [repo.dir, ["status"], 0, "stdout"], [repo.dir, ["clean", "--dry-run"], 0, "stdout"], [directory.dir, ["status"], 1, "stderr"], [repo.dir, ["unknown"], 2, "stderr"]] as const;
  for (const [cwd, args, code, stream] of cases) { const result = runCli(cwd, [...args]); assertExit(result, code); assert.equal(result[stream].endsWith("\n"), true); assert.equal(result[stream === "stdout" ? "stderr" : "stdout"], ""); }
});

test("non-interactive mutation matrix rejects before all work", (t) => {
  const directory = makeDirectory(); t.after(directory.cleanup);
  for (const args of [["clean"], ["clean", "--remote", "origin"], ["prune"], ["undo"], ["undo", "clean-20260102T030405Z-a1"], ["undo", "--discard", "clean-20260102T030405Z-a1"]]) {
    const result = runCli(directory.dir, args); assertExit(result, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /Interactive/); assert.doesNotMatch(result.stderr, /Not a Git repository/);
  }
});

test("bare non-interactive help and usage errors never enter the menu", (t) => {
  assert.equal(isInteractiveTerminal(true, true), true);
  for (const [stdinIsTTY, stdoutIsTTY] of [[false, true], [true, false], [false, false], [undefined, true], [true, undefined]] as const) {
    assert.equal(isInteractiveTerminal(stdinIsTTY, stdoutIsTTY), false);
  }
  const help = runCli(process.cwd(), ["--help"]); assertExit(help, 0);
  const bare = runCli(process.cwd(), []); assertExit(bare, 0);
  assert.equal(bare.stdout, help.stdout);
  assert.doesNotMatch(bare.stdout, /What do you want to do\?/);
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const args of [["--unknown"], ["--base"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2);
    assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:/i);
    assert.doesNotMatch(result.stderr, /What do you want to do\?/);
  }
});

test("older-than parser accepts only positive safe-integer days", () => {
  for (const [value, days] of [["1d", 1], ["30d", 30], ["9007199254740991d", Number.MAX_SAFE_INTEGER]] as const) {
    assert.equal(parseOlderThan(value), days);
  }
  for (const value of ["0d", "9007199254740992d", "1D", "+1d", "-1d", "1.5d", " 1d", "1d ", "1", "1w", "1d2d"]) {
    assert.throws(() => parseOlderThan(value), /positive whole number|must not exceed/);
  }
});

test("invalid older-than fails before cleanup work", (t) => {
  const fixture = makeRepo(); const bin = makeEmptyDirectory("branch-care-invalid-age-");
  t.after(fixture.cleanup); t.after(bin.cleanup); const before = refs(fixture.dir);
  const audit = resolve(bin.dir, "git-called");
  const wrapper = writeNodeLauncher(bin.dir, "git", `require("node:fs").writeFileSync(${JSON.stringify(audit)}, "called"); process.exit(99);`);
  for (const args of [["clean", "--older-than"], ["clean", "--older-than", "0d"], ["clean", "--remote", "origin", "--older-than", "1w"]]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: fixture.dir, encoding: "utf8",
      env: { ...withPrependedPath(bin.dir), BRANCH_CARE_TEST_GIT_EXECUTABLE: process.execPath, BRANCH_CARE_TEST_GIT_PREFIX: wrapper }
    });
    assertExit(result, 2);
    assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:|argument.*invalid/i);
    assert.doesNotMatch(result.stderr, /Not a Git repository|No remotes are configured|Interactive|Branches safe to delete/);
    assert.equal(existsSync(audit), false, "invalid input must not execute Git for repository analysis, network access, or mutation");
  }
  assert.equal(refs(fixture.dir), before);
});

test("omitted older-than preserves cleanup behavior", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const local = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(local, 0);
  assert.equal(local.stdout, "No branches are safe to delete.\n");
  assert.doesNotMatch(local.stdout + local.stderr, /Older than:/);
  const remote = runCli(fixture.dir, ["clean", "--remote", "--dry-run"]); assertExit(remote, 0);
  assert.equal(remote.stdout, "No remotes are configured.\n");
  assert.doesNotMatch(remote.stdout + remote.stderr, /Older than:/);
});

test("help exposes the approved command grammar", () => {
  const result = runCli(process.cwd(), ["--help"]); assertExit(result, 0);
  assert.match(result.stdout, /status \[options\]/);
  assert.match(result.stdout, /clean \[options\]/);
  assert.match(result.stdout, /remote \[options\]/);
  assert.match(result.stdout, /--base <branch>/);
  const bare = runCli(process.cwd(), []); assertExit(bare, 0);
  assert.equal(bare.stdout, result.stdout);
  const clean = runCli(process.cwd(), ["clean", "--help"]); assertExit(clean, 0);
  assert.match(clean.stdout, /--dry-run/);
  assert.match(clean.stdout, /--base <branch>/);
});

test("help documents remote inspection", () => {
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  const remote = runCli(process.cwd(), ["remote", "--help"]); assertExit(remote, 0);
  assert.match(root.stdout, /remote \[options\]\s+inspect locally known remote branches/);
  assert.match(remote.stdout, /--base <branch>/);
  assert.match(remote.stdout, /inspect locally known remote branches/);
});

test("help documents prune network mutation", () => {
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  const prune = runCli(process.cwd(), ["prune", "--help"]); assertExit(prune, 0);
  assert.match(root.stdout, /prune \[options\]\s+fetch and prune local remote-tracking refs over\s+the network/);
  for (const text of ["--remote <name>", "--dry-run", "network", "changing refs"]) {
    assert.ok(prune.stdout.includes(text), `prune help must include ${text}`);
  }
});

test("help documents explicit remote clean mode", () => {
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  const clean = runCli(process.cwd(), ["clean", "--help"]); assertExit(clean, 0);
  assert.match(root.stdout, /clean \[options\]\s+select and safely delete merged branches\s+locally by default/);
  for (const text of ["--remote [name]", "remote server", "instead of locally", "--dry-run", "--base <branch>"]) {
    assert.ok(clean.stdout.includes(text), `clean help must include ${text}`);
  }
});

test("help documents repository configuration", () => {
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  const config = runCli(process.cwd(), ["config", "--help"]); assertExit(config, 0);
  assert.match(root.stdout, /config \[options\]\s+inspect or update repository \.branch-care\.json\s+configuration/);
  const required = ["config", "--base <branch>", ".branch-care.json", "baseBranch", "staleAfterDays", "protectedBranches"];
  for (const [route, stdout] of [["root", root.stdout], ["config", config.stdout]]) {
    for (const text of required) assert.ok(stdout.includes(text), `${route} help must include ${text}`);
  }
});

test("version matches the package", (t) => {
  const result = runCli(process.cwd(), ["--version"]); assertExit(result, 0);
  assert.equal(result.stdout.trim(), packageJson().version);

  const directory = mkdtempSync(resolve(tmpdir(), "branch-care-bin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const linkedCli = resolve(directory, "branch-care");
  symlinkSync(cliPath, linkedCli);
  const linkedResult = spawnSync(process.execPath, [linkedCli, "--version"], { encoding: "utf8" });
  assertExit(linkedResult, 0);
  assert.equal(linkedResult.stdout.trim(), packageJson().version);
});

test("invalid command and option exit two", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const before = refs(fixture.dir);
  for (const args of [["unknown"], ["status", "--invalid"], ["clean", "--invalid"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2);
    assert.match(result.stderr, /Usage:/i);
  }
  assert.equal(refs(fixture.dir), before);
});

test("undo grammar rejects every malformed and mutually exclusive form before work", (t) => {
  const fixture = makeRepo(); const bin = makeEmptyDirectory("branch-care-undo-grammar-"); t.after(fixture.cleanup); t.after(bin.cleanup); writeFileSync(resolve(fixture.dir, "sentinel"), "unchanged\n"); const audit = resolve(bin.dir, "git-called"); const wrapper = writeNodeLauncher(bin.dir, "git", `require("node:fs").writeFileSync(${JSON.stringify(audit)}, "called"); process.exit(99);`);
  const stableState = () => {
    const commonRaw = git(fixture.dir, "rev-parse", "--git-common-dir"); const commonDir = resolve(fixture.dir, commonRaw); const recoveryRoot = resolve(commonDir, "branch-care");
    return {
      // Git may update unrelated index/cache/log internals even for read-only commands. Assert every stable repository surface and Branch Care-owned file instead.
      workingTree: snapshotDirectory(fixture.dir, [".git"]), refs: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)"),
      head: git(fixture.dir, "rev-parse", "HEAD"), headRef: git(fixture.dir, "symbolic-ref", "-q", "HEAD"),
      indexDiff: git(fixture.dir, "diff", "--cached", "--binary"), worktreeDiff: git(fixture.dir, "diff", "--binary"),
      config: git(fixture.dir, "config", "--local", "--list"), remotes: git(fixture.dir, "remote", "-v"),
      recoveryFiles: existsSync(recoveryRoot) ? snapshotDirectory(recoveryRoot) : undefined
    };
  };
  const before = stableState();
  const cases: Array<[string, string[]]> = [
    ["wrong prefix", ["undo", "undo-20260102T030405Z-a1"]], ["malformed timestamp", ["undo", "clean-20261302T030405Z-a1"]], ["missing suffix", ["undo", "clean-20260102T030405Z-"]], ["uppercase hex", ["undo", "clean-20260102T030405Z-A1"]], ["non-hex suffix", ["undo", "clean-20260102T030405Z-g1"]], ["path separator", ["undo", "clean-20260102T030405Z-a/1"]], ["surrounding characters", ["undo", "xclean-20260102T030405Z-a1"]], ["ID plus list", ["undo", "clean-20260102T030405Z-a1", "--list"]], ["ID plus discard", ["undo", "clean-20260102T030405Z-a1", "--discard", "clean-20260102T030405Z-a2"]], ["list plus discard", ["undo", "--list", "--discard", "clean-20260102T030405Z-a1"]]
  ];
  for (const [name, args] of cases) { const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: fixture.dir, encoding: "utf8", env: { ...withPrependedPath(bin.dir), BRANCH_CARE_TEST_GIT_EXECUTABLE: process.execPath, BRANCH_CARE_TEST_GIT_PREFIX: wrapper } }); assertExit(result, 2); assert.equal(result.stdout, "", name); assert.match(result.stderr, /Usage:|invalid|mutually exclusive/i, name); assert.equal(existsSync(audit), false, name); assert.deepEqual(stableState(), before, name); }
});

test("undo history preserves non-target commands and cleanup safety", async (t) => {
  const fixture = makeRepo(); const bare = makeEmptyDirectory("branch-care-nontarget-server-"); t.after(fixture.cleanup); t.after(bare.cleanup); git(bare.dir, "init", "-q", "--bare"); git(fixture.dir, "remote", "add", "origin", bare.dir); git(fixture.dir, "push", "-q", "-u", "origin", "main"); branch(fixture.dir, "candidate"); branch(fixture.dir, "release/1"); writeFileSync(resolve(fixture.dir, ".branch-care.json"), `${JSON.stringify({ baseBranch: "main", staleAfterDays: 60, protectedBranches: [] }, null, 2)}\n`);
  const state = () => ({ tree: snapshotDirectory(fixture.dir, [".git"]), refs: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)"), server: git(bare.dir, "for-each-ref", "--format=%(refname) %(objectname)") }); const before = state();
  const status = runCli(fixture.dir, ["status"]); assertExit(status, 0); assert.match(status.stdout, /candidate/); assert.match(status.stdout, /release\/1/);
  const remote = runCli(fixture.dir, ["remote"]); assertExit(remote, 0); assert.match(remote.stdout, /origin\/main/);
  const prune = runCli(fixture.dir, ["prune", "--dry-run"]); assertExit(prune, 0); assert.match(prune.stdout, /dry run|No stale remote-tracking refs/i);
  const config = runCli(fixture.dir, ["config"]); assertExit(config, 0); assert.match(config.stdout, /baseBranch.*main|"baseBranch": "main"/s);
  const age = runCli(fixture.dir, ["clean", "--dry-run", "--older-than", "9007199254740991d"]); assertExit(age, 0); assert.match(age.stdout, /No branches are safe to delete/); assert.doesNotMatch(age.stdout, /release\/1/); assert.deepEqual(state(), before);
  let localDeletes = 0; const localLines: string[] = []; const localCode = await runClean({ repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "candidate", commitTimestamp: new Date(0), ageDays: 100, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: false, reason: "tip changed" }), branchOid: async () => git(fixture.dir, "rev-parse", "candidate"), deleteBranch: async () => { localDeletes += 1; } }, prompts: { select: async () => ["candidate"], confirm: async () => true }, output: { out: (line) => localLines.push(line), err: (line) => localLines.push(line) }, dryRun: false, interactive: true }); assert.equal(localCode, 1); assert.equal(localDeletes, 0); assert.match(localLines.join("\n"), /Skipped candidate: tip changed/);
  let remoteDeletes = 0; const oid = git(fixture.dir, "rev-parse", "candidate"); const remoteLines: string[] = []; const remoteCode = await runRemoteClean({ repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: bare.dir }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/candidate", branchName: "candidate", oid, ageDays: 100 }] }), revalidateRemoteDeletion: async () => { throw new Error("live tip changed; lease refused"); }, deleteRemoteBranches: async () => { remoteDeletes += 1; return { stdout: "", stderr: "" }; } }, prompts: { select: async () => ["origin/candidate"], confirm: async () => true, input: async () => "origin" }, output: { out: (line) => remoteLines.push(line), err: (line) => remoteLines.push(line) }, remote: "origin", dryRun: false, interactive: true }); assert.equal(remoteCode, 1); assert.equal(remoteDeletes, 0); assert.match(remoteLines.join("\n"), /live tip changed; lease refused/); assert.deepEqual(state(), before);
});

test("status help documents versioned JSON", () => {
  const result = runCli(process.cwd(), ["status", "--help"]); assertExit(result, 0);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /versioned machine-readable output/i);
});

test("human status usage errors remain exit two", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const args of [["status", "--unknown"], ["status", "--base"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/i);
  }
});
