import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { GitClient } from "./git/client.js";

export const HISTORY_CAPACITY = 10;
export const OPERATION_ID_PATTERN = /^clean-(\d{8}T\d{6}Z)-([0-9a-f]+)$/;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type UndoKind = "local" | "remote";
export type UndoState = "pending" | "completed" | "local-retry";
export interface UndoEntry {
  name: string;
  fullName: string;
  oid: string;
  backupRef: string;
  restoration: "remaining";
}
export interface UndoReceipt {
  version: 1;
  id: string;
  state: UndoState;
  kind: UndoKind;
  remote?: string;
  createdAt: string;
  completedAt?: string;
  entries: UndoEntry[];
}
export interface RecoveryPaths { commonDir: string; root: string; operations: string; lock: string }

function bytewise(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function validInstant(value: unknown): value is string { return typeof value === "string" && UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value)); }
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..") && !value.includes("\0");
}
function expectedBackup(id: string, kind: UndoKind, name: string): string { return `refs/branch-care/undo/${id}/${kind}/${name}`; }
function expectedFull(kind: UndoKind, remote: string | undefined, name: string): string { return kind === "remote" ? `${remote}/${name}` : name; }

export function validateReceipt(value: unknown, filenameId?: string): UndoReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid undo receipt");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.id !== "string" || !OPERATION_ID_PATTERN.test(item.id) || (filenameId !== undefined && item.id !== filenameId)) throw new Error("Invalid undo receipt identity");
  if (!(["pending", "completed", "local-retry"] as unknown[]).includes(item.state)) throw new Error("Invalid undo receipt state");
  if (item.kind !== "local" && item.kind !== "remote") throw new Error("Invalid undo receipt kind");
  const kind = item.kind; const remote = item.remote;
  if ((kind === "remote" && !validName(remote)) || (kind === "local" && remote !== undefined)) throw new Error("Invalid undo receipt remote");
  if (!validInstant(item.createdAt) || (item.completedAt !== undefined && !validInstant(item.completedAt))) throw new Error("Invalid undo receipt time");
  if (item.state === "pending" ? item.completedAt !== undefined : item.completedAt === undefined) throw new Error("Inconsistent undo receipt completion");
  if (!Array.isArray(item.entries) || item.entries.length === 0) throw new Error("Invalid undo receipt entries");
  const names = new Set<string>(); const refs = new Set<string>();
  const entries = item.entries.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid undo receipt entry");
    const entry = raw as Record<string, unknown>;
    if (!validName(entry.name) || !validName(entry.fullName) || typeof entry.oid !== "string" || !OID_PATTERN.test(entry.oid) || entry.restoration !== "remaining") throw new Error("Invalid undo receipt entry");
    const backupRef = expectedBackup(item.id as string, kind, entry.name);
    if (entry.fullName !== expectedFull(kind, remote as string | undefined, entry.name) || entry.backupRef !== backupRef || names.has(entry.name) || refs.has(backupRef)) throw new Error("Inconsistent undo receipt entry");
    names.add(entry.name); refs.add(backupRef);
    return { name: entry.name, fullName: entry.fullName, oid: entry.oid, backupRef, restoration: "remaining" as const };
  }).sort((a, b) => bytewise(a.name, b.name));
  return { version: 1, id: item.id, state: item.state as UndoState, kind, ...(kind === "remote" ? { remote: remote as string } : {}), createdAt: item.createdAt, ...(item.completedAt ? { completedAt: item.completedAt as string } : {}), entries };
}

export function replaceReceipt(path: string, receipt: UndoReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8" }); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export class HistoryLock {
  constructor(readonly path: string, private readonly fd: number) {}
  release(): void { try { closeSync(this.fd); } finally { rmSync(this.path, { force: true }); } }
}

export class UndoHistory {
  private pathsValue?: RecoveryPaths;
  constructor(private readonly git: GitClient) {}

  async paths(): Promise<RecoveryPaths> {
    if (this.pathsValue) return this.pathsValue;
    const raw = (await this.git.run(["rev-parse", "--git-common-dir"])).stdout.trim();
    if (!raw) throw new Error("Unable to resolve the common Git directory.");
    const commonDir = isAbsolute(raw) ? raw : resolve(this.git.cwd, raw);
    const root = resolve(commonDir, "branch-care", "undo");
    this.pathsValue = { commonDir, root, operations: resolve(root, "operations"), lock: resolve(root, "history.lock") };
    return this.pathsValue;
  }

  async acquire(): Promise<HistoryLock> {
    const paths = await this.paths(); mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    try { return new HistoryLock(paths.lock, openSync(paths.lock, "wx", 0o600)); }
    catch { throw new Error("Undo history is locked by another Branch Care process. Try again after it finishes."); }
  }

  async acquireReadOnly(): Promise<HistoryLock | undefined> {
    const paths = await this.paths();
    if (!existsSync(paths.root)) return undefined;
    try { return new HistoryLock(paths.lock, openSync(paths.lock, "wx", 0o600)); }
    catch { throw new Error("Undo history is locked by another Branch Care process. Try again after it finishes."); }
  }

  private async refOid(ref: string): Promise<string | undefined> {
    try { return (await this.git.run(["rev-parse", "--verify", ref])).stdout.trim() || undefined; } catch { return undefined; }
  }
  private async refExists(ref: string): Promise<boolean> { return (await this.refOid(ref)) !== undefined; }
  private receiptPath(paths: RecoveryPaths, id: string): string { return resolve(paths.operations, `${id}.json`); }

  async list(): Promise<UndoReceipt[]> {
    const paths = await this.paths(); if (!existsSync(paths.operations)) return [];
    const receipts: UndoReceipt[] = [];
    for (const filename of readdirSync(paths.operations)) {
      if (!filename.endsWith(".json")) throw new Error(`Invalid undo history file '${filename}'.`);
      const id = filename.slice(0, -5);
      let parsed: unknown; try { parsed = JSON.parse(readFileSync(resolve(paths.operations, filename), "utf8")); } catch { throw new Error(`Invalid undo receipt '${filename}'.`); }
      const receipt = validateReceipt(parsed, id);
      if (statSync(resolve(paths.operations, filename)).isFile() === false) throw new Error(`Invalid undo receipt '${filename}'.`);
      receipts.push(await this.reconcile(receipt));
    }
    if (new Set(receipts.map(({ id }) => id)).size !== receipts.length) throw new Error("Duplicate undo operation ID.");
    return receipts.filter(({ state }) => state !== "pending").sort((a, b) => {
      const time = (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt);
      return time || bytewise(b.id, a.id);
    });
  }

  private async reconcile(receipt: UndoReceipt): Promise<UndoReceipt> {
    if (receipt.state !== "pending") return receipt;
    if (receipt.kind === "remote") return receipt;
    const remaining: UndoEntry[] = [];
    for (const entry of receipt.entries) if (!(await this.refExists(`refs/heads/${entry.name}`))) remaining.push(entry);
    if (remaining.length === 0) { await this.remove(receipt); return receipt; }
    const completed = { ...receipt, state: "completed" as const, completedAt: new Date().toISOString(), entries: remaining };
    replaceReceipt(this.receiptPath(await this.paths(), receipt.id), completed); return completed;
  }

  async assertCapacity(dryRun: boolean, output: { out(line: string): void }): Promise<boolean> {
    const full = (await this.list()).length >= HISTORY_CAPACITY;
    if (full) output.out("Undo history capacity 10 is full. Run 'branch-care undo --list' and 'branch-care undo --discard <operation-id>'. Real cleanup is blocked until an operation is discarded.");
    return !full || dryRun;
  }

  newId(now = new Date()): string {
    const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return `clean-${timestamp}-${randomBytes(6).toString("hex")}`;
  }

  async prepare(kind: UndoKind, items: readonly { name: string; fullName: string; oid: string }[], remote?: string): Promise<UndoReceipt> {
    if (items.length === 0) throw new Error("Cannot prepare an empty undo operation.");
    const id = this.newId(); const createdAt = new Date().toISOString();
    const receipt = validateReceipt({ version: 1, id, state: "pending", kind, ...(remote ? { remote } : {}), createdAt,
      entries: items.map((item) => ({ ...item, backupRef: expectedBackup(id, kind, item.name), restoration: "remaining" })) });
    const commands = receipt.entries.flatMap((entry) => [["create", entry.backupRef, entry.oid]]);
    try {
      await this.git.run(["update-ref", "--stdin"], `start\n${commands.map((line) => line.join(" ")).join("\n")}\nprepare\ncommit\n`);
      replaceReceipt(this.receiptPath(await this.paths(), id), receipt);
      return receipt;
    } catch (error) {
      try { await this.deleteRefs(receipt.entries.map(({ backupRef }) => backupRef)); } catch {}
      throw error;
    }
  }

  async complete(receipt: UndoReceipt, successfulNames: ReadonlySet<string>): Promise<UndoReceipt | undefined> {
    const successful = receipt.entries.filter(({ name }) => successfulNames.has(name));
    const unused = receipt.entries.filter(({ name }) => !successfulNames.has(name));
    if (unused.length) await this.deleteRefs(unused.map(({ backupRef }) => backupRef));
    if (successful.length === 0) { rmSync(this.receiptPath(await this.paths(), receipt.id), { force: true }); return undefined; }
    const completed = validateReceipt({ ...receipt, state: "completed", completedAt: new Date().toISOString(), entries: successful });
    replaceReceipt(this.receiptPath(await this.paths(), receipt.id), completed); return completed;
  }

  async select(id?: string): Promise<UndoReceipt> {
    const operations = await this.list(); const operation = id ? operations.find((item) => item.id === id) : operations[0];
    if (!operation) throw new Error(id ? `No cleanup operation '${id}' is available to undo.` : "No cleanups are available to undo.");
    return operation;
  }

  async objectExists(oid: string): Promise<boolean> { try { await this.git.run(["cat-file", "-e", `${oid}^{commit}`]); return true; } catch { return false; } }
  async localExists(name: string): Promise<boolean> { return this.refExists(`refs/heads/${name}`); }
  async restoreLocal(entry: UndoEntry): Promise<void> { await this.git.run(["update-ref", `refs/heads/${entry.name}`, entry.oid, ""]); }

  async retain(receipt: UndoReceipt, entries: UndoEntry[]): Promise<void> {
    const retained = new Set(entries.map(({ backupRef }) => backupRef));
    await this.deleteRefs(receipt.entries.filter(({ backupRef }) => !retained.has(backupRef)).map(({ backupRef }) => backupRef));
    replaceReceipt(this.receiptPath(await this.paths(), receipt.id), validateReceipt({ ...receipt, state: "local-retry", entries }));
  }

  private async deleteRefs(refs: readonly string[]): Promise<void> {
    if (!refs.length) return;
    const existing: string[] = []; for (const ref of refs) if (await this.refExists(ref)) existing.push(ref);
    if (existing.length) await this.git.run(["update-ref", "--stdin"], `start\n${existing.map((ref) => `delete ${ref}`).join("\n")}\nprepare\ncommit\n`);
  }

  async remove(receipt: UndoReceipt): Promise<void> {
    await this.deleteRefs(receipt.entries.map(({ backupRef }) => backupRef));
    unlinkSync(this.receiptPath(await this.paths(), receipt.id));
  }
}
