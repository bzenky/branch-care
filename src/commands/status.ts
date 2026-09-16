import type { Repository } from "../git/repository.js";
import { formatStatus } from "../ui/output.js";
import { formatJsonStatus } from "../ui/status-json.js";

export interface CommandOutput {
  out(line: string): void;
  err(line: string): void;
}

export async function runStatus(
  repository: Repository,
  base: string | undefined,
  output: CommandOutput,
  json = false
): Promise<number> {
  try {
    const analysis = await repository.analyze(base);
    output.out(json ? formatJsonStatus(analysis) : formatStatus(analysis).trimEnd());
    return 0;
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
