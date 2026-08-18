import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Keeping workerd running.
 *
 * Generating a configuration and leaving somebody to start the runtime is not
 * a platform; it is homework. This starts workerd once, in watch mode, so a
 * rewritten configuration is picked up without bouncing the process — one
 * tenant's deploy must not drop every other tenant's in-flight requests.
 *
 * If the binary is missing it says so once and the deployment carries on
 * serving everything else. A machine that refuses to start because it cannot
 * run Workers is a machine that also stopped serving the storage it could.
 */

export interface WorkerdSupervisor {
  /** Starts the runtime if it is not already running. Safe to call repeatedly. */
  ensure(configPath: string): Promise<void>;
  stop(): void;
}

/** Where a workerd binary is normally found beside this package. */
export function findWorkerd(repositoryRoot: string): string | null {
  const candidates = [
    join(repositoryRoot, "node_modules", "@cloudflare", "workerd-linux-64", "bin", "workerd"),
    join(repositoryRoot, "node_modules", "workerd", "bin", "workerd"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function createWorkerdSupervisor(options: {
  readonly binary: string | null;
  readonly spawn: (command: readonly string[]) => { kill(): void };
  readonly log?: (message: string) => void;
}): WorkerdSupervisor {
  let running: { kill(): void } | null = null;
  let complained = false;

  return {
    async ensure(configPath) {
      if (running) return;
      if (!options.binary) {
        if (!complained) {
          complained = true;
          options.log?.(
            "no workerd binary found; Workers will not be served. Storage and databases are unaffected.",
          );
        }
        return;
      }
      // `--watch` is why a redeploy does not restart anything: workerd reads
      // the rewritten configuration itself.
      running = options.spawn([options.binary, "serve", "--watch", configPath]);
      options.log?.(`workerd started against ${configPath}`);
    },

    stop() {
      running?.kill();
      running = null;
    },
  };
}
