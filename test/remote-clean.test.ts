import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runRemoteClean, type RemoteCleanPrompts, type RemoteCleanRepository } from "../src/commands/remote-clean.js";
import { GitClient, nativeGitRunner, type GitRunner } from "../src/git/client.js";
import { Repository, validateRemoteDeleteFetchRefspecs } from "../src/git/repository.js";
import type { RemoteDeleteAnalysis, RemoteDeleteCandidate } from "../src/types.js";
import { branch, commit, git, makeEmptyDirectory, makeRepo } from "./helpers.js";

const alpha: RemoteDeleteCandidate = { fullName: "origin/alpha", branchName: "alpha", oid: "a".repeat(40) };
const beta: RemoteDeleteCandidate = { fullName: "origin/beta", branchName: "beta", oid: "b".repeat(40) };

function analysis(candidates: RemoteDeleteCandidate[] = [beta, alpha]): RemoteDeleteAnalysis {
  return { remote: "origin", urls: ["https://secret@example.test/repo.git"], candidates };
}

function setup(overrides: Partial<RemoteCleanRepository> = {}) {
  const calls: string[] = [];
  const repository: RemoteCleanRepository = {
    resolveRemoteDeletionTarget: async (remote) => ({ name: remote ?? "origin", urls: ["https://secret@example.test/repo.git"], inventoryRepository: remote ?? "origin" }),
    analyzeRemoteDeletion: async () => { calls.push("analyze"); return analysis(); },
    revalidateRemoteDeletion: async (_remote, selected) => { calls.push("revalidate"); return [...selected]; },
    deleteRemoteBranches: async () => { calls.push("push"); return { stdout: "", stderr: "" }; },
    ...overrides
  };
  const lines: string[] = [];
  const prompts: RemoteCleanPrompts = {
    select: async () => [], confirm: async () => false, input: async () => ""
  };
  return {
    repository, calls, lines, prompts,
    output: { out: (line: string) => lines.push(line), err: (line: string) => lines.push(`ERR:${line}`) }
  };
}

function options(fixture: ReturnType<typeof setup>, overrides: Partial<Parameters<typeof runRemoteClean>[0]> = {}): Parameters<typeof runRemoteClean>[0] {
  return {
    repository: fixture.repository, prompts: fixture.prompts, output: fixture.output,
    dryRun: true, interactive: false, ...overrides
  };
}

test("remote clean resolves every one-remote selection state", async () => {
  const observed: Array<string | undefined> = [];
  const fixture = setup({
    resolveRemoteDeletionTarget: async (remote) => {
      observed.push(remote);
      if (remote === "missing") throw new Error("Remote 'missing' is not configured.");
      if (remote === "ambiguous") throw new Error("Multiple remotes are configured: Alpha, zeta. Use --remote <name>.");
      if (remote === "zero") return undefined;
      return { name: remote ?? "origin", urls: [], inventoryRepository: remote ?? "origin" };
    },
    analyzeRemoteDeletion: async (remote) => ({ remote: remote ?? "origin", urls: [], candidates: [] })
  });
  for (const [remote, code] of [["origin", 0], [undefined, 0], ["zero", 0], ["missing", 1], ["ambiguous", 1]] as const) {
    assert.equal(await runRemoteClean(options(fixture, { remote })), code);
  }
  assert.deepEqual(observed, ["origin", undefined, "zero", "missing", "ambiguous"]);
  assert.match(fixture.lines.join("\n"), /No remotes are configured\./);
  assert.match(fixture.lines.join("\n"), /Remote 'missing' is not configured\./);
  assert.match(fixture.lines.join("\n"), /Multiple remotes are configured: Alpha, zeta/);
});

test("remote clean mapping table accepts only one-to-one branch mappings", () => {
  assert.doesNotThrow(() => validateRemoteDeleteFetchRefspecs("origin", [
    "+refs/heads/*:refs/remotes/origin/*", "^refs/heads/private/*"
  ]));
  assert.doesNotThrow(() => validateRemoteDeleteFetchRefspecs("origin", ["refs/heads/*:refs/remotes/origin/*"]));
  const invalid: string[][] = [
    [], ["bad"],
    ["refs/heads/*:refs/remotes/origin/*", "refs/heads/release/*:refs/remotes/origin/release/*"],
    ["refs/heads/topic:refs/remotes/origin/topic"],
    ["refs/heads/*:refs/remotes/origin/renamed/*"],
    ["refs/heads/*:refs/remotes/upstream/*"],
    ["refs/heads/*:refs/remotes/origin/*", "^bad:negative"]
  ];
  for (const refspecs of invalid) {
    assert.throws(() => validateRemoteDeleteFetchRefspecs("origin", refspecs), /Unsafe (fetch configuration|remote deletion mapping)/);
  }
});

test("remote clean server inventory uses quiet symbolic ls-remote", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
  await new GitClient("/tmp/repository", runner).listRemoteHeads("origin");
  assert.deepEqual(calls, [["ls-remote", "--symref", "--quiet", "--", "origin", "HEAD", "refs/heads/*"]]);
  assert.doesNotMatch(calls.flat().join(" "), /https?:\/\//);
});

test("remote clean candidates are ordered unique and empty-safe", async () => {
  const populated = setup({ analyzeRemoteDeletion: async () => analysis([beta, alpha, beta]) });
  assert.equal(await runRemoteClean(options(populated)), 0);
  assert.equal(populated.lines.join("\n"), [
    "Remote dry run\nRemote: origin\n\nWould delete from server:\norigin/alpha\norigin/beta\n\nNo remote branches were removed."
  ].join("\n"));

  let prompts = 0;
  const empty = setup({ analyzeRemoteDeletion: async () => analysis([]) });
  empty.prompts.select = async () => { prompts += 1; return []; };
  assert.equal(await runRemoteClean(options(empty, { dryRun: false, interactive: true })), 0);
  assert.equal(prompts, 0);
  assert.deepEqual(empty.lines, ["No remote branches are safe to delete."]);
});

test("remote clean choices are ordered and initially unchecked", async () => {
  const fixture = setup(); let choices: unknown;
  const prompts: RemoteCleanPrompts = {
    select: async (value) => { choices = value; return []; }, confirm: async () => false, input: async () => ""
  };
  assert.equal(await runRemoteClean(options(fixture, { dryRun: false, interactive: true, prompts })), 0);
  assert.deepEqual(choices, [
    { name: "origin/alpha", value: "origin/alpha", checked: false },
    { name: "origin/beta", value: "origin/beta", checked: false }
  ]);
});

test("remote clean authorization no-op table never pushes", async () => {
  const cancellation = new Error("cancelled"); cancellation.name = "ExitPromptError";
  const promptSets: RemoteCleanPrompts[] = [
    { select: async () => [], confirm: async () => true, input: async () => "origin" },
    { select: async () => [alpha.fullName], confirm: async () => false, input: async () => "origin" },
    { select: async () => { throw cancellation; }, confirm: async () => true, input: async () => "origin" },
    { select: async () => [alpha.fullName], confirm: async () => { throw cancellation; }, input: async () => "origin" },
    { select: async () => [alpha.fullName], confirm: async () => true, input: async () => "ORIGIN" },
    { select: async () => [alpha.fullName], confirm: async () => true, input: async () => { throw cancellation; } }
  ];
  for (const prompts of promptSets) {
    const fixture = setup();
    assert.equal(await runRemoteClean(options(fixture, { dryRun: false, interactive: true, prompts })), 0);
    assert.equal(fixture.calls.includes("push"), false);
    assert.equal(fixture.lines.at(-1), "No remote branches were removed.");
  }
});

test("remote clean requires both exact confirmation gates", async () => {
  const fixture = setup(); const events: string[] = [];
  const prompts: RemoteCleanPrompts = {
    select: async () => [beta.fullName, alpha.fullName],
    confirm: async (value) => { events.push(`confirm:${JSON.stringify(value)}`, ...fixture.lines); return true; },
    input: async (value) => { events.push(`input:${JSON.stringify(value)}`, ...fixture.lines); return "origin"; }
  };
  assert.equal(await runRemoteClean(options(fixture, { dryRun: false, interactive: true, prompts })), 0);
  assert.ok(events.includes(`confirm:${JSON.stringify({ message: "Delete 2 branches from 'origin'?", default: false })}`));
  assert.ok(events.includes(`input:${JSON.stringify({ message: "Type 'origin' to confirm remote deletion:" })}`));
  assert.deepEqual(fixture.lines.slice(0, 4), ["Selected remote branches:", "origin/alpha", "origin/beta", "Total: 2"]);
  assert.deepEqual(fixture.calls, ["analyze", "revalidate", "push"]);
});

test("remote clean reloads every safety fact after authorization", async (t) => {
  const local = makeRepo(); t.after(local.cleanup);
  const bare = makeEmptyDirectory("branch-care-revalidate-bare-"); t.after(bare.cleanup);
  git(bare.dir, "init", "-q", "--bare");
  git(local.dir, "remote", "add", "origin", bare.dir);
  git(local.dir, "push", "-q", "-u", "origin", "main");
  git(bare.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  branch(local.dir, "safe");
  git(local.dir, "push", "-q", "origin", "safe");
  const calls: string[][] = [];
  const runner: GitRunner = async (cwd, args) => { calls.push([...args]); return nativeGitRunner(cwd, args); };
  const repository = new Repository(new GitClient(local.dir, runner));
  let authorizationBoundary = -1;
  const lines: string[] = [];
  const code = await runRemoteClean({
    repository, remote: "origin", dryRun: false, interactive: true,
    prompts: {
      select: async () => ["origin/safe"], confirm: async () => true,
      input: async () => {
        authorizationBoundary = calls.length;
        writeFileSync(resolve(local.dir, ".branch-care.json"), '{"protectedBranches":["safe"]}\n');
        return "origin";
      }
    },
    output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) }
  });
  assert.equal(code, 1);
  const afterAuthorization = calls.slice(authorizationBoundary);
  for (const command of ["rev-parse", "remote", "config", "symbolic-ref", "for-each-ref", "ls-remote"]) {
    assert.ok(afterAuthorization.some(([name]) => name === command), `${command} must be re-read after authorization`);
  }
  assert.equal(afterAuthorization.some(([name]) => name === "push"), false);
  assert.match(lines.join("\n"), /Remote deletion skipped: Remote branch 'origin\/safe' is no longer safe to delete/);
});

test("remote clean revalidation rejects every changed safety fact", async () => {
  for (const reason of [
    "no longer exists locally", "no longer exists remotely", "local object changed", "server object changed",
    "is no longer merged", "is current or base", "is now the default", "is protected", "mapping is unsafe"
  ]) {
    const fixture = setup({ revalidateRemoteDeletion: async () => { fixture.calls.push("revalidate"); throw new Error(`${alpha.fullName}: ${reason}`); } });
    const prompts: RemoteCleanPrompts = { select: async () => [alpha.fullName], confirm: async () => true, input: async () => "origin" };
    assert.equal(await runRemoteClean(options(fixture, { dryRun: false, interactive: true, prompts })), 1);
    assert.equal(fixture.calls.includes("push"), false);
    assert.match(fixture.lines.join("\n"), new RegExp(`Remote deletion skipped: ${alpha.fullName}:`));
  }

  const mutations: Array<[string, (local: string, bare: string, raceOid: string) => void]> = [
    ["local ref missing", (local) => git(local, "update-ref", "-d", "refs/remotes/origin/safe")],
    ["server ref missing", (_local, bare) => git(bare, "update-ref", "-d", "refs/heads/safe")],
    ["local oid changed", (local, _bare, raceOid) => git(local, "update-ref", "refs/remotes/origin/safe", raceOid)],
    ["server oid changed", (_local, bare, raceOid) => git(bare, "update-ref", "refs/heads/safe", raceOid)],
    ["local and server advanced together", (local, bare) => {
      commit(local, "advanced-main.txt", "advanced main\n", "advanced main");
      const advancedOid = git(local, "rev-parse", "refs/heads/main");
      git(local, "push", "-q", "origin", "main");
      git(local, "update-ref", "refs/remotes/origin/safe", advancedOid);
      git(bare, "update-ref", "refs/heads/safe", advancedOid);
    }],
    ["ancestry changed", (local, bare, raceOid) => {
      git(local, "update-ref", "refs/remotes/origin/safe", raceOid);
      git(bare, "update-ref", "refs/heads/safe", raceOid);
    }],
    ["current changed", (local) => git(local, "checkout", "-q", "safe")],
    ["base changed", (local) => writeFileSync(resolve(local, ".branch-care.json"), '{"baseBranch":"safe"}\n')],
    ["default changed", (_local, bare) => git(bare, "symbolic-ref", "HEAD", "refs/heads/safe")],
    ["protection changed", (local) => writeFileSync(resolve(local, ".branch-care.json"), '{"protectedBranches":["safe"]}\n')],
    ["mapping changed", (local) => git(local, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/renamed/*")]
  ];

  for (const [label, mutate] of mutations) {
    const local = makeRepo();
    const bare = makeEmptyDirectory("branch-care-revalidation-table-");
    try {
      git(bare.dir, "init", "-q", "--bare");
      git(local.dir, "remote", "add", "origin", bare.dir);
      git(local.dir, "push", "-q", "-u", "origin", "main");
      git(bare.dir, "symbolic-ref", "HEAD", "refs/heads/main");
      branch(local.dir, "safe");
      git(local.dir, "push", "-q", "origin", "safe");
      branch(local.dir, "race");
      git(local.dir, "checkout", "-q", "race");
      commit(local.dir, "race.txt", "race\n", "race");
      git(local.dir, "push", "-q", "origin", "race");
      git(local.dir, "checkout", "-q", "main");
      const repository = new Repository(new GitClient(local.dir));
      const candidate = (await repository.analyzeRemoteDeletion("origin")).candidates.find(({ fullName }) => fullName === "origin/safe")!;
      const raceOid = git(local.dir, "rev-parse", "refs/heads/race");
      mutate(local.dir, bare.dir, raceOid);
      await assert.rejects(repository.revalidateRemoteDeletion("origin", [candidate]), /./, label);
    } finally {
      local.cleanup(); bare.cleanup();
    }
  }
});

test("remote clean builds one exact atomic leased push", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
  await new GitClient("/tmp/repository", runner).deleteRemoteBranches("origin", [alpha, beta]);
  assert.deepEqual(calls, [[
    "push", "--atomic", "--no-follow-tags", "--no-recurse-submodules", "--no-progress",
    `--force-with-lease=refs/heads/alpha:${alpha.oid}`,
    `--force-with-lease=refs/heads/beta:${beta.oid}`,
    "--", "origin", ":refs/heads/alpha", ":refs/heads/beta"
  ]]);
});

test("remote clean push failure table is redacted and has no fallback", async () => {
  for (const failure of ["atomic unsupported", "stale lease", "permission denied", "pre-push hook declined", "generic failure"]) {
    let pushes = 0;
    const fixture = setup({ deleteRemoteBranches: async () => { pushes += 1; throw new Error(`${failure} https://secret@example.test/repo.git`); } });
    const prompts: RemoteCleanPrompts = { select: async () => [alpha.fullName], confirm: async () => true, input: async () => "origin" };
    assert.equal(await runRemoteClean(options(fixture, { dryRun: false, interactive: true, prompts })), 1);
    assert.equal(pushes, 1);
    assert.match(fixture.lines.join("\n"), /^ERR:Remote deletion failed:/m);
    assert.doesNotMatch(fixture.lines.join("\n"), /secret@|Deleted origin\//);
  }
});
