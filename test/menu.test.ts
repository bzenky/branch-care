import assert from "node:assert/strict";
import test from "node:test";
import { menuChoices, runMenu, type MenuAction, type MenuChoice, type MenuOptions } from "../src/index.js";
import type { RepositoryAnalysis } from "../src/types.js";

const context: RepositoryAnalysis = {
  repositoryName: "fixture",
  baseBranch: "main",
  baseSource: "main",
  currentBranch: "main",
  staleAfterDays: 60,
  branches: []
};

function cancellation(): Error {
  const error = new Error("cancelled"); error.name = "ExitPromptError"; return error;
}

function setup(action: MenuAction, remotes: string[] = []): { options: MenuOptions; calls: string[]; out: string[]; err: string[] } {
  const calls: string[] = []; const out: string[] = []; const err: string[] = [];
  const runner = (name: string, code: number) => async (...args: unknown[]) => { calls.push(`${name}:${JSON.stringify(args)}`); return code; };
  return {
    calls, out, err,
    options: {
      repository: {
        analyze: async (base) => { calls.push(`analyze:${base ?? ""}`); return context; },
        configuredRemotes: async () => { calls.push("remotes"); return remotes; }
      },
      base: "chosen",
      prompts: {
        action: async (choices) => { calls.push(`actions:${choices.map(({ name }) => name).join("|")}`); return action; },
        remote: async (choices) => { calls.push(`remote:${choices.map(({ name }) => name).join("|")}`); return choices[0]!.value; }
      },
      runners: {
        status: runner("status", 10), clean: runner("clean", 11), remoteStatus: runner("remote", 12),
        prune: runner("prune", 13), remoteClean: runner("remote-clean", 14), config: runner("config", 15)
      },
      output: { out: (line) => out.push(line), err: (line) => err.push(line) }
    }
  };
}

test("menu dispatcher covers every action once and preserves results", async () => {
  assert.deepEqual(menuChoices.map(({ name }) => name), [
    "Show local status", "Clean local branches", "Show remote status", "Prune remote-tracking references",
    "Clean remote branches", "Show repository configuration", "Exit"
  ]);
  const cases: Array<[MenuAction, number, string | undefined]> = [
    ["status", 10, "status:[\"chosen\"]"], ["clean", 11, "clean:[\"chosen\"]"],
    ["remote", 12, "remote:[\"chosen\"]"], ["prune", 13, "prune:[null]"],
    ["remote-clean", 14, "remote-clean:[null,\"chosen\"]"], ["config", 15, "config:[]"]
  ];
  for (const [action, code, expected] of cases) {
    const fixture = setup(action);
    assert.equal(await runMenu(fixture.options), code, action);
    assert.equal(fixture.calls.filter((call) => call === expected).length, 1, `${action}: ${fixture.calls.join("\n")}`);
    assert.equal(fixture.calls.filter((call) => /^(status|clean|remote|prune|remote-clean|config):/.test(call)).length, 1);
  }
  const exited = setup("exit"); assert.equal(await runMenu(exited.options), 0);
  assert.deepEqual(exited.out.slice(-1), ["No action was run."]);
  assert.equal(exited.calls.some((call) => /^(status|clean|remote|prune|remote-clean|config):/.test(call)), false);

  const cancelled = setup("status");
  cancelled.options.prompts.action = async () => { throw cancellation(); };
  assert.equal(await runMenu(cancelled.options), 0);
  assert.deepEqual(cancelled.out.slice(-1), ["No action was run."]);
});

test("menu propagates one delegated failure without retry", async () => {
  const fixture = setup("status");
  fixture.options.runners.status = async () => { fixture.calls.push("failed-status"); throw new Error("delegated failure"); };
  assert.equal(await runMenu(fixture.options), 1);
  assert.deepEqual(fixture.err, ["delegated failure"]);
  assert.equal(fixture.calls.filter((call) => call.startsWith("actions:")).length, 1);
  assert.equal(fixture.calls.filter((call) => call === "failed-status").length, 1);
});

test("menu remote resolver covers zero one many and cancellation", async () => {
  for (const action of ["prune", "remote-clean"] as const) {
    const zero = setup(action, []); assert.equal(await runMenu(zero.options), action === "prune" ? 13 : 14);
    assert.equal(zero.calls.some((call) => call.startsWith("remote:")), false);
    assert.ok(zero.calls.includes(action === "prune" ? "prune:[null]" : "remote-clean:[null,\"chosen\"]"));

    const one = setup(action, ["origin"]); assert.equal(await runMenu(one.options), action === "prune" ? 13 : 14);
    assert.equal(one.calls.some((call) => call.startsWith("remote:")), false);
    assert.ok(one.calls.includes(action === "prune" ? "prune:[\"origin\"]" : "remote-clean:[\"origin\",\"chosen\"]"));

    const many = setup(action, ["zeta", "beta", "Alpha", "beta"]); assert.equal(await runMenu(many.options), action === "prune" ? 13 : 14);
    assert.ok(many.calls.includes("remote:Alpha|beta|zeta"));
    assert.ok(many.calls.includes(action === "prune" ? "prune:[\"Alpha\"]" : "remote-clean:[\"Alpha\",\"chosen\"]"));

    const cancelled = setup(action, ["origin", "upstream"]);
    cancelled.options.prompts.remote = async (_choices: readonly MenuChoice<string>[]) => { throw cancellation(); };
    assert.equal(await runMenu(cancelled.options), 0);
    assert.deepEqual(cancelled.out.slice(-1), ["No action was run."]);
    assert.equal(cancelled.calls.some((call) => call.startsWith(`${action}:`)), false);
  }
});
