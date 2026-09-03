import { canonicalJson, isSha256Digest } from "./json.ts";
import { createR2ObjectStore, type R2BucketLike } from "./objects-r2.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";
import { createTakoformArtifactReconciler } from "./takoform/artifact-reconciler.ts";
import { createArtifactRecovery } from "./takoform/artifact-recovery.ts";

export const ARTIFACT_RECOVERY_RPC_KIND =
  "takoserver.exact-failed-run-artifact-recovery-rpc@v1" as const;

export interface ArtifactRecoveryWorkerEnv {
  readonly STATE_DB: D1DatabaseLike;
  readonly OBJECTS: R2BucketLike;
  readonly WORKER_VERSION: { readonly id: string };
  readonly TAKOSERVER_ENVIRONMENT?: string;
  readonly TAKOSERVER_SOURCE_COMMIT?: string;
  readonly TAKOSERVER_WORKER_ARTIFACT_DIGEST?: string;
}

interface ArtifactRecoveryRpcInput {
  readonly kind: typeof ARTIFACT_RECOVERY_RPC_KIND;
  readonly action: "status" | "apply";
  readonly target: {
    readonly environment: "integration";
    readonly workerVersionId: string;
    readonly sourceCommit: string;
    readonly workerArtifactDigest: `sha256:${string}`;
  };
  readonly request: unknown;
}

/**
 * Named service-binding RPC composition. It is not an HTTP handler and is not
 * imported by the router/OpenAPI graph. All mutation happens through this
 * Worker's own D1/R2 bindings after its immutable live identity is re-fenced.
 */
export async function invokeArtifactRecoveryRpc(
  env: ArtifactRecoveryWorkerEnv,
  value: unknown,
): Promise<Record<string, unknown>> {
  const input = exactRpcInput(value);
  assertArtifactRecoveryRpcTarget(env, input.target);
  const sql = createD1Sql(env.STATE_DB);
  const objects = createR2ObjectStore(env.OBJECTS);
  const clock = () => new Date();
  const reconciler = createTakoformArtifactReconciler({
    sql,
    objects,
    clock,
    randomId: () => crypto.randomUUID(),
  });
  const recovery = createArtifactRecovery({ sql, objects, clock, reconciler });
  const result =
    input.action === "status"
      ? await recovery.status(input.request)
      : await recovery.apply(input.request);
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-rpc-result@v1",
    action: input.action,
    target: structuredClone(input.target),
    result,
  };
}

export function assertArtifactRecoveryRpcTarget(
  env: Pick<
    ArtifactRecoveryWorkerEnv,
    | "WORKER_VERSION"
    | "TAKOSERVER_ENVIRONMENT"
    | "TAKOSERVER_SOURCE_COMMIT"
    | "TAKOSERVER_WORKER_ARTIFACT_DIGEST"
  >,
  target: ArtifactRecoveryRpcInput["target"],
): void {
  if (env.TAKOSERVER_ENVIRONMENT !== "integration" || target.environment !== "integration") {
    throw new TypeError("exact failed-run artifact recovery is integration-only");
  }
  if (env.WORKER_VERSION.id !== target.workerVersionId) {
    throw new TypeError("artifact recovery RPC Worker Version identity changed");
  }
  if (env.TAKOSERVER_SOURCE_COMMIT !== target.sourceCommit) {
    throw new TypeError("artifact recovery RPC source commit identity changed");
  }
  if (env.TAKOSERVER_WORKER_ARTIFACT_DIGEST !== target.workerArtifactDigest) {
    throw new TypeError("artifact recovery RPC artifact identity changed");
  }
}

function exactRpcInput(value: unknown): ArtifactRecoveryRpcInput {
  const record = object(value, "artifact recovery RPC input");
  exactKeys(record, ["kind", "action", "target", "request"]);
  if (record.kind !== ARTIFACT_RECOVERY_RPC_KIND) {
    throw new TypeError(`artifact recovery RPC kind must be ${ARTIFACT_RECOVERY_RPC_KIND}`);
  }
  if (record.action !== "status" && record.action !== "apply") {
    throw new TypeError("artifact recovery RPC action must be status or apply");
  }
  const target = object(record.target, "artifact recovery RPC target");
  exactKeys(target, ["environment", "workerVersionId", "sourceCommit", "workerArtifactDigest"]);
  if (
    target.environment !== "integration" ||
    typeof target.workerVersionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      target.workerVersionId,
    ) ||
    typeof target.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(target.sourceCommit) ||
    !isSha256Digest(target.workerArtifactDigest)
  ) {
    throw new TypeError("artifact recovery RPC target identity is invalid");
  }
  return {
    kind: ARTIFACT_RECOVERY_RPC_KIND,
    action: record.action,
    target: {
      environment: "integration",
      workerVersionId: target.workerVersionId,
      sourceCommit: target.sourceCommit,
      workerArtifactDigest: target.workerArtifactDigest,
    },
    request: record.request,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson([...keys].sort())) {
    throw new TypeError("artifact recovery RPC input has unexpected or missing fields");
  }
}
