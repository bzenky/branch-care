import type { Repository } from "../git/repository.js";
import { serializeRepositoryConfiguration } from "../config.js";
import type { CommandOutput } from "./status.js";

export async function runConfig(repository: Repository, base: string | undefined, output: CommandOutput): Promise<number> {
  try {
    if (base !== undefined) output.out((await repository.updateBaseConfiguration(base)).trimEnd());
    else output.out(serializeRepositoryConfiguration(await repository.configuration()).trimEnd());
    return 0;
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
