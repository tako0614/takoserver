import type { Sql } from "./ports.ts";
import { WORKER_ENDPOINT_FORM_URL } from "./takoform-v2/forms/worker-specs.ts";
import type {
  createV2WorkerPublicationState,
  V2WorkerCurrentServingResolution,
} from "./takoform-v2/worker-publication-state.ts";
import type { V2QueueConsumerCapability } from "./takoform-v2/worker-queue-consumer-backend.ts";
import type { WorkerdWorkerRuntimeOwner } from "./workerd-worker-runtime-owner.ts";

type PublicationState = Pick<
  ReturnType<typeof createV2WorkerPublicationState>,
  "resolveCurrentServing"
>;
type QueueOwner = Pick<WorkerdWorkerRuntimeOwner, "observeQueueServingCapability">;

const unresolved = (): V2WorkerCurrentServingResolution => ({
  kind: "unresolved",
  code: "graph_unresolved",
  message: "Current Queue serving graph is unavailable",
});

/**
 * Joins the native owner's inspected Queue export proof with the actual
 * accepted SQL graph. Neither a declared handler nor a process-local ready
 * flag is an authority for Queue attachment or delivery.
 */
export function createSelfhostV2QueueWorkerCapability(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  readonly ownerForWorkerUid: (uid: string) => Promise<QueueOwner>;
}): V2QueueConsumerCapability {
  if (
    !options.sql ||
    typeof options.targetKey !== "string" ||
    options.targetKey.length === 0 ||
    typeof options.publicationState?.resolveCurrentServing !== "function" ||
    typeof options.ownerForWorkerUid !== "function"
  )
    throw new TypeError("Queue capability requires SQL, publication state and native owner");
  const { sql, targetKey, publicationState, ownerForWorkerUid } = options;

  const observeQueueServingCapability: V2QueueConsumerCapability["observeQueueServingCapability"] =
    async (input) => {
      const requested = {
        workerUid: input.workerUid,
        principal: input.principal,
        space: input.space,
        targetKey: input.targetKey,
      };
      if (requested.targetKey !== targetKey) return { kind: "unknown" };
      try {
        const owner = await ownerForWorkerUid(requested.workerUid);
        return await owner.observeQueueServingCapability(requested);
      } catch {
        // An unopened/restoring/uncertain owner cannot qualify a Consumer.
        return { kind: "unknown" };
      }
    };

  const observeCurrentServing: V2QueueConsumerCapability["observeCurrentServing"] = async (
    input,
  ) => {
    const requested = {
      workerUid: input.workerUid,
      principal: input.principal,
      space: input.space,
      targetKey: input.targetKey,
    };
    if (requested.targetKey !== targetKey) return unresolved();
    const native = await observeQueueServingCapability(requested);
    if (native.kind !== "confirmed") return unresolved();
    // Copy every authority-bearing value before another await. The owner
    // readback remains necessary even though SQL independently rechecks it.
    const sourceOperationId = native.servingSourceOperationId;
    const deploymentUid = native.deploymentUid;
    const deploymentGeneration = native.deploymentGeneration;
    const versions = native.versions.map((version) => ({
      workerVersionUid: version.workerVersionUid,
      generation: version.generation,
      weight: version.weight,
    }));
    const nativeStillCurrent = native.stillCurrent.bind(native);
    try {
      // Endpoint output is only an expected native identity component. The
      // publication reader revalidates the entire accepted SQL source,
      // references, selected Versions and held bytes against it.
      const endpoints = await sql.query(
        `SELECT output_json FROM tf_v2_resources
         WHERE form_url = ? AND principal = ? AND space = ? AND target_key = ?
           AND deleted_at IS NULL
           AND json_extract(spec_json, '$.worker.resourceUid') = ? LIMIT 2`,
        [
          WORKER_ENDPOINT_FORM_URL,
          requested.principal,
          requested.space,
          requested.targetKey,
          requested.workerUid,
        ],
      );
      if (endpoints.length > 1) return unresolved();
      let hostnames: string[] = [];
      if (endpoints.length === 1) {
        const output = JSON.parse(String(endpoints[0]?.output_json)) as unknown;
        if (
          !output ||
          typeof output !== "object" ||
          Array.isArray(output) ||
          typeof (output as { hostname?: unknown }).hostname !== "string"
        )
          return unresolved();
        hostnames = [(output as { hostname: string }).hostname];
      }
      const resolved = await publicationState.resolveCurrentServing({
        workerUid: requested.workerUid,
        targetKey: requested.targetKey,
        sourceOperationId,
        expectedIdentity: {
          generation: `takoserver-v2-operation:${sourceOperationId}`,
          workerResourceUid: requested.workerUid,
          hostnames,
          versions: versions.map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight })),
        },
      });
      if (resolved.kind !== "ready") return unresolved();
      const snapshot = resolved.snapshot;
      const selected = snapshot.deployment?.versions;
      if (
        snapshot.sourceOperationId !== sourceOperationId ||
        snapshot.worker.uid !== requested.workerUid ||
        snapshot.worker.principal !== requested.principal ||
        snapshot.worker.space !== requested.space ||
        snapshot.deployment?.uid !== deploymentUid ||
        snapshot.deployment.generation !== deploymentGeneration ||
        !selected ||
        selected.length !== versions.length ||
        selected.some((version, index) => {
          const observed = versions[index];
          return (
            !observed ||
            version.uid !== observed.workerVersionUid ||
            version.generation !== observed.generation ||
            version.weight !== observed.weight ||
            !version.spec.handlers.includes("queue")
          );
        }) ||
        !(await nativeStillCurrent()) ||
        !(await resolved.stillCurrent())
      )
        return unresolved();
      return {
        kind: "ready",
        snapshot,
        stillCurrent: async () =>
          (await nativeStillCurrent().catch(() => false)) &&
          (await resolved.stillCurrent().catch(() => false)),
        async readVersionMaterials(versionUid) {
          if (!(await nativeStillCurrent().catch(() => false)))
            throw new Error("Current native Queue serving proof was lost");
          const materials = await resolved.readVersionMaterials(versionUid);
          if (!(await nativeStillCurrent().catch(() => false)))
            throw new Error("Current native Queue serving proof was lost");
          return materials;
        },
      };
    } catch {
      return unresolved();
    }
  };

  return Object.freeze({ observeQueueServingCapability, observeCurrentServing });
}
