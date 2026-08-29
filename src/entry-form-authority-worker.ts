import { WorkerEntrypoint } from "cloudflare:workers";
import { createR2ObjectStore } from "./objects-r2.ts";
import type { PublicHostIdentityRpc } from "./public-host-identity.ts";
import { createD1Sql } from "./sql-d1.ts";
import type { FormAuthorityPlan, FormAuthorityPlanRequest } from "./takoform/operator-authority.ts";
import {
  createProductionFormAuthorityComposition,
  type FormAuthorityComposition,
  type FormAuthorityEndpointConfiguration,
  parseFormAuthorityCapabilityManifest,
} from "./takoform/operator-endpoint.ts";

/**
 * Named service-binding entrypoint only. There is intentionally no fetch
 * method or public route.
 */
export class FormAuthorityEntrypoint extends WorkerEntrypoint<FormAuthorityWorkerEnv> {
  plan(request: FormAuthorityPlanRequest) {
    return this.composition().then(({ endpoint }) => endpoint.plan(request));
  }

  apply(plan: FormAuthorityPlan) {
    return this.composition().then(({ endpoint }) => endpoint.apply(plan));
  }

  readback(request: FormAuthorityPlanRequest) {
    return this.composition().then(({ endpoint }) => endpoint.readback(request));
  }

  private composition(): Promise<FormAuthorityComposition> {
    return createProductionFormAuthorityComposition({
      configuration: workerConfiguration(this.env),
      bindings: {
        sql: createD1Sql(this.env.STATE_DB),
        objects: createR2ObjectStore(this.env.OBJECTS),
        publicHostIdentity: this.env.PUBLIC_HOST_IDENTITY as unknown as PublicHostIdentityRpc,
      },
    });
  }
}

export default FormAuthorityEntrypoint;

function workerConfiguration(env: FormAuthorityWorkerEnv): FormAuthorityEndpointConfiguration {
  return {
    environment: env.TAKOSERVER_ENVIRONMENT,
    hostId: env.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
    workerArtifactDigest: env.TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST as `sha256:${string}`,
    publicWorkerVersionId: env.TAKOSERVER_PUBLIC_WORKER_VERSION_ID,
    capabilities: parseFormAuthorityCapabilityManifest(
      env.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST,
    ),
  };
}
