import {
  assertFormAuthorityOperatorScope,
  type FormAuthorityGatewayAction,
  FormAuthorityOperatorProofError,
  type SignedFormAuthorityRpcInvocation,
  verifySignedFormAuthorityRpcInvocation,
} from "./form-authority-operator-proof.ts";
import {
  currentPublicHostIdentity,
  type FormAuthorityPublicIdentityWorkerEnv,
  formAuthorityConfigurationFromPublicIdentity,
  samePublicHostIdentity,
} from "./form-authority-public-identity.ts";
import { createR2ObjectStore, type R2BucketLike } from "./objects-r2.ts";
import type { PublicHostIdentity } from "./public-host-identity.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";
import type {
  FormAuthorityApplyResult,
  FormAuthorityPlan,
  FormAuthorityPlanRequest,
  FormAuthorityReadback,
} from "./takoform/host-admission-coordinator.ts";
import type { FormAuthorityComposition } from "./takoform/host-admission-endpoint.ts";
import { createIntegrationFormAuthorityComposition } from "./takoform/integration-operator-endpoint.ts";

export {
  currentPublicHostIdentity,
  type FormAuthorityPublicIdentityWorkerEnv,
  formAuthorityConfigurationFromPublicIdentity,
} from "./form-authority-public-identity.ts";

export interface IntegrationFormAuthorityRawWorkerEnv extends FormAuthorityPublicIdentityWorkerEnv {
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: string;
  readonly STATE_DB: D1DatabaseLike;
  readonly OBJECTS: R2BucketLike;
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
  const live = await currentPublicHostIdentity(env);
  const body = await verifySignedFormAuthorityRpcInvocation({
    invocation,
    expectedAction,
    identity: {
      environment,
      hostId: live.hostId,
      workerArtifactDigest: live.workerArtifactDigest,
      publicWorkerVersionId: live.workerVersionId,
      implementationDigest: live.implementationDigest,
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
  const { endpoint } = await createIntegrationFormAuthorityCompositionFromWorkerEnv(env, live);
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
  proofIdentity?: PublicHostIdentity,
): Promise<FormAuthorityComposition> {
  const environment = env.TAKOSERVER_ENVIRONMENT;
  if (environment !== "integration") {
    throw new TypeError("integration Form authority refuses every non-integration environment");
  }
  return currentPublicHostIdentity(env).then((reread) => {
    if (proofIdentity !== undefined && !samePublicHostIdentity(proofIdentity, reread)) {
      throw new FormAuthorityOperatorProofError("identity_unavailable");
    }
    const fixed = proofIdentity ?? reread;
    return createIntegrationFormAuthorityComposition({
      configuration: formAuthorityConfigurationFromPublicIdentity(env, fixed),
      bindings: {
        sql: createD1Sql(env.STATE_DB),
        objects: createR2ObjectStore(env.OBJECTS),
        publicHostIdentity: env.PUBLIC_HOST_IDENTITY,
      },
    });
  });
}
