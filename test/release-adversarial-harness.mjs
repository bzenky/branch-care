import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createCanonical, tarballName, verifyCanonical } from "../scripts/release-package.mjs";

const [operation, mode, first, second, reportPath] = process.argv.slice(2);
const observations = [];
let inPlaceMutationDone = false;
const hooks = {
  onNpmRun: (entry) => observations.push(entry),
  afterSnapshot({ sourceTarball, sourceSidecar }) {
    if (mode === "replace-after-snapshot") {
      unlinkSync(sourceTarball); writeFileSync(sourceTarball, "attacker artifact");
      unlinkSync(sourceSidecar); writeFileSync(sourceSidecar, `${"0".repeat(64)}  ${tarballName}\n`);
    }
  },
  duringSnapshotCopy(source, copied) {
    if (mode === "replace-during-copy" && copied === 0) {
      unlinkSync(source); writeFileSync(source, "attacker replacement");
    }
    if (mode === "mutate-in-place-restored-mtime" && copied === 0 && !inPlaceMutationDone && source === resolve(first)) {
      inPlaceMutationDone = true;
      const sourceStat = statSync(source);
      const replacement = Buffer.alloc(sourceStat.size, 0x41);
      writeFileSync(source, replacement);
      utimesSync(source, sourceStat.atime, sourceStat.mtime);
      const sidecarStat = statSync(second);
      const replacementHash = createHash("sha256").update(replacement).digest("hex");
      writeFileSync(second, `${replacementHash}  ${tarballName}\n`);
      utimesSync(second, sidecarStat.atime, sidecarStat.mtime);
    }
  },
  afterLocalInstall({ executable }) {
    if (mode === "binary-failure") {
      if (process.platform === "win32") unlinkSync(executable);
      else chmodSync(executable, 0o000);
    }
  },
  beforeOutputCreate({ destination }) {
    if (mode === "output-directory-race") {
      renameSync(destination, `${destination}-original`);
      mkdirSync(destination);
    }
    if (mode === "artifact-collision") writeFileSync(resolve(destination, tarballName), "intruder", { flag: "wx" });
    if (mode === "artifact-symlink") symlinkSync(resolve(destination, "target"), resolve(destination, tarballName));
  },
  afterArtifactCreate({ artifact }) {
    if (mode === "replace-owned-artifact") {
      unlinkSync(artifact); writeFileSync(artifact, "replacement owned by another actor", { flag: "wx" });
    }
  },
  afterGlobalInstall(details) {
    observations.push({ global: { ...details, shimExists: existsSync(details.globalBin), cacheEntries: readdirSync(details.cache) } });
  }
};

try {
  const result = operation === "create"
    ? createCanonical({ output: first, hooks })
    : verifyCanonical({ artifact: first, checksum: second, hooks });
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ observations, result }, null, 2));
  console.log("accepted canonical artifact");
} catch (error) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ observations, error: error instanceof Error ? error.message : String(error) }, null, 2));
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
