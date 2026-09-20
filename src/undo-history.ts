import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { GitClient } from "./git/client.js";

export const HISTORY_CAPACITY = 10;
export const OPERATION_ID_PATTERN = /^clean-(\d{8}T\d{6}Z)-([0-9a-f]+)$/;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export type UndoKind = "local" | "remote";
export type UndoState = "preparing" | "pending" | "completed" | "local-retry" | "restoring" | "consuming" | "abandoning";
export interface UndoEntry { name: string; fullName: string; oid: string; backupRef: string; restoration: "remaining" }
export interface UndoReceipt {
  version: 1; id: string; state: UndoState; kind: UndoKind; remote?: string; remoteEndpoint?: string; urls?: string[];
  createdAt: string; completedAt?: string; entries: UndoEntry[]; cleanupEntries?: UndoEntry[];
}
export interface RecoveryPaths { commonDir: string; root: string; operations: string; lock: string }
interface LockOwner { version: 1; pid: number; token: string; createdAt: string }

function bytewise(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function validInstant(value: unknown): value is string { return typeof value === "string" && UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value)); }
function validName(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\n") && !value.includes("\r"); }
function expectedBackup(id: string, kind: UndoKind, name: string): string { return `refs/branch-care/undo/${id}/${kind}/${name}`; }
function expectedFull(kind: UndoKind, remote: string | undefined, name: string): string { return kind === "remote" ? `${remote}/${name}` : name; }
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function validateReceipt(value: unknown, filenameId?: string): UndoReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid undo receipt");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.id !== "string" || !OPERATION_ID_PATTERN.test(item.id) || (filenameId !== undefined && item.id !== filenameId)) throw new Error("Invalid undo receipt identity");
  if (!["preparing", "pending", "completed", "local-retry", "restoring", "consuming", "abandoning"].includes(String(item.state))) throw new Error("Invalid undo receipt state");
  if (item.kind !== "local" && item.kind !== "remote") throw new Error("Invalid undo receipt kind");
  const kind = item.kind; const remote = item.remote;
  if (kind === "remote") {
    if (!validName(remote) || !validName(item.remoteEndpoint) || !Array.isArray(item.urls) || !item.urls.every((url) => typeof url === "string")) throw new Error("Invalid undo receipt remote");
  } else if (remote !== undefined || item.remoteEndpoint !== undefined || item.urls !== undefined) throw new Error("Invalid undo receipt remote");
  if (!validInstant(item.createdAt) || (item.completedAt !== undefined && !validInstant(item.completedAt))) throw new Error("Invalid undo receipt time");
  if (["completed", "local-retry", "restoring"].includes(String(item.state)) ? item.completedAt === undefined : item.completedAt !== undefined) throw new Error("Inconsistent undo receipt completion");
  if (!Array.isArray(item.entries) || item.entries.length === 0) throw new Error("Invalid undo receipt entries");
  const names = new Set<string>(); const refs = new Set<string>();
  const parseEntries = (rawEntries: unknown[]): UndoEntry[] => rawEntries.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid undo receipt entry");
    const entry = raw as Record<string, unknown>;
    if (!validName(entry.name) || !validName(entry.fullName) || typeof entry.oid !== "string" || !OID_PATTERN.test(entry.oid) || entry.restoration !== "remaining") throw new Error("Invalid undo receipt entry");
    const backupRef = expectedBackup(item.id as string, kind, entry.name);
    if (entry.fullName !== expectedFull(kind, remote as string | undefined, entry.name) || entry.backupRef !== backupRef || names.has(entry.name) || refs.has(backupRef)) throw new Error("Inconsistent undo receipt entry");
    names.add(entry.name); refs.add(backupRef);
    return { name: entry.name, fullName: entry.fullName, oid: entry.oid, backupRef, restoration: "remaining" as const };
  }).sort((a, b) => bytewise(a.name, b.name));
  const entries = parseEntries(item.entries);
  if (item.cleanupEntries !== undefined && (!Array.isArray(item.cleanupEntries) || !["completed", "local-retry", "restoring"].includes(String(item.state)))) throw new Error("Invalid undo receipt cleanup entries");
  const cleanupEntries = item.cleanupEntries === undefined ? undefined : parseEntries(item.cleanupEntries);
  return { version: 1, id: item.id, state: item.state as UndoState, kind, ...(kind === "remote" ? { remote: remote as string, remoteEndpoint: item.remoteEndpoint as string, urls: [...item.urls as string[]] } : {}), createdAt: item.createdAt, ...(item.completedAt ? { completedAt: item.completedAt as string } : {}), entries, ...(cleanupEntries?.length ? { cleanupEntries } : {}) };
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
  constructor(readonly path: string, private readonly token: string) {}
  release(): void {
    const ownerPath = resolve(this.path, "owner.json");
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
      if (owner.token !== this.token || existsSync(resolve(this.path, "takeover"))) return;
      unlinkSync(ownerPath); rmdirSync(this.path);
    } catch {}
  }
}

export class UndoHistory {
  private pathsValue?: RecoveryPaths;
  constructor(private readonly git: GitClient) {}
  async paths(): Promise<RecoveryPaths> {
    if (this.pathsValue) return this.pathsValue;
    const raw = (await this.git.run(["rev-parse", "--git-common-dir"])).stdout.trim();
    if (!raw) throw new Error("Unable to resolve the common Git directory.");
    const commonDir = isAbsolute(raw) ? raw : resolve(this.git.cwd, raw); const root = resolve(commonDir, "branch-care", "undo");
    return this.pathsValue = { commonDir, root, operations: resolve(root, "operations"), lock: resolve(root, "history.lock") };
  }
  private async acquireExisting(createRoot: boolean): Promise<HistoryLock | undefined> {
    const paths = await this.paths(); if (!existsSync(paths.root) && !createRoot) return undefined;
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomBytes(16).toString("hex"); const ownerPath = resolve(paths.lock, "owner.json");
      try {
        mkdirSync(paths.lock, { mode: 0o700 });
        writeFileSync(ownerPath, `${JSON.stringify({ version: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        return new HistoryLock(paths.lock, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let owner: LockOwner;
      try { owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner; }
      catch { throw new Error("Undo history lock owner is unreadable; refusing to steal it."); }
      if (owner.version !== 1 || typeof owner.token !== "string" || !validInstant(owner.createdAt) || processAlive(owner.pid)) throw new Error("Undo history is locked by another live Branch Care process. Try again after it finishes.");
      const claim = { staleToken: owner.token, claimantToken: token };
      try { writeFileSync(resolve(paths.lock, "takeover"), `${JSON.stringify(claim)}\n`, { mode: 0o600, flag: "wx" }); }
      catch { continue; }
      try {
        const current = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
        if (current.token !== owner.token || processAlive(current.pid)) throw new Error("Undo history lock changed during stale takeover; refusing to steal it.");
        writeFileSync(ownerPath, `${JSON.stringify({ version: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "w" });
        unlinkSync(resolve(paths.lock, "takeover"));
        return new HistoryLock(paths.lock, token);
      } catch (error) {
        try { const currentClaim = JSON.parse(readFileSync(resolve(paths.lock, "takeover"), "utf8")) as typeof claim; if (currentClaim.claimantToken === token) unlinkSync(resolve(paths.lock, "takeover")); } catch {}
        throw error;
      }
    }
    throw new Error("Unable to recover the stale undo history lock safely.");
  }
  async acquire(): Promise<HistoryLock> { return (await this.acquireExisting(true))!; }
  async acquireReadOnly(): Promise<HistoryLock | undefined> { return this.acquireExisting(false); }
  private receiptPath(paths: RecoveryPaths, id: string): string { return resolve(paths.operations, `${id}.json`); }
  private async refOid(ref: string): Promise<string | undefined> { try { return (await this.git.run(["rev-parse", "--verify", ref])).stdout.trim() || undefined; } catch { return undefined; } }
  private async validateRef(ref: string): Promise<void> { try { await this.git.run(["check-ref-format", ref]); } catch { throw new Error(`Unsafe Git ref '${ref}'.`); } }
  private async validateEntryRefs(receipt: UndoReceipt): Promise<void> {
    for (const entry of receipt.entries) {
      await this.validateRef(entry.backupRef); await this.validateRef(`refs/heads/${entry.name}`);
      const oid = await this.refOid(entry.backupRef); if (oid !== entry.oid) throw new Error(`Undo receipt '${receipt.id}' has a missing or mismatched backup ref '${entry.backupRef}'.`);
    }
  }
  private async write(receipt: UndoReceipt): Promise<void> { replaceReceipt(this.receiptPath(await this.paths(), receipt.id), validateReceipt(receipt)); }
  private async createRefs(receipt: UndoReceipt): Promise<void> {
    for (const entry of receipt.entries) { await this.validateRef(entry.backupRef); await this.validateRef(`refs/heads/${entry.name}`); }
    await this.git.run(["update-ref", "--stdin"], `start\n${receipt.entries.map((entry) => `create ${entry.backupRef} ${entry.oid}`).join("\n")}\nprepare\ncommit\n`);
  }
  private async deleteRefs(receipt: UndoReceipt): Promise<void> {
    for (const entry of receipt.entries) await this.validateRef(entry.backupRef);
    const existing: UndoEntry[] = []; for (const entry of receipt.entries) if (await this.refOid(entry.backupRef)) existing.push(entry);
    if (existing.length) await this.git.run(["update-ref", "--stdin"], `start\n${existing.map((entry) => `delete ${entry.backupRef} ${entry.oid}`).join("\n")}\nprepare\ncommit\n`);
  }
  private async finishTerminal(receipt: UndoReceipt, state: "consuming" | "abandoning"): Promise<void> {
    const transition = validateReceipt({ ...receipt, state, completedAt: undefined }); await this.write(transition);
    await this.deleteRefs(transition); unlinkSync(this.receiptPath(await this.paths(), receipt.id));
  }
  private async reconcilePreparing(receipt: UndoReceipt): Promise<UndoReceipt | undefined> {
    const refs = await Promise.all(receipt.entries.map(({ backupRef }) => this.refOid(backupRef)));
    if (refs.every((oid) => oid === undefined)) { rmSync(this.receiptPath(await this.paths(), receipt.id), { force: true }); return undefined; }
    if (refs.some((oid, index) => oid !== undefined && oid !== receipt.entries[index]!.oid)) throw new Error(`Preparing undo receipt '${receipt.id}' has a mismatched backup ref.`);
    const missing = receipt.entries.filter((_entry, index) => refs[index] === undefined);
    if (missing.length) {
      const partial = { ...receipt, entries: missing }; await this.createRefs(partial);
    }
    const pending = validateReceipt({ ...receipt, state: "pending" }); await this.write(pending); return pending;
  }
  private async load(reconcile = true): Promise<UndoReceipt[]> {
    const paths = await this.paths(); if (!existsSync(paths.operations)) return [];
    const receipts: UndoReceipt[] = [];
    for (const filename of readdirSync(paths.operations)) {
      if (!filename.endsWith(".json") || !statSync(resolve(paths.operations, filename)).isFile()) throw new Error(`Invalid undo history file '${filename}'.`);
      let parsed: unknown; try { parsed = JSON.parse(readFileSync(resolve(paths.operations, filename), "utf8")); } catch { throw new Error(`Invalid undo receipt '${filename}'.`); }
      let receipt = validateReceipt(parsed, filename.slice(0, -5));
      if (!reconcile) { receipts.push(receipt); continue; }
      if (receipt.state === "preparing") { const reconciled = await this.reconcilePreparing(receipt); if (!reconciled) continue; receipt = reconciled; }
      if (receipt.state === "consuming" || receipt.state === "abandoning") { await this.deleteRefs(receipt); rmSync(resolve(paths.operations, filename), { force: true }); continue; }
      if (receipt.cleanupEntries?.length) {
        await this.deleteRefs(validateReceipt({ ...receipt, state: "pending", completedAt: undefined, entries: receipt.cleanupEntries, cleanupEntries: undefined }));
        receipt = validateReceipt({ ...receipt, cleanupEntries: undefined }); await this.write(receipt);
      }
      await this.validateEntryRefs(receipt);
      if (receipt.kind === "local" && receipt.state === "pending") {
        const missing: string[] = [];
        for (const entry of receipt.entries) if ((await this.refOid(`refs/heads/${entry.name}`)) === undefined) missing.push(entry.name);
        const reconciled = await this.complete(receipt, new Set(missing));
        if (!reconciled) continue;
        receipt = reconciled;
      } else if (receipt.kind === "local" && receipt.state === "restoring") {
        const unresolved: UndoEntry[] = [];
        for (const entry of receipt.entries) if ((await this.refOid(`refs/heads/${entry.name}`)) !== entry.oid) unresolved.push(entry);
        if (!unresolved.length) { await this.remove(receipt); continue; }
        await this.retain(receipt, unresolved); receipt = validateReceipt({ ...receipt, state: "local-retry", entries: unresolved, cleanupEntries: undefined });
      }
      receipts.push(receipt);
    }
    if (new Set(receipts.map(({ id }) => id)).size !== receipts.length) throw new Error("Duplicate undo operation ID.");
    return receipts.sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt) || bytewise(b.id, a.id));
  }
  async list(): Promise<UndoReceipt[]> { return this.load(); }
  async listReadOnly(): Promise<UndoReceipt[]> { return this.load(false); }
  async assertCapacity(dryRun: boolean, output: { out(line: string): void }): Promise<boolean> {
    const full = (await (dryRun ? this.listReadOnly() : this.list())).length >= HISTORY_CAPACITY;
    if (full) output.out("Undo history capacity 10 is full. Run 'branch-care undo --list' and 'branch-care undo --discard <operation-id>'. Real cleanup is blocked until an operation is discarded.");
    return !full || dryRun;
  }
  newId(now = new Date()): string { return `clean-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(6).toString("hex")}`; }
  async prepare(kind: UndoKind, items: readonly { name: string; fullName: string; oid: string }[], remote?: { name: string; endpoint: string; urls: string[] }): Promise<UndoReceipt> {
    if (!items.length) throw new Error("Cannot prepare an empty undo operation.");
    const id = this.newId(); const receipt = validateReceipt({ version: 1, id, state: "preparing", kind, ...(remote ? { remote: remote.name, remoteEndpoint: remote.endpoint, urls: remote.urls } : {}), createdAt: new Date().toISOString(), entries: items.map((item) => ({ ...item, backupRef: expectedBackup(id, kind, item.name), restoration: "remaining" })) });
    for (const entry of receipt.entries) { await this.validateRef(entry.backupRef); await this.validateRef(`refs/heads/${entry.name}`); }
    await this.write(receipt); await this.createRefs(receipt); const pending = validateReceipt({ ...receipt, state: "pending" }); await this.write(pending); return pending;
  }
  async complete(receipt: UndoReceipt, successfulNames: ReadonlySet<string>): Promise<UndoReceipt | undefined> {
    const successful = receipt.entries.filter(({ name }) => successfulNames.has(name)); const unused = receipt.entries.filter(({ name }) => !successfulNames.has(name));
    if (!successful.length) { await this.finishTerminal(receipt, "abandoning"); return undefined; }
    let completed = validateReceipt({ ...receipt, state: "completed", completedAt: new Date().toISOString(), entries: successful, ...(unused.length ? { cleanupEntries: unused } : {}) });
    await this.write(completed);
    if (unused.length) { await this.deleteRefs(validateReceipt({ ...receipt, entries: unused })); completed = validateReceipt({ ...completed, cleanupEntries: undefined }); await this.write(completed); }
    return completed;
  }
  async reconcileRemote(receipt: UndoReceipt, server: Map<string, string>): Promise<UndoReceipt | undefined> {
    if (receipt.kind !== "remote" || !["pending", "restoring"].includes(receipt.state)) return receipt;
    const values = receipt.entries.map(({ name }) => server.get(name));
    if (receipt.state === "pending") {
      if (values.every((oid) => oid === undefined)) return this.complete(receipt, new Set(receipt.entries.map(({ name }) => name)));
      if (values.every((oid, index) => oid === receipt.entries[index]!.oid)) { await this.finishTerminal(receipt, "abandoning"); return undefined; }
      return receipt;
    }
    if (values.every((oid, index) => oid === receipt.entries[index]!.oid)) { await this.remove(receipt); return undefined; }
    if (values.every((oid) => oid === undefined)) { const retry = validateReceipt({ ...receipt, state: "completed" }); await this.write(retry); return retry; }
    return receipt;
  }
  async reconcilePending(remoteInventory: (endpoint: string) => Promise<Map<string, string>>): Promise<UndoReceipt[]> {
    const operations = await this.load();
    for (const receipt of operations) {
      if (receipt.kind !== "remote" || !["pending", "restoring"].includes(receipt.state)) continue;
      try { await this.reconcileRemote(receipt, await remoteInventory(receipt.remoteEndpoint!)); } catch {}
    }
    return this.load();
  }
  async beginRestore(receipt: UndoReceipt): Promise<UndoReceipt> {
    const restoring = validateReceipt({ ...receipt, state: "restoring" }); await this.write(restoring); return restoring;
  }
  async select(id?: string): Promise<UndoReceipt> { const operations = await this.list(); const operation = id ? operations.find((item) => item.id === id) : operations[0]; if (!operation) throw new Error(id ? `No cleanup operation '${id}' is available to undo.` : "No cleanups are available to undo."); return operation; }
  async objectExists(oid: string): Promise<boolean> { try { await this.git.run(["cat-file", "-e", `${oid}^{commit}`]); return true; } catch { return false; } }
  async localExists(name: string): Promise<boolean> { return (await this.refOid(`refs/heads/${name}`)) !== undefined; }
  async restoreLocal(entry: UndoEntry): Promise<void> { await this.validateRef(`refs/heads/${entry.name}`); await this.git.run(["update-ref", `refs/heads/${entry.name}`, entry.oid, ""]); }
  async retain(receipt: UndoReceipt, entries: UndoEntry[]): Promise<void> {
    const restored = receipt.entries.filter((entry) => !entries.some(({ backupRef }) => backupRef === entry.backupRef));
    let retry = validateReceipt({ ...receipt, state: "local-retry", entries, ...(restored.length ? { cleanupEntries: restored } : {}) }); await this.write(retry);
    if (restored.length) { await this.deleteRefs(validateReceipt({ ...receipt, entries: restored })); retry = validateReceipt({ ...retry, cleanupEntries: undefined }); await this.write(retry); }
  }
  async remove(receipt: UndoReceipt): Promise<void> { await this.finishTerminal(receipt, "consuming"); }
}
