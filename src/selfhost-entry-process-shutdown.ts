import { writeSync } from "node:fs";
import {
  createSelfhostEntryShutdown,
  type SelfhostEntryShutdown,
  type SelfhostEntryShutdownOptions,
} from "./selfhost-entry-shutdown.ts";

/** The Bun Host's process outcome for the shared ordered shutdown lifecycle. */
export function createSelfhostEntryProcessShutdown(
  options: Pick<SelfhostEntryShutdownOptions, "stopIngress" | "finishShutdown">,
): SelfhostEntryShutdown {
  return createSelfhostEntryShutdown({
    ...options,
    onFailure: (stage) => {
      process.exitCode = 1;
      try {
        writeSync(process.stderr.fd, `self-host shutdown incomplete at ${stage}\n`);
      } finally {
        // A failed owner stop deliberately retains its dependent listeners.
        // Their handles cannot be allowed to keep this failed Host alive.
        // This is an unclean exit, not proof that custody has been released.
        process.exit(1);
      }
    },
    onSuccess: () => process.exit(0),
  });
}
