import { WorkerEntrypoint } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
import {
  FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
  type FormAuthorityCoreVerifierIdentity,
} from "./form-authority-identity-probe.ts";
import {
  currentPublicHostIdentity,
  type FormAuthorityPublicIdentityWorkerEnv,
  formAuthorityConfigurationFromPublicIdentity,
} from "./form-authority-public-identity.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import type { PublicHostIdentityRpc } from "./public-host-identity.ts";
import { createD1Sql } from "./sql-d1.ts";
import { readReleasedCoreVerifierIdentity } from "./takoform/form-authority-verification.ts";
import type {
  FormAuthorityPlan,
  FormAuthorityPlanRequest,
} from "./takoform/host-admission-coordinator.ts";
import {
  createProductionFormAuthorityComposition,
  type FormAuthorityComposition,
} from "./takoform/host-admission-endpoint.ts";
import { loadPublisherSetClosure } from "./takoform/publisher-set-closure.ts";
import type { SpaceAdmissionPolicyV1 } from "./takoform/space-admission-policy.ts";
import { createTenantSpaceAdmissionAuthority } from "./takoform/tenant-space-admission.ts";

export class TakoformCoreVerifierContainer extends Container<FormAuthorityWorkerEnv> {
  override defaultPort = 8080;
  override sleepAfter = "5m";
  override enableInternet = false;
  override pingEndpoint = "/v1/identity";
}

/** Named service-binding entrypoint only. It has no public fetch surface. */
export class FormAuthorityEntrypoint extends WorkerEntrypoint<FormAuthorityWorkerEnv> {
  async verifierIdentity(): Promise<FormAuthorityCoreVerifierIdentity> {
    const authorityWorkerVersionId = exactWorkerVersionId(this.env.WORKER_VERSION?.id);
    const verifier = await readReleasedCoreVerifierIdentity({
      containers: this.env.CORE_VERIFIER,
      containerName: `${this.env.TAKOSERVER_ENVIRONMENT}:${this.env.TAKOSERVER_FORM_AUTHORITY_HOST_ID}`,
      artifactDigest: this.env.TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST,
    });
    return {
      kind: FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
      authorityWorkerVersionId,
      verifier,
    };
  }

  plan(request: FormAuthorityPlanRequest) {
    return productionComposition(this.env).then(({ endpoint }) => endpoint.plan(request));
  }

  apply(plan: FormAuthorityPlan) {
    return productionComposition(this.env).then(({ endpoint }) => endpoint.apply(plan));
  }

  readback(request: FormAuthorityPlanRequest) {
    return productionComposition(this.env).then(({ endpoint }) => endpoint.readback(request));
  }
}

/**
 * Bind this entrypoint, never the full operator entrypoint, to a credential
 * issuer. Its caller can name only an already-owned tenant; publisher evidence
 * and the positive-only policy are composed inside this Worker.
 */
export class TenantSpaceAdmissionEntrypoint extends WorkerEntrypoint<FormAuthorityWorkerEnv> {
  async ensureTenantSpaceAdmission(input: unknown) {
    return await createTenantSpaceAdmissionAuthority({
      policy: this.env.TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY,
      sql: createD1Sql(this.env.STATE_DB),
      compose: async (policy) => {
        const composition = await productionComposition(this.env, policy);
        const closure = await loadPublisherSetClosure();
        return { ...composition, evidence: closure.evidence };
      },
    }).ensureTenantSpaceAdmission(input);
  }
}

async function productionComposition(
  env: FormAuthorityWorkerEnv,
  activationPolicy?: SpaceAdmissionPolicyV1,
): Promise<FormAuthorityComposition> {
  const publicHostIdentity = env.PUBLIC_HOST_IDENTITY as unknown as PublicHostIdentityRpc;
  const identityEnv = {
    TAKOSERVER_ENVIRONMENT: env.TAKOSERVER_ENVIRONMENT,
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: env.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
    TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST:
      env.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST,
    PUBLIC_HOST_IDENTITY: publicHostIdentity,
  } satisfies FormAuthorityPublicIdentityWorkerEnv;
  const identity = await currentPublicHostIdentity(identityEnv);
  return await createProductionFormAuthorityComposition({
    configuration: {
      ...formAuthorityConfigurationFromPublicIdentity(identityEnv, identity),
      coreVerifierArtifactDigest: env.TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST,
    },
    bindings: {
      sql: createD1Sql(env.STATE_DB),
      objects: createR2ObjectStore(env.OBJECTS),
      publicHostIdentity,
      coreVerifier: env.CORE_VERIFIER,
    },
    ...(activationPolicy ? { activationPolicy } : {}),
  });
}

function exactWorkerVersionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new TypeError("Form authority Worker Version identity is unavailable");
  }
  return value;
}

/**
 * Registration-only default handler. Named RPC consumers bind
 * `FormAuthorityEntrypoint` explicitly; unqualified requests fail closed.
 */
export default {
  fetch(_request: Request): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<FormAuthorityWorkerEnv>;
