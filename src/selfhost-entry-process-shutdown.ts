import { writeSync } from "node:fs";
import {
  createSelfhostEntryShutdown,
  type SelfhostEntryShutdown,
  type SelfhostEntryShutdownOptions,
} from "./selfhost-entry-shutdown.ts";

/** The Bun Host's process outcome for the shared ordered shutdown lifecycle. */
export function createSelfhostEntryProcessShutdown(
  options: Pick<SelfhostEntryShutdownOptions, "stopIngress" | "finishShutdown"> & {
    readonly ingressDrainTimeoutMs?: number;
  },
): SelfhostEntryShutdown {
  const { stopIngress, finishShutdown, ingressDrainTimeoutMs } = options;
  if (
    ingressDrainTimeoutMs !== undefined &&
    (!Number.isSafeInteger(ingressDrainTimeoutMs) ||
      ingressDrainTimeoutMs < 1 ||
      ingressDrainTimeoutMs > 2_147_483_647)
  )
    throw new TypeError("invalid self-host ingress drain timeout");
  return createSelfhostEntryShutdown({
    stopIngress:
      ingressDrainTimeoutMs === undefined
        ? stopIngress
        : async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                Promise.resolve().then(stopIngress),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("self-host ingress drain expired")),
                    ingressDrainTimeoutMs,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          },
    finishShutdown,
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
