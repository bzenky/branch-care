import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPOSITORY_CONFIG_FILE = ".branch-care.json";
export const DEFAULT_STALE_AFTER_DAYS = 60;
export const BUILT_IN_PROTECTED_BRANCHES = [
  "main",
  "master",
  "develop",
  "staging",
  "production",
  "release/*"
] as const;

const supportedKeys = new Set(["baseBranch", "staleAfterDays", "protectedBranches"]);

export interface RepositoryConfiguration {
  baseBranch?: string;
  staleAfterDays?: number;
  protectedBranches?: string[];
}

export interface EffectiveRepositoryConfiguration {
  baseBranch: string | null;
  staleAfterDays: number;
  protectedBranches: string[];
}

export interface ConfigurationFileSystem {
  writeFile(path: string, contents: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export const nativeConfigurationFileSystem: ConfigurationFileSystem = {
  writeFile: (path, contents) => writeFileSync(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path)
};

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function validateRepositoryConfiguration(value: unknown): RepositoryConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("configuration root value must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !supportedKeys.has(key)).sort(compareBytewise);
  if (unknownKeys.length > 0) throw new Error(`unknown configuration keys: ${unknownKeys.join(", ")}`);

  if ("baseBranch" in record && (typeof record.baseBranch !== "string" || record.baseBranch.trim().length === 0)) {
    throw new Error("baseBranch must be a non-empty string");
  }
  if ("staleAfterDays" in record && (!Number.isSafeInteger(record.staleAfterDays) || (record.staleAfterDays as number) < 1)) {
    throw new Error("staleAfterDays must be a safe integer greater than or equal to 1");
  }
  if ("protectedBranches" in record) {
    if (!Array.isArray(record.protectedBranches)) throw new Error("protectedBranches must be an array of non-empty strings");
    for (const [index, pattern] of record.protectedBranches.entries()) {
      if (typeof pattern !== "string" || pattern.trim().length === 0) {
        throw new Error(`protectedBranches[${index}] must be a non-empty string`);
      }
    }
  }

  return {
    ...(typeof record.baseBranch === "string" ? { baseBranch: record.baseBranch } : {}),
    ...(typeof record.staleAfterDays === "number" ? { staleAfterDays: record.staleAfterDays } : {}),
    ...(Array.isArray(record.protectedBranches) ? { protectedBranches: [...record.protectedBranches] as string[] } : {})
  };
}

export function canonicalizeConfiguration(configuration: RepositoryConfiguration): EffectiveRepositoryConfiguration {
  const builtIns = new Set<string>(BUILT_IN_PROTECTED_BRANCHES);
  const additions = [...new Set(configuration.protectedBranches ?? [])]
    .filter((pattern) => !builtIns.has(pattern))
    .sort(compareBytewise);
  return {
    baseBranch: configuration.baseBranch ?? null,
    staleAfterDays: configuration.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
    protectedBranches: [...BUILT_IN_PROTECTED_BRANCHES, ...additions]
  };
}

export function serializeRepositoryConfiguration(configuration: EffectiveRepositoryConfiguration): string {
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

export function loadRepositoryConfiguration(root: string): EffectiveRepositoryConfiguration {
  const path = resolve(root, REPOSITORY_CONFIG_FILE);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return canonicalizeConfiguration({});
    throw new Error(`Unable to read repository configuration at '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid repository configuration at '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return canonicalizeConfiguration(validateRepositoryConfiguration(parsed));
  } catch (error) {
    throw new Error(`Invalid repository configuration at '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeRepositoryConfiguration(
  root: string,
  configuration: EffectiveRepositoryConfiguration,
  fileSystem: ConfigurationFileSystem = nativeConfigurationFileSystem
): string {
  const destination = resolve(root, REPOSITORY_CONFIG_FILE);
  const temporary = resolve(root, `${REPOSITORY_CONFIG_FILE}.tmp-${process.pid}-${randomUUID()}`);
  const contents = serializeRepositoryConfiguration(configuration);
  let created = false;
  try {
    fileSystem.writeFile(temporary, contents);
    created = true;
    fileSystem.rename(temporary, destination);
    created = false;
    return contents;
  } finally {
    if (created) {
      try { fileSystem.unlink(temporary); } catch {}
    }
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function matchesProtectedPattern(name: string, pattern: string): boolean {
  const expression = pattern.split("*").map(escapeRegularExpression).join(".*");
  return new RegExp(`^${expression}$`, "u").test(name);
}
