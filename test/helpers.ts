import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const cliPath = resolve(projectRoot, "dist/src/index.js");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface Fixture {
  dir: string;
  cleanup(): void;
}

export function makeRepo(initialBranch = "main"): Fixture {
  const dir = mkdtempSync(resolve(tmpdir(), "branch-care-"));
  git(dir, "init", "-q", `--initial-branch=${initialBranch}`);
  git(dir, "config", "user.name", "Branch Tester");
  git(dir, "config", "user.email", "branch@example.test");
  writeFileSync(resolve(dir, "seed.txt"), "seed\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "seed");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeDirectory(): Fixture {
  const dir = mkdtempSync(resolve(tmpdir(), "branch-care-nonrepo-"));
  writeFileSync(resolve(dir, "sentinel"), "unchanged");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeEmptyDirectory(prefix = "branch-care-empty-"): Fixture {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function snapshotDirectory(root: string): string {
  function visit(directory: string, prefix: string): string[] {
    return readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
      .flatMap((entry) => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return [`directory:${relative}`, ...visit(resolve(directory, entry.name), relative)];
        return [`file:${relative}:${readFileSync(resolve(directory, entry.name)).toString("base64")}`];
      });
  }
  return JSON.stringify(visit(root, ""));
}

export function commit(cwd: string, file: string, contents: string, message: string, date?: string): void {
  writeFileSync(resolve(cwd, file), contents);
  git(cwd, "add", file);
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync("git", ["commit", "-q", "-m", message], { cwd, env });
}

export function branch(cwd: string, name: string, start = "HEAD"): void {
  git(cwd, "branch", name, start);
}

export function refs(cwd: string): string {
  return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
}

export function runCli(cwd: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8", input });
}

export interface InteractiveResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Interaction {
  waitFor: string;
  input: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tclBraced(value: string): string {
  return `{${value.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;
}

function tclBytes(value: string): string {
  return Buffer.from(value).toString("hex").match(/.{2}/g)?.map((byte) => `\\x${byte}`).join("") ?? "";
}

function runCliInteractiveWithExpect(cwd: string, args: string[], interactions: Interaction[]): Promise<InteractiveResult> {
  const expectScript = [
    "set timeout 10",
    `spawn -- ${[process.execPath, cliPath, ...args].map(tclBraced).join(" ")}`,
    ...interactions.flatMap((interaction) => [
      `expect -exact ${tclBraced(interaction.waitFor)}`,
      `send -- "${tclBytes(interaction.input)}"`
    ]),
    "expect eof",
    "set result [wait]",
    "exit [lindex $result 3]"
  ].join("\n");
  return captureInteractiveProcess(
    spawn("expect", ["-c", expectScript], { cwd, stdio: ["ignore", "pipe", "pipe"] }),
    interactions,
    false
  );
}

function captureInteractiveProcess(
  child: ReturnType<typeof spawn>,
  interactions: Interaction[],
  driveInput: boolean
): Promise<InteractiveResult> {
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  const stdinStream = child.stdin;
  if (!stdoutStream || !stderrStream || (driveInput && !stdinStream)) {
    return Promise.reject(new Error("Interactive process streams are unavailable"));
  }
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    let interactionIndex = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Interactive CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
    }, 15_000);
    const advance = (): void => {
      if (!driveInput) {
        interactionIndex = interactions.length;
        return;
      }
      const interaction = interactions[interactionIndex];
      if (interaction && stdout.includes(interaction.waitFor)) {
        interactionIndex += 1;
        stdinStream?.write(interaction.input);
      }
    };
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => { stdout += chunk; advance(); });
    stderrStream.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (interactionIndex !== interactions.length) {
        reject(new Error(`Interactive CLI exited before all prompts. stdout: ${stdout} stderr: ${stderr}`));
        return;
      }
      resolveResult({ status, stdout, stderr });
    });
  });
}

export function runCliInteractive(cwd: string, args: string[], interactions: Interaction[]): Promise<InteractiveResult> {
  if (process.platform === "darwin") return runCliInteractiveWithExpect(cwd, args, interactions);
  const command = [process.execPath, cliPath, ...args].map(shellQuote).join(" ");
  return captureInteractiveProcess(
    spawn("script", ["-qefc", command, "/dev/null"], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    interactions,
    true
  );
}

export function assertExit(result: Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">, status: number): void {
  assert.equal(result.status, status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

export function packageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as Record<string, unknown>;
}

export function repositoryName(dir: string): string {
  return basename(dir);
}
