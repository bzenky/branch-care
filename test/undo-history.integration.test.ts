import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { runRemoteClean } from "../src/commands/remote-clean.js";
import { runUndo } from "../src/commands/undo.js";
import { GitClient, nativeGitRunner } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { replaceReceipt, UndoHistory, type UndoReceipt } from "../src/undo-history.js";
import { branch, git, makeEmptyDirectory, makeRepo, refs, runCli, snapshotDirectory } from "./helpers.js";

function canonicalFilesystemPath(path: string): string {
  const missing: string[] = []; let existing = path;
  while (!existsSync(existing)) { missing.unshift(basename(existing)); const parent = dirname(existing); assert.notEqual(parent, existing, `no existing ancestor for ${path}`); existing = parent; }
  const canonical = resolve(realpathSync.native(existing), ...missing);
  return process.platform === "win32" ? canonical.replaceAll("\\", "/").toLowerCase() : canonical;
}

async function cleanOne(dir: string, name: string) {
  branch(dir, name); const client = new GitClient(dir); const repository = new Repository(client); const history = new UndoHistory(client); const lines: string[] = [];
  const code = await runClean({ repository, history, dryRun: false, interactive: true, prompts: { select: async () => [name], confirm: async () => true }, output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) } });
  return { code, lines, history };
}

test("no deletion and failed remote push leave no completed recovery data", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const client = new GitClient(fixture.dir); const history = new UndoHistory(client); const oid = git(fixture.dir, "rev-parse", "HEAD");
  assert.equal(runCli(fixture.dir, ["clean", "--dry-run"]).status, 0); assert.deepEqual(await history.list(), []); assert.equal(git(fixture.dir, "for-each-ref", "--format=%(refname)", "refs/branch-care/undo"), "");
  const lines: string[] = []; const code = await runRemoteClean({ history, remote: "origin", dryRun: false, interactive: true, repository: {
    resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: "/server.git" }),
    analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/topic", branchName: "topic", oid, ageDays: 1 }] }),
    revalidateRemoteDeletion: async (_target, selected) => [...selected], deleteRemoteBranches: async () => { throw new Error("push rejected before receive"); }, remoteHeadOids: async () => new Map([["topic", oid]])
  }, prompts: { select: async () => ["origin/topic"], confirm: async () => true, input: async () => "origin" }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) } });
  assert.equal(code, 1); assert.match(lines.join("\n"), /push rejected/); assert.deepEqual(await history.list(), []); assert.equal(git(fixture.dir, "for-each-ref", "--format=%(refname)", "refs/branch-care/undo"), "");
});

test("history retains ten distinct operations without eviction", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const preserved = new Map<string, { receipt: string; ref: string }>(); const creationOrder: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const result = await cleanOne(fixture.dir, `topic-${index}`); assert.equal(result.code, 0, result.lines.join("\n")); const paths = await history.paths(); const operations = await history.list(); const created = operations.find(({ id }) => !preserved.has(id))!; creationOrder.push(created.id); preserved.set(created.id, { receipt: readFileSync(resolve(paths.operations, `${created.id}.json`), "utf8"), ref: git(fixture.dir, "rev-parse", created.entries[0]!.backupRef) });
    assert.equal(operations.length, index + 1); for (const operation of operations) { const original = preserved.get(operation.id)!; assert.equal(readFileSync(resolve(paths.operations, `${operation.id}.json`), "utf8"), original.receipt, operation.id); assert.equal(git(fixture.dir, "rev-parse", operation.entries[0]!.backupRef), original.ref, operation.id); }
  }
  const operations = await history.list(); assert.equal(operations.length, 10); assert.equal(new Set(operations.map(({ id }) => id)).size, 10); assert.deepEqual(new Set(operations.map(({ id }) => id)), new Set(creationOrder)); assert.equal(operations.every(({ entries }) => entries.length === 1), true);
});

test("recovery namespace and lock are shared by linked worktrees", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); assert.equal(result.code, 0);
  const linked = resolve(fixture.dir, "..", `${basename(fixture.dir)}-linked`); git(fixture.dir, "worktree", "add", "-q", "--detach", linked); t.after(() => { try { git(fixture.dir, "worktree", "remove", "--force", linked); } catch {} });
  const second = new UndoHistory(new GitClient(linked)); assert.equal((await second.list()).length, 1);
  const paths = await result.history.paths(); const linkedPaths = await second.paths(); const [operation] = await result.history.list();
  assert.equal(canonicalFilesystemPath(paths.commonDir), canonicalFilesystemPath(git(fixture.dir, "rev-parse", "--absolute-git-dir"))); assert.equal(paths.operations, resolve(paths.commonDir, "branch-care", "undo", "operations")); assert.equal(paths.lock, resolve(paths.commonDir, "branch-care", "undo", "history.lock")); assert.equal(resolve(paths.operations, `${operation!.id}.json`), resolve(paths.commonDir, "branch-care", "undo", "operations", `${operation!.id}.json`)); assert.equal(operation!.entries[0]!.backupRef, `refs/branch-care/undo/${operation!.id}/local/topic`);
  for (const key of ["commonDir", "root", "operations", "lock"] as const) assert.equal(canonicalFilesystemPath(linkedPaths[key]), canonicalFilesystemPath(paths[key]), `${key} must identify the same shared recovery namespace`);
  assert.deepEqual(await second.list(), [operation]);
  const lock = await result.history.acquire(); assert.equal(existsSync(paths.lock), true); await assert.rejects(second.acquire(), /locked/); lock.release(); const next = await second.acquire(); next.release();
});

test("full history blocks real local and remote cleanup before side effects", async (t) => {
  const fixture = makeRepo(); const bare = makeEmptyDirectory("branch-care-capacity-server-"); t.after(fixture.cleanup); t.after(bare.cleanup); git(bare.dir, "init", "-q", "--bare"); for (let index = 0; index < 10; index += 1) await cleanOne(fixture.dir, `topic-${index}`); branch(fixture.dir, "eleventh"); const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths();
  const snapshot = () => ({ recovery: snapshotDirectory(paths.root), local: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)"), server: git(bare.dir, "for-each-ref", "--format=%(refname) %(objectname)") }); const before = snapshot();
  const oid = git(fixture.dir, "rev-parse", "HEAD"); let localDeletes = 0; const localLines: string[] = []; const localCode = await runClean({ history, repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "eleventh", commitTimestamp: new Date(0), ageDays: 1, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: true }), branchOid: async () => oid, deleteBranch: async () => { localDeletes += 1; } }, prompts: { select: async () => ["eleventh"], confirm: async () => true }, output: { out: (line) => localLines.push(line), err: (line) => localLines.push(line) }, dryRun: false, interactive: true });
  assert.equal(localCode, 1); assert.equal(localDeletes, 0); assert.match(localLines.join("\n"), /capacity 10.*undo --list.*undo --discard/s); assert.deepEqual(snapshot(), before);
  let remoteDeletes = 0; const remoteLines: string[] = []; const remoteCode = await runRemoteClean({ history, repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: bare.dir }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/eleventh", branchName: "eleventh", oid, ageDays: 1 }] }), revalidateRemoteDeletion: async (_target, selected) => [...selected], deleteRemoteBranches: async () => { remoteDeletes += 1; return { stdout: "", stderr: "" }; }, remoteHeadOids: async () => new Map() }, prompts: { select: async () => ["origin/eleventh"], confirm: async () => true, input: async () => "origin" }, output: { out: (line) => remoteLines.push(line), err: (line) => remoteLines.push(line) }, remote: "origin", dryRun: false, interactive: true });
  assert.equal(remoteCode, 1); assert.equal(remoteDeletes, 0); assert.match(remoteLines.join("\n"), /capacity 10.*undo --list.*undo --discard/s); assert.deepEqual(snapshot(), before);
});

test("full history dry-runs preserve previews and report cleanup block", async (t) => {
  const fixture = makeRepo(); const bare = makeEmptyDirectory("branch-care-dry-capacity-server-"); t.after(fixture.cleanup); t.after(bare.cleanup); git(bare.dir, "init", "-q", "--bare"); for (let index = 0; index < 10; index += 1) await cleanOne(fixture.dir, `topic-${index}`); branch(fixture.dir, "preview"); const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths(); const oid = git(fixture.dir, "rev-parse", "HEAD");
  const snapshot = () => ({ recovery: snapshotDirectory(paths.root), local: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)"), server: git(bare.dir, "for-each-ref", "--format=%(refname) %(objectname)") }); const before = snapshot();
  const local = runCli(fixture.dir, ["clean", "--dry-run"]); assert.equal(local.status, 0); assert.match(local.stdout, /capacity 10/); assert.match(local.stdout, /Would delete:\npreview/); assert.deepEqual(snapshot(), before);
  let mutations = 0; const lines: string[] = []; const remoteCode = await runRemoteClean({ history, repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: bare.dir }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/preview", branchName: "preview", oid, ageDays: 1 }] }), revalidateRemoteDeletion: async () => { mutations += 1; return []; }, deleteRemoteBranches: async () => { mutations += 1; return { stdout: "", stderr: "" }; } }, prompts: { select: async () => { mutations += 1; return []; }, confirm: async () => { mutations += 1; return false; }, input: async () => { mutations += 1; return ""; } }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, remote: "origin", dryRun: true, interactive: false });
  assert.equal(remoteCode, 0); assert.equal(mutations, 0); assert.match(lines.join("\n"), /capacity 10/); assert.match(lines.join("\n"), /Would delete from server:\norigin\/preview/); assert.deepEqual(snapshot(), before);
});

test("confirmed local cleanup uses locked local-only mutation preflight", async (t) => {
  for (const kind of ["local", "remote"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, `topic-${kind}`); const client = new GitClient(fixture.dir); const history = new UndoHistory(client); const oid = git(fixture.dir, "rev-parse", "HEAD"); const events: string[] = []; let locked = false; const acquire = history.acquire.bind(history); history.acquire = async () => { const lock = await acquire(); const release = lock.release.bind(lock); locked = true; events.push("lock"); lock.release = () => { locked = false; release(); events.push("unlock"); }; return lock; };
    const prepare = history.prepare.bind(history); history.prepare = async (...args) => { events.push("prepare:start"); const pending = await prepare(...args); const paths = await history.paths(); assert.equal(locked, true); assert.equal(JSON.parse(readFileSync(resolve(paths.operations, `${pending.id}.json`), "utf8")).state, "pending"); for (const entry of pending.entries) assert.equal(git(fixture.dir, "rev-parse", entry.backupRef), entry.oid); events.push("prepare:durable"); return pending; };
    const lines: string[] = []; const deletion = async () => { events.push("delete"); assert.equal(locked, true); assert.equal(events.at(-2), "prepare:durable"); };
    const code = kind === "local" ? await runClean({ history, repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "topic-local", commitTimestamp: new Date(0), ageDays: 1, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: true }), branchOid: async () => oid, deleteBranch: async () => deletion() }, prompts: { select: async () => ["topic-local"], confirm: async () => true }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, dryRun: false, interactive: true }) : await runRemoteClean({ history, repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: "/server.git" }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/topic-remote", branchName: "topic-remote", oid, ageDays: 1 }] }), revalidateRemoteDeletion: async (_target, selected) => [...selected], deleteRemoteBranches: async () => { await deletion(); return { stdout: "", stderr: "" }; }, remoteHeadOids: async () => new Map() }, prompts: { select: async () => ["origin/topic-remote"], confirm: async () => true, input: async () => "origin" }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, remote: "origin", dryRun: false, interactive: true });
    assert.equal(code, 0, `${kind}: ${lines.join("\n")}`); assert.deepEqual(events, ["lock", "prepare:start", "prepare:durable", "delete", "unlock"]);
  }
  for (const kind of ["local", "remote"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); let deletions = 0; history.prepare = async () => { throw new Error("injected preparation failure"); }; const oid = git(fixture.dir, "rev-parse", "HEAD"); const common = { prompts: { select: async () => [kind === "local" ? "topic" : "origin/topic"], confirm: async () => true, input: async () => "origin" }, output: { out() {}, err() {} }, dryRun: false, interactive: true };
    const code = kind === "local" ? await runClean({ ...common, history, repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "topic", commitTimestamp: new Date(0), ageDays: 1, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: true }), branchOid: async () => oid, deleteBranch: async () => { deletions += 1; } } }) : await runRemoteClean({ ...common, history, remote: "origin", repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: "/server.git" }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/topic", branchName: "topic", oid, ageDays: 1 }] }), revalidateRemoteDeletion: async (_target, selected) => [...selected], deleteRemoteBranches: async () => { deletions += 1; return { stdout: "", stderr: "" }; } } });
    assert.equal(code, 1, kind); assert.equal(deletions, 0, kind);
  }
});

test("write-ahead interruption table reconciles without recovery loss or repeated deletion", async (t) => {
  const cases = [
    { boundary: "backup-ref creation", state: "preparing", backups: 1, deleted: 0, followup: "cleanup", expected: [] },
    { boundary: "pending receipt persistence", state: "preparing", backups: 2, deleted: 0, followup: "list", expected: [] },
    { boundary: "deletion", state: "pending", backups: 2, deleted: 1, followup: "undo", expected: ["alpha"] },
    { boundary: "reconciliation", state: "pending", backups: 2, deleted: 2, followup: "discard", expected: ["alpha", "zeta"] },
    { boundary: "completed receipt persistence", state: "completed", backups: 2, deleted: 2, followup: "cleanup", expected: ["alpha", "zeta"] }
  ] as const;
  for (const [index, scenario] of cases.entries()) {
    const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "alpha"); branch(fixture.dir, "zeta"); const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths(); const oid = git(fixture.dir, "rev-parse", "HEAD"); const id = `clean-20260102T03040${index}Z-a1b${index}`; const entries = ["alpha", "zeta"].map((name) => ({ name, fullName: name, oid, backupRef: `refs/branch-care/undo/${id}/local/${name}`, restoration: "remaining" as const }));
    const receipt: UndoReceipt = { version: 1, id, state: scenario.state, kind: "local", createdAt: `2026-01-02T03:04:0${index}.000Z`, ...(scenario.state === "completed" ? { completedAt: `2026-01-02T03:05:0${index}.000Z` } : {}), entries }; replaceReceipt(resolve(paths.operations, `${id}.json`), receipt); for (const entry of entries.slice(0, scenario.backups)) git(fixture.dir, "update-ref", entry.backupRef, entry.oid); for (const entry of entries.slice(0, scenario.deleted)) git(fixture.dir, "branch", "-D", entry.name);
    let repeatedDeletes = 0; const lines: string[] = [];
    if (scenario.followup === "cleanup") assert.equal(await runClean({ history, repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [] }), revalidate: async () => ({ eligible: true }), deleteBranch: async () => { repeatedDeletes += 1; } }, prompts: { select: async () => [], confirm: async () => false }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, dryRun: false, interactive: true }), 0, scenario.boundary);
    if (scenario.followup === "list") assert.equal(await runUndo({ history, repository: {} as never, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async () => false, input: async () => "" }, interactive: true, list: true }), 0, scenario.boundary);
    if (scenario.followup === "undo") assert.equal(await runUndo({ history, repository: {} as never, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async () => false, input: async () => "" }, interactive: true, list: false }), 0, scenario.boundary);
    if (scenario.followup === "discard") assert.equal(await runUndo({ history, repository: {} as never, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async () => false, input: async () => "" }, interactive: true, list: false, discard: id }), 0, scenario.boundary);
    assert.equal(repeatedDeletes, 0, scenario.boundary); const operations = await history.list(); assert.deepEqual(operations.flatMap(({ entries: remaining }) => remaining.map(({ name }) => name)), [...scenario.expected], scenario.boundary);
    const expected = scenario.expected as readonly string[]; for (const entry of entries) { const branchExists = (() => { try { return git(fixture.dir, "rev-parse", "--verify", `refs/heads/${entry.name}`) === oid; } catch { return false; } })(); assert.equal(branchExists, !expected.includes(entry.name), `${scenario.boundary}:${entry.name}:authoritative branch`); const retained = expected.includes(entry.name); try { assert.equal(git(fixture.dir, "rev-parse", "--verify", entry.backupRef), retained ? oid : "", `${scenario.boundary}:${entry.name}:backup`); } catch { assert.equal(retained, false, `${scenario.boundary}:${entry.name}:backup missing`); } }
    if (scenario.expected.length) { assert.equal(operations[0]!.state, "completed", scenario.boundary); assert.equal(existsSync(resolve(paths.operations, `${id}.json`)), true); } else assert.equal(existsSync(resolve(paths.operations, `${id}.json`)), false, scenario.boundary);
  }
});

test("common-directory lock serializes every recovery-aware command", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await cleanOne(fixture.dir, "topic"); branch(fixture.dir, "candidate"); const history = made.history; const paths = await history.paths(); const operation = (await history.list())[0]!;
  const linked = resolve(dirname(fixture.dir), `${basename(fixture.dir)}-lock-linked`); git(fixture.dir, "worktree", "add", "-q", "--detach", linked); t.after(() => { try { git(fixture.dir, "worktree", "remove", "--force", linked); } catch {} });
  const state = () => ({ recovery: snapshotDirectory(paths.root, ["history.lock"]), refs: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/branch-care/undo") }); const before = state(); const lock = await history.acquire();
  for (const [name, cwd, args, expected] of [["cleanup", fixture.dir, ["clean"], /Interactive selection/], ["undo", linked, ["undo", operation.id], /Interactive confirmation/], ["list", linked, ["undo", "--list"], /locked/], ["discard", fixture.dir, ["undo", "--discard", operation.id], /Interactive confirmation/]] as const) { const result = runCli(cwd, [...args]); assert.equal(result.status, 1, name); assert.match(result.stderr, expected, name); assert.deepEqual(state(), before, name); }
  lock.release(); assert.equal(runCli(linked, ["undo", "--list"]).status, 0); const reacquired = await new UndoHistory(new GitClient(linked)).acquire(); reacquired.release();
});

test("history lock reclaims dead owners without stealing live owners", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths(); mkdirSync(paths.lock, { recursive: true });
  writeFileSync(resolve(paths.lock, "owner.json"), JSON.stringify({ version: 1, pid: 2147483647, token: "dead", createdAt: new Date().toISOString() }));
  const contenders = await Promise.allSettled([history.acquire(), new UndoHistory(new GitClient(fixture.dir)).acquire()]);
  const winners = contenders.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<UndoHistory["acquire"]>>> => result.status === "fulfilled");
  assert.equal(winners.length, 1); assert.match(String((contenders.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason), /live Branch Care process|changed during stale takeover|recover the stale/); winners[0]!.value.release();
  const live = await history.acquire(); await assert.rejects(new UndoHistory(new GitClient(fixture.dir)).acquire(), /live Branch Care process/); live.release();
});

test("interrupted preparation is discoverable and repairs partial backup refs", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "alpha"); branch(fixture.dir, "zeta"); const oid = git(fixture.dir, "rev-parse", "HEAD"); const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths();
  const id = "clean-20260102T030405Z-a1b2"; const entries = ["alpha", "zeta"].map((name) => ({ name, fullName: name, oid, backupRef: `refs/branch-care/undo/${id}/local/${name}`, restoration: "remaining" as const }));
  const receipt: UndoReceipt = { version: 1, id, state: "preparing", kind: "local", createdAt: "2026-01-02T03:04:05.000Z", entries }; replaceReceipt(resolve(paths.operations, `${id}.json`), receipt);
  git(fixture.dir, "update-ref", entries[0]!.backupRef, oid); git(fixture.dir, "branch", "-D", "alpha"); const [reconciled] = await history.list(); assert.equal(reconciled!.state, "completed"); assert.deepEqual(reconciled!.entries.map(({ name }) => name), ["alpha"]); assert.equal(git(fixture.dir, "rev-parse", reconciled!.entries[0]!.backupRef), oid);
});

test("pending operations are visible counted and manageable", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const oid = git(fixture.dir, "rev-parse", "HEAD");
  for (let index = 0; index < 10; index += 1) await history.prepare("local", [{ name: `pending-${index}`, fullName: `pending-${index}`, oid }]);
  assert.equal((await history.list()).length, 10); const lines: string[] = []; assert.equal(await history.assertCapacity(false, { out: (line) => lines.push(line) }), false); assert.match(lines.join("\n"), /capacity 10/);
});

test("missing or mismatched backup refs fail closed before recovery mutation", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await cleanOne(fixture.dir, "topic"); const [operation] = await made.history.list(); git(fixture.dir, "update-ref", "-d", operation!.entries[0]!.backupRef);
  await assert.rejects(made.history.list(), /missing or mismatched backup ref/); assert.equal(git(fixture.dir, "show-ref", "--verify", "refs/heads/main").length > 0, true);
});

test("durable cleanup transition survives backup-ref deletion failure", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "alpha"); branch(fixture.dir, "zeta"); let failDeletion = false;
  const client = new GitClient(fixture.dir, async (cwd, args, input) => { if (failDeletion && args[0] === "update-ref" && input?.includes("delete ")) throw new Error("injected ref deletion failure"); return nativeGitRunner(cwd, args, input); });
  const history = new UndoHistory(client); const oid = git(fixture.dir, "rev-parse", "HEAD"); const receipt = await history.prepare("local", ["alpha", "zeta"].map((name) => ({ name, fullName: name, oid }))); await history.complete(receipt, new Set(["alpha", "zeta"])); const completed = (await history.list())[0]!;
  failDeletion = true; await assert.rejects(history.retain(completed, [completed.entries[0]!]), /injected ref deletion failure/); const stored = JSON.parse(readFileSync(resolve((await history.paths()).operations, `${completed.id}.json`), "utf8")) as UndoReceipt; assert.equal(stored.state, "local-retry"); assert.equal(stored.cleanupEntries?.length, 1); assert.equal(git(fixture.dir, "rev-parse", stored.entries[0]!.backupRef), stored.entries[0]!.oid);
  failDeletion = false; const [recovered] = await history.list(); assert.equal(recovered!.cleanupEntries, undefined); assert.equal(recovered!.entries.length, 1);
});

test("interrupted local restoration consumes restored refs and retains only retryable outcomes", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "alpha"); branch(fixture.dir, "zeta"); const history = new UndoHistory(new GitClient(fixture.dir)); const oid = git(fixture.dir, "rev-parse", "HEAD");
  const prepared = await history.prepare("local", ["alpha", "zeta"].map((name) => ({ name, fullName: name, oid }))); git(fixture.dir, "branch", "-D", "alpha"); git(fixture.dir, "branch", "-D", "zeta"); const completed = (await history.complete(prepared, new Set(["alpha", "zeta"])))!;
  await history.beginRestore(completed); git(fixture.dir, "update-ref", "refs/heads/alpha", oid, "");
  const [retry] = await history.list(); assert.equal(retry!.state, "local-retry"); assert.deepEqual(retry!.entries.map(({ name }) => name), ["zeta"]); assert.equal(git(fixture.dir, "rev-parse", "refs/heads/alpha"), oid);
});

test("interrupted atomic remote restoration reconciles to consumed or retryable from pinned inventory", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const oid = git(fixture.dir, "rev-parse", "HEAD");
  const prepared = await history.prepare("remote", [{ name: "topic", fullName: "origin/topic", oid }], { name: "origin", endpoint: "/pinned.git", urls: [] }); const completed = (await history.complete(prepared, new Set(["topic"])))!; const restoring = await history.beginRestore(completed);
  assert.equal((await history.reconcileRemote(restoring, new Map()))!.state, "completed"); const retried = (await history.list())[0]!; const restoringAgain = await history.beginRestore(retried); assert.equal(await history.reconcileRemote(restoringAgain, new Map([["topic", oid]])), undefined); assert.deepEqual(await history.list(), []);
});

test("cleanup dry-run is recovery-read-only and never reconciles", async (t) => {
  for (const command of ["local", "remote"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "candidate"); const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths(); const oid = git(fixture.dir, "rev-parse", "HEAD");
    for (const [index, state] of (["pending", "preparing", "consuming", "abandoning"] as const).entries()) {
      const id = `clean-20260102T03040${index}Z-a1b${index}`; const name = `${state}-${command}`; const backupRef = `refs/branch-care/undo/${id}/${command === "remote" ? "remote" : "local"}/${name}`;
      const receipt: UndoReceipt = { version: 1, id, state, kind: command, ...(command === "remote" ? { remote: "origin", remoteEndpoint: "/pinned/repository.git", urls: ["https://user:token@example.test/private.git"] } : {}), createdAt: `2026-01-02T03:04:0${index}.000Z`, entries: [{ name, fullName: command === "remote" ? `origin/${name}` : name, oid, backupRef, restoration: "remaining" }] };
      replaceReceipt(resolve(paths.operations, `${id}.json`), receipt); git(fixture.dir, "update-ref", backupRef, oid);
    }
    const beforeRecovery = snapshotDirectory(paths.root); const beforeRefs = git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/branch-care/undo"); assert.equal(existsSync(paths.lock), false);
    const lines: string[] = [];
    const code = command === "local"
      ? await runClean({ history, repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "candidate", commitTimestamp: new Date(0), ageDays: 1, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: true }), deleteBranch: async () => {} }, dryRun: true, interactive: false, prompts: { select: async () => [], confirm: async () => false }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) } })
      : await runRemoteClean({ history, repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: "/current/repository.git" }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [{ fullName: "origin/candidate", branchName: "candidate", oid, ageDays: 1 }] }), revalidateRemoteDeletion: async (_target, selected) => [...selected], deleteRemoteBranches: async () => ({ stdout: "", stderr: "" }), remoteHeadOids: async () => { throw new Error("dry-run must not reconcile"); } }, remote: "origin", dryRun: true, interactive: false, prompts: { select: async () => [], confirm: async () => false, input: async () => "" }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) } });
    assert.equal(code, 0, lines.join("\n")); assert.equal(snapshotDirectory(paths.root), beforeRecovery); assert.equal(git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/branch-care/undo"), beforeRefs); assert.equal(existsSync(paths.lock), false);
  }
});

test("confirmed remote cleanup uses locked selected-remote mutation preflight", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const oid = git(fixture.dir, "rev-parse", "HEAD");
  await history.prepare("remote", [{ name: "topic", fullName: "origin/topic", oid }], { name: "origin", endpoint: "/origin.git", urls: [] });
  await history.prepare("remote", [{ name: "other", fullName: "upstream/other", oid }], { name: "upstream", endpoint: "/upstream.git", urls: [] });
  const calls: string[] = []; const lock = await history.acquire();
  try { await history.reconcileRemoteTarget("origin", "/origin.git", async () => { calls.push("/origin.git"); return new Map(); }); } finally { lock.release(); }
  assert.deepEqual(calls, ["/origin.git"]); const remaining = await history.listReadOnly(); assert.equal(remaining.length, 2); assert.equal(remaining.find(({ remote }) => remote === "origin")!.state, "completed"); assert.equal(remaining.find(({ remote }) => remote === "upstream")!.state, "pending");
});

test("cleanup mutation preflight failure table prevents deletion and preserves recovery", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic"); const history = new UndoHistory(new GitClient(fixture.dir)); const before = refs(fixture.dir); let deletions = 0;
  history.acquire = async () => { throw new Error("injected lock failure https://user:secret@example.test/repo.git"); };
  const out: string[] = []; const err: string[] = []; const code = await runClean({ history, repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "topic", commitTimestamp: new Date(0), ageDays: 1, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: true }), deleteBranch: async () => { deletions += 1; } }, prompts: { select: async () => ["topic"], confirm: async () => true }, output: { out: (line) => out.push(line), err: (line) => err.push(line) }, dryRun: false, interactive: true });
  assert.equal(code, 1); assert.equal(deletions, 0); assert.equal(refs(fixture.dir), before); assert.match(err.join("\n"), /injected lock failure/); assert.doesNotMatch(err.join("\n"), /user:secret/);
});

test("unsafe branch names are rejected before receipts or update-ref input", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const oid = git(fixture.dir, "rev-parse", "HEAD");
  await assert.rejects(history.prepare("local", [{ name: "bad name\ncreate refs/heads/pwned", fullName: "bad name\ncreate refs/heads/pwned", oid }]), /Invalid undo receipt entry|Unsafe Git ref/);
  assert.equal((await history.list()).length, 0); assert.throws(() => git(fixture.dir, "show-ref", "--verify", "refs/heads/pwned"));
});
