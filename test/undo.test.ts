import assert from "node:assert/strict";
import test from "node:test";
import { runUndo } from "../src/commands/undo.js";

test("discard no-op and failure table preserves recoverability", async () => {
  const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "local" as const, createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "topic", oid: "a".repeat(40), backupRef: "refs/branch-care/undo/clean-20260102T030405Z-a1b2/local/topic", restoration: "remaining" as const }] };
  const cases = [
    { name: "declined", interactive: true, confirm: async () => false, status: 0, message: /not discarded/, removes: 0 },
    { name: "cancelled", interactive: true, confirm: async (): Promise<boolean> => { throw Object.assign(new Error("cancelled"), { name: "ExitPromptError" }); }, status: 0, message: /not discarded/, removes: 0 },
    { name: "non-interactive", interactive: false, confirm: async () => true, status: 1, message: /Interactive confirmation/, removes: 0 },
    { name: "unknown", interactive: true, confirm: async () => true, status: 1, message: /No cleanup operation/, removes: 0, selectError: new Error("No cleanup operation 'unknown' is available to undo.") },
    { name: "locked", interactive: true, confirm: async () => true, status: 1, message: /locked/, removes: 0, lockError: new Error("Undo history is locked") },
    { name: "ref-removal failure", interactive: true, confirm: async () => true, status: 1, message: /ref removal failed/, removes: 1, removeError: new Error("ref removal failed") },
    { name: "receipt-removal failure", interactive: true, confirm: async () => true, status: 1, message: /receipt removal failed/, removes: 1, removeError: new Error("receipt removal failed") }
  ];
  for (const scenario of cases) {
    let removes = 0; let releases = 0; const lines: string[] = [];
    const history = { acquire: async () => { if (scenario.lockError) throw scenario.lockError; return { release() { releases += 1; } }; }, reconcilePending: async () => [operation], select: async () => { if (scenario.selectError) throw scenario.selectError; return operation; }, remove: async () => { removes += 1; if (scenario.removeError) throw scenario.removeError; } } as never;
    const code = await runUndo({ history, repository: {} as never, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: scenario.confirm, input: async () => "" }, interactive: scenario.interactive, list: false, discard: scenario.name === "unknown" ? "unknown" : operation.id });
    assert.equal(code, scenario.status, scenario.name); assert.equal(removes, scenario.removes, scenario.name); assert.match(lines.join("\n"), scenario.message, scenario.name); assert.equal(releases, scenario.lockError ? 0 : 1, scenario.name);
  }
});

test("remote undo pins the verified endpoint and retains original redaction URLs", async () => {
  const secret = "https://user:token@example.test/private.git"; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "remote" as const, remote: "origin", remoteEndpoint: "/verified.git", urls: [secret], createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "origin/topic", oid: "a".repeat(40), backupRef: "refs/branch-care/undo/clean-20260102T030405Z-a1b2/remote/topic", restoration: "remaining" as const }] };
  const history = { acquire: async () => ({ release() {} }), reconcilePending: async () => [operation], select: async () => operation, objectExists: async () => true } as never; const errors: string[] = []; let pushes = 0;
  const changed = await runUndo({ history, repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [secret], inventoryRepository: "/changed.git" }), remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => { pushes += 1; return { stdout: "", stderr: "" }; } }, output: { out() {}, err: (line) => errors.push(line) }, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
  assert.equal(changed, 1); assert.equal(pushes, 0); assert.match(errors.join("\n"), /push destination changed/);
  errors.length = 0; const failedResolve = await runUndo({ history, repository: { resolveRemoteDeletionTarget: async () => { throw new Error(`failed at ${secret}`); }, remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => ({ stdout: "", stderr: "" }) }, output: { out() {}, err: (line) => errors.push(line) }, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
  assert.equal(failedResolve, 1); assert.match(errors.join("\n"), /<remote>/); assert.doesNotMatch(errors.join("\n"), /user:token|example\.test/);
});

test("remote undo previews in order and re-resolves after two confirmations", async () => {
  const calls: string[] = []; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "remote" as const, remote: "origin", remoteEndpoint: "origin", urls: [], createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: ["zeta", "alpha"].map((name) => ({ name, fullName: `origin/${name}`, oid: "a".repeat(40), backupRef: `refs/branch-care/undo/clean-20260102T030405Z-a1b2/remote/${name}`, restoration: "remaining" as const })) };
  const history = { acquire: async () => ({ release() {} }), reconcilePending: async () => [operation], select: async () => operation, objectExists: async () => true, beginRestore: async () => operation, remove: async () => { calls.push("remove"); } } as never;
  const repository = { resolveRemoteDeletionTarget: async () => { calls.push("resolve"); return { name: "origin", urls: [], inventoryRepository: "origin" }; }, remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => { calls.push("push"); return { stdout: "", stderr: "" }; } };
  const lines: string[] = []; let prompts = 0; const code = await runUndo({ history, repository, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async (options) => { prompts += 1; calls.push("confirm"); assert.equal(options.default, false); return true; }, input: async (options) => { prompts += 1; calls.push("type"); assert.match(options.message, /origin/); return "origin"; } }, interactive: true, list: false });
  assert.equal(code, 0); assert.equal(prompts, 2); assert.deepEqual(calls, ["confirm", "type", "resolve", "push", "remove"]); assert.ok(lines.indexOf(`${operation.entries[1]!.fullName} ${operation.entries[1]!.oid}`) < lines.indexOf(`${operation.entries[0]!.fullName} ${operation.entries[0]!.oid}`));
});
