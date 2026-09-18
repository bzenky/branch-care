import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "@homebridge/node-pty-prebuilt-multiarch";

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

export function findExecutable(name: string, pathValue = process.env.PATH ?? "", platform = process.platform): string {
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const suffix of extname(name) ? [""] : suffixes) {
      const candidate = resolve(directory, `${name}${suffix}`);
      try { accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } catch {}
    }
  }
  throw new Error(`Unable to find executable '${name}' on PATH`);
}

export function writeNodeLauncher(directory: string, name: string, source: string): void {
  const script = resolve(directory, `${name}-wrapper.cjs`);
  writeFileSync(script, source);
  if (process.platform === "win32") {
    writeFileSync(resolve(directory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(resolve(directory, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
}

export function prependPath(directory: string, pathValue = process.env.PATH ?? ""): string {
  return pathValue ? `${directory}${delimiter}${pathValue}` : directory;
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

function normalizePtyOutput(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "");
}

export function runCliInteractive(cwd: string, args: string[], interactions: Interaction[], timeoutMs = 15_000): Promise<InteractiveResult> {
  return new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof spawnPty>;
    try {
      child = spawnPty(process.execPath, [cliPath, ...args], {
        cwd,
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        name: "xterm-color",
        cols: 120,
        rows: 30
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let interactionIndex = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Interactive CLI timed out before interaction ${interactionIndex + 1}. stdout: ${normalizePtyOutput(stdout)}`));
    }, timeoutMs);
    const advance = (): void => {
      const interaction = interactions[interactionIndex];
      if (interaction && normalizePtyOutput(stdout).includes(interaction.waitFor)) {
        interactionIndex += 1;
        child.write(interaction.input);
      }
    };
    child.onData((chunk) => { stdout += chunk; advance(); });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      const normalized = normalizePtyOutput(stdout);
      if (interactionIndex !== interactions.length) {
        reject(new Error(`Interactive CLI exited before interaction ${interactionIndex + 1}. stdout: ${normalized}`));
        return;
      }
      resolveResult({ status: exitCode, stdout: normalized, stderr: "" });
    });
  });
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
