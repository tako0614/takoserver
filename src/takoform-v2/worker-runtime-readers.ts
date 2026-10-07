import type { WorkerdWorkerRuntimeOwner } from "../workerd-worker-runtime-owner.ts";
import type {
  V2WorkerRetirementReader,
  V2WorkerRetirementTarget,
  V2WorkerServingReader,
} from "./worker-lifecycle-backend.ts";

type RuntimeOwnerReader = Pick<
  WorkerdWorkerRuntimeOwner,
  "workerResourceUid" | "observeServing" | "observeRetirement"
>;

const unknown = () => ({ kind: "unknown" }) as const;
const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactRetirementTarget(target: V2WorkerRetirementTarget): boolean {
  return (
    target.workerUid.length > 0 &&
    target.targetKey.length > 0 &&
    (target.kind === "worker"
      ? target.versionUid === null && target.resourceUid === target.workerUid
      : target.kind === "version" &&
        target.versionUid === target.resourceUid &&
        target.versionUid.length > 0)
  );
}

/**
 * Adapt an exclusive UID-owned runtime to the internal Worker lifecycle ports.
 * The owner proves current serving or physical absence; the lifecycle backend
 * separately proves the accepted Operation's principal, Space and SQL fence.
 */
export function createV2WorkerdWorkerRuntimeReaders(options: {
  readonly ownerForWorkerUid: (
    workerUid: string,
  ) => Promise<RuntimeOwnerReader | null> | RuntimeOwnerReader | null;
}): {
  readonly serving: V2WorkerServingReader;
  readonly retirement: V2WorkerRetirementReader;
} {
  const ownerForWorkerUid = options.ownerForWorkerUid;
  if (typeof ownerForWorkerUid !== "function") throw new TypeError("owner selector is required");

  return {
    serving: {
      async observeServing(input) {
        const workerUid = input.workerResourceUid;
        const targetKey = input.targetKey;
        if (!workerUid || !targetKey) return unknown();
        try {
          const owner = await ownerForWorkerUid(workerUid);
          if (!owner || owner.workerResourceUid !== workerUid) return unknown();
          const proof = await owner.observeServing({ workerResourceUid: workerUid, targetKey });
          if (
            proof.kind !== "serving" ||
            proof.workerResourceUid !== workerUid ||
            proof.targetKey !== targetKey ||
            !operationIdPattern.test(proof.sourceOperationId) ||
            proof.generation !== `takoserver-v2-operation:${proof.sourceOperationId}` ||
            !Array.isArray(proof.hostnames) ||
            proof.hostnames.some((hostname) => typeof hostname !== "string" || !hostname) ||
            new Set(proof.hostnames).size !== proof.hostnames.length ||
            !Array.isArray(proof.versions) ||
            proof.versions.length === 0 ||
            proof.versions.some(
              (version) =>
                typeof version.workerVersionUid !== "string" ||
                !version.workerVersionUid ||
                !Number.isSafeInteger(version.weight) ||
                version.weight < 1 ||
                version.weight > 10_000,
            ) ||
            new Set(proof.versions.map((version) => version.workerVersionUid)).size !==
              proof.versions.length ||
            proof.versions.reduce((sum, version) => sum + version.weight, 0) !== 10_000
          ) {
            return unknown();
          }
          return {
            kind: "serving",
            workerResourceUid: workerUid,
            targetKey,
            sourceOperationId: proof.sourceOperationId,
            generation: proof.generation,
            hostnames: [...proof.hostnames],
            versions: proof.versions.map((version) => ({
              workerVersionUid: version.workerVersionUid,
              weight: version.weight,
            })),
          };
        } catch {
          return unknown();
        }
      },
    },
    retirement: {
      async observeRetired(input) {
        // These SQL-side fields are only echoed for the lifecycle reader's
        // exact target comparison; they are not native principal/Space proof.
        const target = { ...input };
        try {
          if (!exactRetirementTarget(target)) return unknown();
          const owner = await ownerForWorkerUid(target.workerUid);
          if (!owner || owner.workerResourceUid !== target.workerUid) return unknown();
          const proof = await owner.observeRetirement(
            target.versionUid === null ? {} : { workerVersionUid: target.versionUid },
          );
          if (
            proof.kind !== "confirmed_absent" ||
            proof.workerResourceUid !== target.workerUid ||
            proof.targetKey !== target.targetKey ||
            (target.versionUid === null
              ? proof.workerVersionUid !== undefined
              : proof.workerVersionUid !== target.versionUid) ||
            !Array.isArray(proof.incarnationOperationIds) ||
            proof.incarnationOperationIds.some((id) => !operationIdPattern.test(id)) ||
            new Set(proof.incarnationOperationIds).size !== proof.incarnationOperationIds.length
          ) {
            return unknown();
          }
          // The owner has already checked every group receipt and execution
          // copy. This readback token is not an independent native signature.
          const receipt = `workerd-owner-absence:${JSON.stringify({
            workerResourceUid: proof.workerResourceUid,
            targetKey: proof.targetKey,
            workerVersionUid: proof.workerVersionUid ?? null,
            incarnationOperationIds: [...proof.incarnationOperationIds].sort(),
          })}`;
          return {
            kind: "retired",
            target,
            scope: "all_incarnations_and_contexts",
            receipt,
          };
        } catch {
          return unknown();
        }
      },
    },
  };
}
