import { appendFileSync } from "node:fs";
import { loadReleaseMetadata } from "./release-package.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const metadata = loadReleaseMetadata(valueAfter("--manifest"));
  const outputs = {
    "package-name": metadata.packageName,
    "package-version": metadata.packageVersion,
    tarball: metadata.tarballName,
    sidecar: metadata.sidecarName,
    "artifact-base": metadata.artifactBase
  };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines, "utf8");
} catch (error) {
  console.error(`release metadata failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
