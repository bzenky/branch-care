import type { RemoteAnalysis } from "../types.js";
import { formatRemote } from "../ui/remote.js";
import type { CommandOutput } from "./status.js";

export interface RemoteRepository {
  analyzeRemote(base?: string): Promise<RemoteAnalysis>;
}

export async function runRemote(repository: RemoteRepository, base: string | undefined, output: CommandOutput): Promise<number> {
  try {
    const analysis = await repository.analyzeRemote(base);
    output.out(formatRemote(analysis).trimEnd());
    return 0;
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
