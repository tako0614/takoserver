import {
  assertFormAuthorityOperatorScope,
  type FormAuthorityGatewayAction,
  type SignedFormAuthorityRpcInvocation,
  verifySignedFormAuthorityRpcInvocation,
} from "./form-authority-operator-proof.ts";
import { createR2ObjectStore, type R2BucketLike } from "./objects-r2.ts";
import type { PublicHostIdentityRpc } from "./public-host-identity.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";
import type {
  FormAuthorityApplyResult,
  FormAuthorityPlan,
  FormAuthorityPlanRequest,
  FormAuthorityReadback,
} from "./takoform/host-admission-coordinator.ts";
import {
  type FormAuthorityComposition,
  parseFormAuthorityCapabilityManifest,
} from "./takoform/host-admission-endpoint.ts";
import { createIntegrationFormAuthorityComposition } from "./takoform/integration-operator-endpoint.ts";

export interface IntegrationFormAuthorityRawWorkerEnv {
  readonly TAKOSERVER_ENVIRONMENT: string;
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: string;
  readonly TAKOSERVER_PUBLIC_WORKER_VERSION_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: string;
  readonly STATE_DB: D1DatabaseLike;
  readonly OBJECTS: R2BucketLike;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
}

/**
 * Independently authenticates the original operator proof before acquiring
 * D1/R2 adapters. A gateway verdict is never authority on this boundary.
 */
export async function invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
  env: IntegrationFormAuthorityRawWorkerEnv,
  expectedAction: "plan",
  invocation: SignedFormAuthorityRpcInvocation,
): Promise<FormAuthorityPlan>;
export async function invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
  env: IntegrationFormAuthorityRawWorkerEnv,
  expectedAction: "apply",
  invocation: SignedFormAuthorityRpcInvocation,
): Promise<FormAuthorityApplyResult>;
export async function invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
  env: IntegrationFormAuthorityRawWorkerEnv,
  expectedAction: "readback",
  invocation: SignedFormAuthorityRpcInvocation,
): Promise<FormAuthorityReadback>;
export async function invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
  env: IntegrationFormAuthorityRawWorkerEnv,
  expectedAction: FormAuthorityGatewayAction,
  invocation: SignedFormAuthorityRpcInvocation,
): Promise<FormAuthorityPlan | FormAuthorityApplyResult | FormAuthorityReadback> {
  const environment = env.TAKOSERVER_ENVIRONMENT;
  if (environment !== "integration") {
    throw new TypeError("integration Form authority refuses every non-integration environment");
  }
  const workerArtifactDigest = env.TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST;
  const body = await verifySignedFormAuthorityRpcInvocation({
    invocation,
    expectedAction,
    identity: {
      environment,
      hostId: env.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
      workerArtifactDigest: workerArtifactDigest as `sha256:${string}`,
      publicWorkerVersionId: env.TAKOSERVER_PUBLIC_WORKER_VERSION_ID,
    },
    publicJwk: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK,
  });
  assertFormAuthorityOperatorScope({
    action: expectedAction,
    body,
    expected: {
      tenantId: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID,
      space: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE,
    },
  });
  const { endpoint } = await createIntegrationFormAuthorityCompositionFromWorkerEnv(env);
  switch (expectedAction) {
    case "plan":
      return await endpoint.plan(body as FormAuthorityPlanRequest);
    case "apply":
      return await endpoint.apply(body as FormAuthorityPlan);
    case "readback":
      return await endpoint.readback(body as FormAuthorityPlanRequest);
  }
}

/**
 * Worker-facing guard with a deliberately observable access order. No storage
 * binding is touched until the exact integration environment has been proven.
 */
export function createIntegrationFormAuthorityCompositionFromWorkerEnv(
  env: IntegrationFormAuthorityRawWorkerEnv,
): Promise<FormAuthorityComposition> {
  const environment = env.TAKOSERVER_ENVIRONMENT;
  if (environment !== "integration") {
    throw new TypeError("integration Form authority refuses every non-integration environment");
  }
  const configuration = {
    environment,
    hostId: env.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
    workerArtifactDigest: env.TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST as `sha256:${string}`,
    publicWorkerVersionId: env.TAKOSERVER_PUBLIC_WORKER_VERSION_ID,
    capabilities: parseFormAuthorityCapabilityManifest(
      env.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST,
    ),
  } as const;
  return createIntegrationFormAuthorityComposition({
    configuration,
    bindings: {
      sql: createD1Sql(env.STATE_DB),
      objects: createR2ObjectStore(env.OBJECTS),
      publicHostIdentity: env.PUBLIC_HOST_IDENTITY,
    },
  });
}
