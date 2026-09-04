import {
  ARTIFACT_RECOVERY_APPLY_FORMAT,
  type ArtifactRecoveryExecution,
  type ArtifactRecoveryLostAckAuthorization,
  canonicalArtifactRecoveryRequest,
  createArtifactRecovery,
  type Digest,
  parseArtifactRecoveryLostAckAuthorization,
} from "./artifact-recovery.ts";
import {
  EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT,
  purgeExactArtifactRecoveryDetails,
} from "./artifact-recovery-owner-gc.ts";
import {
  type ExactArtifactRecoveryGatewayAction,
  type SignedExactArtifactRecoveryRpcInvocation,
  verifySignedExactArtifactRecoveryRpcInvocation,
} from "./exact-artifact-recovery-operator-proof.ts";
import { canonicalDigest, canonicalJson, isSha256Digest } from "./json.ts";
import { createR2ObjectStore, type R2BucketLike } from "./objects-r2.ts";
import { isPublicHostIdentity, type PublicHostIdentityRpc } from "./public-host-identity.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";
import { parseStrictJson } from "./strict-json.ts";
import { createExactArtifactRecoveryCoordinator } from "./takoform/exact-artifact-recovery-coordinator.ts";

const MAX_LOST_ACK_BINDING_BYTES = 16 * 1_024;

export interface ExactArtifactRecoveryRawWorkerEnv {
  readonly TAKOSERVER_ENVIRONMENT: string;
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: string;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: string;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST: string;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT: string;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION: string;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK?: string;
  readonly WORKER_VERSION: { readonly id: string };
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
  readonly STATE_DB: D1DatabaseLike;
  readonly OBJECTS: R2BucketLike;
}

export interface ExactArtifactRecoveryWorkerIdentity {
  readonly kind: "takoserver.exact-artifact-recovery-worker-identity@v1";
  readonly requestDigest: Digest;
  readonly workerVersionId: string;
}

/** Runtime boundary for the target-generated Env; no generated-type double cast escapes the entry. */
export function exactArtifactRecoveryWorkerEnv(value: unknown): ExactArtifactRecoveryRawWorkerEnv {
  if (!record(value)) throw new TypeError("exact artifact recovery Worker environment is invalid");
  const workerVersion = value.WORKER_VERSION;
  const publicIdentity = value.PUBLIC_HOST_IDENTITY;
  const database = value.STATE_DB;
  const objects = value.OBJECTS;
  if (
    typeof value.TAKOSERVER_ENVIRONMENT !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_HOST_ID !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK !== "string" ||
    typeof value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST !== "string" ||
    typeof value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST !== "string" ||
    typeof value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT !== "string" ||
    typeof value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION !== "string" ||
    (value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK !== undefined &&
      typeof value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK !== "string") ||
    !record(workerVersion) ||
    typeof workerVersion.id !== "string" ||
    !isPublicHostIdentityRpc(publicIdentity) ||
    !isD1DatabaseLike(database) ||
    !isR2BucketLike(objects)
  ) {
    throw new TypeError("exact artifact recovery Worker environment is invalid");
  }
  return {
    TAKOSERVER_ENVIRONMENT: value.TAKOSERVER_ENVIRONMENT,
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: value.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK:
      value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST:
      value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST:
      value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT:
      value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION:
      value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION,
    ...(value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK === undefined
      ? {}
      : {
          TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK:
            value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK,
        }),
    WORKER_VERSION: { id: workerVersion.id },
    PUBLIC_HOST_IDENTITY: publicIdentity,
    STATE_DB: database,
    OBJECTS: objects,
  };
}

/** There is deliberately no HTTP recovery handler on this Worker. */
export function routeLessExactArtifactRecoveryFetch(): Response {
  return new Response(null, { status: 404 });
}

export function exactArtifactRecoveryWorkerIdentity(
  env: ExactArtifactRecoveryRawWorkerEnv,
): ExactArtifactRecoveryWorkerIdentity {
  const requestDigest = env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST;
  // WORKER_VERSION is provider-assigned metadata for this already-immutable
  // version. Embedding that id as a var in the same version would be circular.
  // The request digest is the immutable authorization binding; the gateway
  // separately pins and verifies this provider-assigned version id.
  const workerVersionId = env.WORKER_VERSION?.id;
  if (
    env.TAKOSERVER_ENVIRONMENT !== "integration" ||
    !isSha256Digest(requestDigest) ||
    !workerVersion(workerVersionId) ||
    env.WORKER_VERSION?.id !== workerVersionId
  ) {
    throw new TypeError("exact artifact recovery Worker identity is unavailable");
  }
  return {
    kind: "takoserver.exact-artifact-recovery-worker-identity@v1",
    requestDigest,
    workerVersionId,
  };
}

export async function invokeExactArtifactRecoveryFromWorkerEnv(
  env: ExactArtifactRecoveryRawWorkerEnv,
  expectedAction: ExactArtifactRecoveryGatewayAction,
  invocation: SignedExactArtifactRecoveryRpcInvocation,
  runtime: {
    readonly clock?: () => Date;
    readonly randomId?: () => string;
  } = {},
): Promise<unknown> {
  const clock = runtime.clock ?? (() => new Date());
  const randomId = runtime.randomId ?? (() => crypto.randomUUID());
  const target = exactArtifactRecoveryWorkerIdentity(env);
  const live = await env.PUBLIC_HOST_IDENTITY.identity();
  if (!isPublicHostIdentity(live) || live.hostId !== env.TAKOSERVER_FORM_AUTHORITY_HOST_ID) {
    throw new TypeError("exact artifact recovery public identity is unavailable");
  }
  const body = await verifySignedExactArtifactRecoveryRpcInvocation({
    invocation,
    expectedAction,
    identity: {
      environment: "integration",
      hostId: live.hostId,
      workerArtifactDigest: live.workerArtifactDigest,
      publicWorkerVersionId: live.workerVersionId,
      implementationDigest: live.implementationDigest,
      requestDigest: target.requestDigest,
      recoveryWorkerVersionId: target.workerVersionId,
    },
    publicJwk: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK,
    clock,
  });
  const request = requestFromBody(expectedAction, body);
  const canonical = await canonicalArtifactRecoveryRequest(request);
  if (canonical.requestDigest !== target.requestDigest) {
    throw new TypeError("exact artifact recovery request binding drifted");
  }
  const r2IdentityDigest = env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST;
  if (
    !isSha256Digest(r2IdentityDigest) ||
    r2IdentityDigest !== canonical.request.r2.identityDigest ||
    env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT !== canonical.request.source.commit ||
    env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION !== canonical.request.source.version
  ) {
    throw new TypeError("exact artifact recovery immutable binding drifted");
  }
  const execution: ArtifactRecoveryExecution = {
    pinnedRequestDigest: target.requestDigest,
    workerVersionId: target.workerVersionId,
    r2IdentityDigest,
    sourceCommit: canonical.request.source.commit,
    sourceVersion: canonical.request.source.version,
    ...(env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK === undefined
      ? {}
      : { lostAck: lostAckBinding(env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK) }),
  };
  const sql = createD1Sql(env.STATE_DB);
  const objects = createR2ObjectStore(env.OBJECTS);
  if (expectedAction === "purge") {
    return await purgeExactArtifactRecoveryDetails(
      {
        sql,
        objects,
        authorization: {
          kind: EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT,
          requestDigest: target.requestDigest,
          workerVersionId: target.workerVersionId,
          invocationDigest: await canonicalDigest(invocation),
          authorizedAt: clock().getTime(),
        },
        clock,
        randomId,
      },
      target.requestDigest,
    );
  }
  const coordinator = createExactArtifactRecoveryCoordinator({
    sql,
    objects,
    clock,
    randomId,
  });
  const recovery = createArtifactRecovery({ sql, objects, clock, coordinator, execution });
  if (expectedAction === "status") return await recovery.status(body);
  if (
    !record(body) ||
    body.kind !== ARTIFACT_RECOVERY_APPLY_FORMAT ||
    !isSha256Digest(body.planDigest)
  ) {
    throw new TypeError("invalid exact artifact recovery apply body");
  }
  return await recovery.apply({ request: body.request, planDigest: body.planDigest });
}

function requestFromBody(action: ExactArtifactRecoveryGatewayAction, body: unknown): unknown {
  if (action !== "apply") return body;
  if (!record(body)) throw new TypeError("invalid exact artifact recovery apply body");
  return body.request;
}

function lostAckBinding(value: string): ArtifactRecoveryLostAckAuthorization {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_LOST_ACK_BINDING_BYTES) {
    throw new TypeError("exact artifact recovery lost-ack binding is invalid");
  }
  const parsed = parseStrictJson(bytes, MAX_LOST_ACK_BINDING_BYTES);
  if (canonicalJson(parsed) !== value) {
    throw new TypeError("exact artifact recovery lost-ack binding is not canonical JSON");
  }
  return parseArtifactRecoveryLostAckAuthorization(parsed);
}

function workerVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicHostIdentityRpc(value: unknown): value is PublicHostIdentityRpc {
  return record(value) && typeof value.identity === "function";
}

function isD1DatabaseLike(value: unknown): value is D1DatabaseLike {
  return record(value) && typeof value.prepare === "function" && typeof value.batch === "function";
}

function isR2BucketLike(value: unknown): value is R2BucketLike {
  return (
    record(value) &&
    typeof value.put === "function" &&
    typeof value.get === "function" &&
    typeof value.head === "function" &&
    typeof value.delete === "function" &&
    typeof value.list === "function"
  );
}
