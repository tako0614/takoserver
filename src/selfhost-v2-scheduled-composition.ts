import type { Clock, Sql } from "./ports.ts";
import type { WorkerCronTriggerCapabilityReader } from "./takoform-v2/worker-cron-trigger-backend.ts";
import {
  runWorkerCronTriggerTick,
  type WorkerCronTriggerTickResult,
} from "./takoform-v2/worker-cron-trigger-scheduler.ts";
import type { WorkerdWorkerRuntimeOwner } from "./workerd-worker-runtime-owner.ts";

type ScheduledOwner = Pick<
  WorkerdWorkerRuntimeOwner,
  "observeScheduledCapability" | "invokeScheduled"
>;

export interface SelfhostV2ScheduledCompositionOptions {
  readonly sql: Sql;
  readonly targetKey: string;
  /** Resolves only a restored, Host-owned native Worker incarnation. */
  readonly ownerForWorkerUid: (uid: string) => Promise<ScheduledOwner>;
  readonly now?: Clock;
}

/**
 * The internal Cron Form and due scanner share one native owner boundary. The
 * existing SQL match table remains the only delivery custody; this adapter has
 * no timer or durable state of its own.
 */
export function createSelfhostV2ScheduledComposition(
  options: SelfhostV2ScheduledCompositionOptions,
) {
  if (
    !options.sql ||
    !options.targetKey ||
    typeof options.ownerForWorkerUid !== "function" ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw new TypeError("v2 scheduled delivery requires SQL, target and native owner");
  }
  const { sql, targetKey, ownerForWorkerUid } = options;
  const now = options.now ?? (() => new Date());
  let closed = false;
  let activeTick: Promise<WorkerCronTriggerTickResult> | null = null;

  const capability: WorkerCronTriggerCapabilityReader = {
    async observeScheduledCapability(input) {
      // This is a caller-owned object. Capture the complete scope before the
      // first await so a mutation cannot retarget the native readback.
      const requested = Object.freeze({
        workerUid: input.workerUid,
        principal: input.principal,
        space: input.space,
        targetKey: input.targetKey,
      });
      if (closed || requested.targetKey !== targetKey) return { kind: "unknown" };
      try {
        const owner = await ownerForWorkerUid(requested.workerUid);
        if (closed) return { kind: "unknown" };
        const observed = await owner.observeScheduledCapability(requested);
        if (closed || observed.kind !== "confirmed") return { kind: "unknown" };
        const nativeStillCurrent = observed.stillCurrent.bind(observed);
        return {
          kind: "confirmed",
          servingSourceOperationId: observed.servingSourceOperationId,
          deploymentUid: observed.deploymentUid,
          deploymentGeneration: observed.deploymentGeneration,
          versions: observed.versions.map((version) => ({ ...version })),
          stillCurrent: async () => !closed && (await nativeStillCurrent()) && !closed,
        };
      } catch {
        return { kind: "unknown" };
      }
    },
  };

  function tick(): Promise<WorkerCronTriggerTickResult> {
    if (closed) return Promise.reject(new Error("v2 scheduled delivery is closed"));
    if (activeTick) return activeTick;
    const pending = runWorkerCronTriggerTick({
      sql,
      now,
      targetKey,
      delivery: {
        async invokeScheduled(input) {
          if (closed) return { kind: "unknown" };
          try {
            const owner = await ownerForWorkerUid(input.workerUid);
            if (closed) return { kind: "unknown" };
            const result = await owner.invokeScheduled(input);
            // A private native answer arriving after shutdown is not a durable
            // acknowledgement. The SQL match stays retryable on the next Host.
            return closed ? { kind: "unknown" } : result;
          } catch {
            return { kind: "unknown" };
          }
        },
      },
    });
    activeTick = pending.finally(() => {
      activeTick = null;
    });
    return activeTick;
  }

  function close(): void {
    closed = true;
  }

  async function drain(): Promise<void> {
    // Close admission, then join this scan before suspending native owners.
    // A late result after close becomes unknown rather than an accepted ACK.
    await activeTick;
  }

  return { capability, tick, close, drain };
}
