import { WorkerEntrypoint } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
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

export class TakoformCoreVerifierContainer extends Container<FormAuthorityWorkerEnv> {
  override defaultPort = 8080;
  override sleepAfter = "5m";
  override enableInternet = false;
  override pingEndpoint = "/v1/identity";
}

/** Named service-binding entrypoint only. It has no public fetch surface. */
export class FormAuthorityEntrypoint extends WorkerEntrypoint<FormAuthorityWorkerEnv> {
  verifierIdentity() {
    return readReleasedCoreVerifierIdentity({
      containers: this.env.CORE_VERIFIER,
      containerName: `${this.env.TAKOSERVER_ENVIRONMENT}:${this.env.TAKOSERVER_FORM_AUTHORITY_HOST_ID}`,
      artifactDigest: this.env.TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST,
    });
  }

  plan(request: FormAuthorityPlanRequest) {
    return this.composition().then(({ endpoint }) => endpoint.plan(request));
  }

  apply(plan: FormAuthorityPlan) {
    return this.composition().then(({ endpoint }) => endpoint.apply(plan));
  }

  readback(request: FormAuthorityPlanRequest) {
    return this.composition().then(({ endpoint }) => endpoint.readback(request));
  }

  private async composition(): Promise<FormAuthorityComposition> {
    const publicHostIdentity = this.env.PUBLIC_HOST_IDENTITY as unknown as PublicHostIdentityRpc;
    const identityEnv = {
      TAKOSERVER_ENVIRONMENT: this.env.TAKOSERVER_ENVIRONMENT,
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: this.env.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
      TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST:
        this.env.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST,
      PUBLIC_HOST_IDENTITY: publicHostIdentity,
    } satisfies FormAuthorityPublicIdentityWorkerEnv;
    const identity = await currentPublicHostIdentity(identityEnv);
    return await createProductionFormAuthorityComposition({
      configuration: {
        ...formAuthorityConfigurationFromPublicIdentity(identityEnv, identity),
        coreVerifierArtifactDigest: this.env.TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST,
      },
      bindings: {
        sql: createD1Sql(this.env.STATE_DB),
        objects: createR2ObjectStore(this.env.OBJECTS),
        publicHostIdentity,
        coreVerifier: this.env.CORE_VERIFIER,
      },
    });
  }
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
