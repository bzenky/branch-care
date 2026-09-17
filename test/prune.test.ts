import assert from "node:assert/strict";
import test from "node:test";
import { runPrune, type PrunePrompts, type PruneRepository } from "../src/commands/prune.js";
import { GitClient, type GitResult, type GitRunner } from "../src/git/client.js";
import { parsePruneFetchRefspec } from "../src/git/repository.js";
import type { PruneTarget } from "../src/types.js";

const target: PruneTarget = {
  name: "origin",
  urls: ["https://secret@example.test/private.git", "ssh://example.test/private.git"]
};

function setup(overrides: Partial<PruneRepository> = {}) {
  const calls: string[] = [];
  const repository: PruneRepository = {
    resolvePruneTarget: async () => target,
    previewPrune: async () => { calls.push("preview"); return { stdout: "", stderr: "" }; },
    executePrune: async () => { calls.push("execute"); return { stdout: "", stderr: "" }; },
    ...overrides
  };
  const out: string[] = [];
  const err: string[] = [];
  const output = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const prompts: PrunePrompts = { confirm: async () => false };
  return { repository, calls, out, err, output, prompts };
}

function options(fixture: ReturnType<typeof setup>, overrides: Partial<Parameters<typeof runPrune>[0]> = {}): Parameters<typeof runPrune>[0] {
  return {
    repository: fixture.repository,
    prompts: fixture.prompts,
    output: fixture.output,
    dryRun: true,
    interactive: false,
    ...overrides
  };
}

test("prune accepts only selected remote tracking refspec destinations", () => {
  assert.deepEqual(parsePruneFetchRefspec("origin", "+refs/heads/*:refs/remotes/origin/*"), {
    references: ["refs/heads/*", "refs/remotes/origin/*"], negative: false
  });
  assert.deepEqual(parsePruneFetchRefspec("origin", "refs/heads/main:refs/remotes/origin/main"), {
    references: ["refs/heads/main", "refs/remotes/origin/main"], negative: false
  });
  assert.deepEqual(parsePruneFetchRefspec("origin", "^refs/heads/private/*"), {
    references: ["refs/heads/private/*"], negative: true
  });
  for (const refspec of [
    "refs/heads/*:refs/tags/*",
    "refs/heads/*:refs/heads/*",
    "refs/heads/*:refs/remotes/upstream/*",
    "refs/heads/*:refs/custom/*"
  ]) assert.throws(() => parsePruneFetchRefspec("origin", refspec), /Unsafe fetch configuration for remote 'origin'/);
});

test("prune dry-run uses the exact bounded Git operation", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
  const client = new GitClient("/tmp/repository", runner);
  await client.fetchPrune("origin", true);
  assert.deepEqual(calls, [[
    "fetch", "--prune", "--dry-run", "--atomic", "--no-tags", "--no-recurse-submodules",
    "--no-write-fetch-head", "--no-progress", "--", "origin"
  ]]);
});

test("prune preview redacts configured remote URLs", async () => {
  const fixture = setup({
    previewPrune: async () => ({
      stdout: `updated https://secret@example.test/private.git\n`,
      stderr: `From ssh://example.test/private.git\n - [deleted] old\nnotice https://secret@example.test/private.git\n`
    })
  });
  const code = await runPrune(options(fixture));
  assert.equal(code, 0);
  assert.equal(fixture.err.join("\n"), "");
  assert.equal(fixture.out.join("\n"), [
    "Prune preview: origin", " - [deleted] old", "notice <remote>", "updated <remote>", "Dry run: no refs were changed."
  ].join("\n"));
  assert.doesNotMatch(fixture.out.join("\n"), /secret@|ssh:\/\/|example\.test/);
});

test("prune preview renders the exact empty state", async () => {
  const fixture = setup({ previewPrune: async () => ({ stdout: "\n", stderr: "From https://secret@example.test/private.git\n" }) });
  const code = await runPrune(options(fixture));
  assert.equal(code, 0);
  assert.equal(fixture.out.join("\n"), "Prune preview: origin\n(no ref changes)\nDry run: no refs were changed.");
});

test("prune dry-run stops after one preview", async () => {
  const fixture = setup();
  const code = await runPrune(options(fixture));
  assert.equal(code, 0);
  assert.deepEqual(fixture.calls, ["preview"]);
  assert.equal(fixture.out.at(-1), "Dry run: no refs were changed.");
});

test("prune confirmation names the remote and defaults to no", async () => {
  const fixture = setup(); let observed: unknown;
  const prompts: PrunePrompts = { confirm: async (value) => { observed = value; return false; } };
  const code = await runPrune(options(fixture, { dryRun: false, interactive: true, prompts }));
  assert.equal(code, 0);
  assert.deepEqual(observed, { message: "Apply fetch and prune for 'origin'?", default: false });
  assert.deepEqual(fixture.calls, ["preview"]);
});

test("prune decline and cancellation are safe no-ops", async () => {
  const declined = setup();
  assert.equal(await runPrune(options(declined, { dryRun: false, interactive: true })), 0);
  assert.deepEqual(declined.calls, ["preview"]);
  assert.equal(declined.out.at(-1), "No refs were changed.");

  const cancelled = setup();
  const cancellation = new Error("cancelled"); cancellation.name = "ExitPromptError";
  const prompts: PrunePrompts = { confirm: async () => { throw cancellation; } };
  assert.equal(await runPrune(options(cancelled, { dryRun: false, interactive: true, prompts })), 0);
  assert.deepEqual(cancelled.calls, ["preview"]);
  assert.equal(cancelled.out.at(-1), "No refs were changed.");
});

test("prune confirmation executes the exact bounded Git operation", async () => {
  const gitCalls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { gitCalls.push([...args]); return { stdout: "", stderr: "" }; };
  await new GitClient("/tmp/repository", runner).fetchPrune("origin", false);
  assert.deepEqual(gitCalls, [[
    "fetch", "--prune", "--atomic", "--no-tags", "--no-recurse-submodules",
    "--no-write-fetch-head", "--no-progress", "--", "origin"
  ]]);

  const fixture = setup();
  const prompts: PrunePrompts = { confirm: async () => true };
  const code = await runPrune(options(fixture, { dryRun: false, interactive: true, prompts }));
  assert.equal(code, 0);
  assert.deepEqual(fixture.calls, ["preview", "execute"]);
  assert.equal(fixture.out.at(-1), "Pruned remote 'origin'.");
});

test("prune execution failure is atomic redacted and never successful", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
  await new GitClient("/tmp/repository", runner).fetchPrune("origin", false);
  assert.ok(calls[0]?.includes("--atomic"));

  const fixture = setup({
    executePrune: async () => { throw new Error("failed at https://secret@example.test/private.git"); }
  });
  const prompts: PrunePrompts = { confirm: async () => true };
  const code = await runPrune(options(fixture, { dryRun: false, interactive: true, prompts }));
  assert.equal(code, 1);
  assert.equal(fixture.err.join("\n"), "Failed to prune remote 'origin': failed at <remote>");
  assert.doesNotMatch(fixture.out.join("\n"), /Pruned remote/);
  assert.doesNotMatch(fixture.err.join("\n"), /secret@|example\.test/);
});
