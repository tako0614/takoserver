import { isAbsolute } from "node:path";
import type { Clock, Sql } from "./ports.ts";
import type { SelfhostV2WorkflowBootPort } from "./selfhost-v2-worker-composition.ts";
import { createSelfhostV2WorkflowComposition } from "./takoform-v2/selfhost-v2-workflow-composition.ts";
import { createV2WorkflowBindingAuthority } from "./takoform-v2/workflow-binding-authority.ts";
import { createV2WorkflowForwardBoot } from "./takoform-v2/workflow-binding-boot.ts";

type WorkflowRunOnce = ReturnType<typeof createSelfhostV2WorkflowComposition>["runtime"]["runOne"];

/**
 * App-owned v2 Workflow boot. This joins one accepted Host SQL graph to the
 * existing guarded Workflow runtime; it creates neither a second ledger nor
 * a public authority inferred from a caller-supplied capability flag.
 */
export function createSelfhostV2WorkflowBoot(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly targetKey: string;
  readonly randomId: () => string;
  readonly waitUntil: (epochMs: number, signal: AbortSignal) => Promise<void>;
  readonly guardBinary: string;
  readonly workerdBinary: string;
  readonly maximumRegistrations: number;
  readonly privateSocketDirectory: string;
  readonly leaseMs?: number;
  readonly temporaryRoot?: string;
  readonly dataPlaneAddress?: () => string;
}): SelfhostV2WorkflowBootPort {
  if (
    !options.sql ||
    typeof options.clock !== "function" ||
    !options.targetKey ||
    typeof options.randomId !== "function" ||
    typeof options.waitUntil !== "function" ||
    !isAbsolute(options.guardBinary) ||
    !isAbsolute(options.workerdBinary) ||
    !isAbsolute(options.privateSocketDirectory) ||
    !Number.isSafeInteger(options.maximumRegistrations) ||
    options.maximumRegistrations < 1 ||
    (options.temporaryRoot !== undefined && !isAbsolute(options.temporaryRoot))
  ) {
    throw new TypeError("v2 Workflow boot requires exact SQL, clock and private native tools");
  }
  const { sql, clock, targetKey } = options;
  let prepared = false;
  return Object.freeze({
    prepare(input: Parameters<SelfhostV2WorkflowBootPort["prepare"]>[0]) {
      if (
        prepared ||
        input.sql !== sql ||
        input.clock !== clock ||
        input.targetKey !== targetKey ||
        input.workerdBinary !== options.workerdBinary ||
        typeof input.bundleCustody?.readHeldVerified !== "function" ||
        typeof input.inspector?.inspectWorkflowClass !== "function" ||
        typeof input.ownerForWorker !== "function"
      ) {
        throw new TypeError("v2 Workflow boot must use one exact Worker composition");
      }
      prepared = true;
      const composition = createSelfhostV2WorkflowComposition({
        sql,
        clock,
        targetKey,
        randomId: options.randomId,
        waitUntil: options.waitUntil,
        guardBinary: options.guardBinary,
        workerdBinary: options.workerdBinary,
        maximumRegistrations: options.maximumRegistrations,
        bundleCustody: input.bundleCustody,
        ...(input.assetCustody ? { assetCustody: input.assetCustody } : {}),
        inspector: input.inspector,
        ownerForWorkerUid: async (uid) => {
          const owner = await input.ownerForWorker(uid);
          if (!owner) throw new Error("v2 Workflow native Worker owner is unavailable");
          return owner;
        },
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
        ...(options.dataPlaneAddress === undefined
          ? {}
          : { dataPlaneAddress: options.dataPlaneAddress }),
      });
      const bindingAuthority = createV2WorkflowBindingAuthority({ sql, targetKey });
      const forwardBoot = createV2WorkflowForwardBoot({
        sql,
        targetKey,
        authority: bindingAuthority,
        instances: composition.runtime.instances,
        privateSocketDirectory: options.privateSocketDirectory,
      });
      let closed = false;
      return Object.freeze({
        workflowForm: composition.form,
        bindingAuthority,
        forwardBoot,
        async runWorkflowOnce(
          scope: Parameters<WorkflowRunOnce>[0],
          id: Parameters<WorkflowRunOnce>[1],
        ) {
          if (closed) throw new Error("v2 Workflow execution is unavailable");
          return await composition.runtime.runOne(
            { tenantId: scope.tenantId, workflowResourceUid: scope.workflowResourceUid },
            id,
          );
        },
        async close() {
          closed = true;
          await composition.host.close();
        },
      });
    },
  });
}
