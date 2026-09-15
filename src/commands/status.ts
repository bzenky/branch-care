import type { Repository } from "../git/repository.js";
import { formatStatus } from "../ui/output.js";

export interface CommandOutput {
  out(line: string): void;
  err(line: string): void;
}

export async function runStatus(repository: Repository, base: string | undefined, output: CommandOutput): Promise<number> {
  try {
    output.out(formatStatus(await repository.analyze(base)).trimEnd());
    return 0;
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
