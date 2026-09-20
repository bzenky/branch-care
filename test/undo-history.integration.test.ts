import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { GitClient, nativeGitRunner } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { replaceReceipt, UndoHistory, type UndoReceipt } from "../src/undo-history.js";
import { branch, git, makeRepo, refs, runCli } from "./helpers.js";

async function cleanOne(dir: string, name: string) {
  branch(dir, name); const client = new GitClient(dir); const repository = new Repository(client); const history = new UndoHistory(client); const lines: string[] = [];
  const code = await runClean({ repository, history, dryRun: false, interactive: true, prompts: { select: async () => [name], confirm: async () => true }, output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) } });
  return { code, lines, history };
}

test("no deletion and failed remote push leave no completed recovery data", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const client = new GitClient(fixture.dir); const history = new UndoHistory(client);
  assert.equal(runCli(fixture.dir, ["clean", "--dry-run"]).status, 0); assert.deepEqual(await history.list(), []);
});

test("history retains ten distinct operations without eviction", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (let index = 0; index < 10; index += 1) { const result = await cleanOne(fixture.dir, `topic-${index}`); assert.equal(result.code, 0, result.lines.join("\n")); }
  const operations = await new UndoHistory(new GitClient(fixture.dir)).list(); assert.equal(operations.length, 10); assert.equal(new Set(operations.map(({ id }) => id)).size, 10);
  assert.equal(operations.every(({ entries }) => entries.length === 1), true);
});

test("recovery namespace and lock are shared by linked worktrees", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); assert.equal(result.code, 0);
  const linked = resolve(fixture.dir, "..", `${fixture.dir.split("/").at(-1)}-linked`); git(fixture.dir, "worktree", "add", "-q", "--detach", linked); t.after(() => { try { git(fixture.dir, "worktree", "remove", "--force", linked); } catch {} });
  const second = new UndoHistory(new GitClient(linked)); assert.equal((await second.list()).length, 1);
  const lock = await result.history.acquire(); await assert.rejects(second.acquire(), /locked/); lock.release(); const next = await second.acquire(); next.release();
});

test("full history blocks real local and remote cleanup before side effects", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); for (let index = 0; index < 10; index += 1) await cleanOne(fixture.dir, `topic-${index}`);
  branch(fixture.dir, "eleventh"); const before = refs(fixture.dir); const result = runCli(fixture.dir, ["clean"]); assert.equal(result.status, 1); assert.match(result.stderr + result.stdout, /capacity 10|Interactive/); assert.equal(refs(fixture.dir), before);
});

test("full history dry-runs preserve previews and report cleanup block", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); for (let index = 0; index < 10; index += 1) await cleanOne(fixture.dir, `topic-${index}`); branch(fixture.dir, "preview");
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assert.equal(result.status, 0); assert.match(result.stdout, /capacity 10/); assert.match(result.stdout, /Would delete:\npreview/);
});

test("cleanup completes lock backup and pending receipt before deletion", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); assert.equal(result.code, 0);
  const [operation] = await result.history.list(); assert.ok(operation); assert.equal(operation.state, "completed"); assert.equal(git(fixture.dir, "rev-parse", operation.entries[0]!.backupRef), operation.entries[0]!.oid);
});

test("write-ahead interruption table reconciles without recovery loss or repeated deletion", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); const [operation] = await result.history.list(); assert.ok(operation); assert.equal(existsSync((await result.history.paths()).operations), true);
});

test("common-directory lock serializes every recovery-aware command", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const lock = await history.acquire();
  const result = runCli(fixture.dir, ["undo", "--list"]); assert.equal(result.status, 1); assert.match(result.stderr, /locked/); lock.release(); assert.equal(runCli(fixture.dir, ["undo", "--list"]).status, 0);
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

test("unsafe branch names are rejected before receipts or update-ref input", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const oid = git(fixture.dir, "rev-parse", "HEAD");
  await assert.rejects(history.prepare("local", [{ name: "bad name\ncreate refs/heads/pwned", fullName: "bad name\ncreate refs/heads/pwned", oid }]), /Invalid undo receipt entry|Unsafe Git ref/);
  assert.equal((await history.list()).length, 0); assert.throws(() => git(fixture.dir, "show-ref", "--verify", "refs/heads/pwned"));
});
