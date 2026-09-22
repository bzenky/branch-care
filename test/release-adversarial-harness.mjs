import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCanonical, verifyCanonical } from "../scripts/release-package.mjs";

const [operation, mode, first, second, reportPath] = process.argv.slice(2);
const observations = [];
const hooks = {
  onNpmRun: (entry) => observations.push(entry),
  afterSnapshot({ sourceTarball, sourceSidecar }) {
    if (mode === "replace-after-snapshot") {
      unlinkSync(sourceTarball); writeFileSync(sourceTarball, "attacker artifact");
      unlinkSync(sourceSidecar); writeFileSync(sourceSidecar, `${"0".repeat(64)}  bzenky-branch-care-0.1.0.tgz\n`);
    }
  },
  duringSnapshotCopy(source, copied) {
    if (mode === "replace-during-copy" && copied === 0) {
      unlinkSync(source); writeFileSync(source, "attacker replacement");
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
    if (mode === "artifact-collision") writeFileSync(resolve(destination, "bzenky-branch-care-0.1.0.tgz"), "intruder", { flag: "wx" });
    if (mode === "artifact-symlink") symlinkSync(resolve(destination, "target"), resolve(destination, "bzenky-branch-care-0.1.0.tgz"));
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
