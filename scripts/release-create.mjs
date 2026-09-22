import { createCanonical, packageName, packageVersion } from "./release-package.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const result = createCanonical({ output: valueAfter("--output") });
  console.log(`${packageName}@${packageVersion}`);
  console.log(`SHA-256 ${result.hash}`);
  console.log(`Created ${result.artifact}`);
  console.log(`Created ${result.checksum}`);
} catch (error) {
  console.error(`release package creation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
