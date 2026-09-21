import assert from "node:assert/strict";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { assertExit, branch, makeDirectory, makeRepo, refs, runCli, runCliInteractive } from "./helpers.js";

test("public command success and no-op stream matrix", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const cases = [
    ["root help", ["--help"]], ["version", ["--version"]], ["status", ["status"]],
    ["status JSON", ["status", "--json"]], ["remote", ["remote"]], ["config", ["config"]],
    ["prune preview", ["prune", "--dry-run"]], ["local cleanup preview", ["clean", "--dry-run"]],
    ["remote cleanup preview", ["clean", "--remote", "--dry-run"]], ["undo list", ["undo", "--list"]]
  ] as const;
  for (const [name, args] of cases) {
    const result = runCli(fixture.dir, [...args]); assertExit(result, 0);
    assert.notEqual(result.stdout, "", name); assert.equal(result.stderr, "", name);
  }
});

test("public command operational failure stream matrix", (t) => {
  const directory = makeDirectory(); t.after(directory.cleanup);
  for (const args of [["status"], ["status", "--json"], ["remote"], ["config"], ["prune", "--dry-run"], ["clean", "--dry-run"], ["clean", "--remote", "--dry-run"], ["undo", "--list"]]) {
    const result = runCli(directory.dir, args); assertExit(result, 1);
    assert.equal(result.stdout, "", args.join(" ")); assert.notEqual(result.stderr, "", args.join(" "));
  }
});

test("partial local mutation separates progress diagnostics and retry state", async () => {
  const out: string[] = []; const err: string[] = [];
  const code = await runClean({
    repository: {
      analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: ["alpha", "zeta"].map((name) => ({ name, commitTimestamp: new Date(0), ageDays: 100, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true })) }),
      revalidate: async () => ({ eligible: true }), branchOid: async () => "a".repeat(40),
      deleteBranch: async (name) => { if (name === "zeta") throw new Error("injected deletion failure"); }
    },
    prompts: { select: async () => ["alpha", "zeta"], confirm: async () => true },
    output: { out: (line) => out.push(line), err: (line) => err.push(line) }, dryRun: false, interactive: true
  });
  assert.equal(code, 1); assert.match(out.join("\n"), /Deleted alpha.*Deleted 1 branch\./s);
  assert.match(err.join("\n"), /Failed zeta: injected deletion failure/);
});

test("public usage error matrix rejects before all work", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const before = refs(fixture.dir);
  const cases = [["unknown"], ["status", "--base"], ["clean", "--older-than", "0d"], ["undo", "bad-id"], ["undo", "--list", "clean-20260102T030405Z-a1"]];
  for (const args of cases) { const result = runCli(fixture.dir, args); assertExit(result, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:|invalid|mutually exclusive/i); }
  assert.equal(refs(fixture.dir), before);
});

test("standalone cleanup and prune PTY cancellation boundaries are no-ops", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic"); const before = refs(fixture.dir);
  const selection = await runCliInteractive(fixture.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\u0003" }]);
  assertExit(selection, 0); assert.match(selection.stdout, /No branches were removed/); assert.equal(refs(fixture.dir), before);
  const confirmation = await runCliInteractive(fixture.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "\u0003" }]);
  assertExit(confirmation, 0); assert.match(confirmation.stdout, /No branches were removed/); assert.equal(refs(fixture.dir), before);
});

test("standalone undo PTY cancellation boundaries preserve recovery", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic");
  const created = await runCliInteractive(fixture.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "y\r" }]);
  assertExit(created, 0); const before = refs(fixture.dir);
  const cancelled = await runCliInteractive(fixture.dir, ["undo"], [{ waitFor: "Restore 1 branch?", input: "\u0003" }]);
  assertExit(cancelled, 0); assert.match(cancelled.stdout, /No branches were restored/); assert.equal(refs(fixture.dir), before);
});
