import { spawn } from "node:child_process";
import type { RemoteDeleteCandidate } from "../types.js";


export interface GitResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[], input?: string) => Promise<GitResult>;

export class GitCommandError extends Error {
  readonly code: number | string | undefined;
  readonly stderr: string;

  constructor(args: readonly string[], cause: unknown) {
    const value = cause as { code?: number | string; stderr?: string; message?: string };
    const stderr = typeof value.stderr === "string" ? value.stderr.trim() : "";
    super(stderr || value.message || `git ${args[0] ?? "command"} failed`);
    this.name = "GitCommandError";
    this.code = value.code;
    this.stderr = stderr;
  }
}

export const nativeGitRunner: GitRunner = async (cwd, args, input) => {
  const testExecutable = process.env.BRANCH_CARE_TEST_GIT_EXECUTABLE;
  const testPrefix = process.env.BRANCH_CARE_TEST_GIT_PREFIX;
  const executable = testExecutable && testPrefix ? testExecutable : "git";
  const commandArgs = testExecutable && testPrefix ? [testPrefix, ...args] : [...args];
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, commandArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new GitCommandError(args, error)));
    child.on("close", (code) => code === 0 ? resolveResult({ stdout, stderr }) : reject(new GitCommandError(args, { code: code ?? 1, stderr })));
    child.stdin.end(input);
  });
};

export class GitClient {
  constructor(readonly cwd: string, private readonly runner: GitRunner = nativeGitRunner) {}

  run(args: readonly string[], input?: string): Promise<GitResult> {
    return this.runner(this.cwd, args, input);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.run(["branch", "-d", "--", name]);
  }

  fetchPrune(remote: string, dryRun: boolean): Promise<GitResult> {
    return this.run([
      "fetch", "--prune", ...(dryRun ? ["--dry-run"] : []), "--atomic", "--no-tags",
      "--no-recurse-submodules", "--no-write-fetch-head", "--no-progress", "--", remote
    ]);
  }

  listRemoteHeads(remote: string): Promise<GitResult> {
    return this.run(["ls-remote", "--symref", "--quiet", "--", remote, "HEAD", "refs/heads/*"]);
  }

  deleteRemoteBranches(remote: string, candidates: readonly RemoteDeleteCandidate[]): Promise<GitResult> {
    return this.run([
      "push", "--atomic", "--no-follow-tags", "--no-recurse-submodules", "--no-progress",
      ...candidates.map(({ branchName, oid }) => `--force-with-lease=refs/heads/${branchName}:${oid}`),
      "--", remote, ...candidates.map(({ branchName }) => `:refs/heads/${branchName}`)
    ]);
  }

  restoreRemoteBranches(remote: string, entries: readonly { name: string; oid: string }[]): Promise<GitResult> {
    return this.run([
      "push", "--atomic", "--no-follow-tags", "--no-recurse-submodules", "--no-progress",
      ...entries.map(({ name }) => `--force-with-lease=refs/heads/${name}:`),
      "--", remote, ...entries.map(({ name, oid }) => `${oid}:refs/heads/${name}`)
    ]);
  }
}
