import { WorkerEntrypoint } from "cloudflare:workers";
import worker, {
  requirePublicOrigin,
  resolvePublicWorkerImplementationIdentity,
  type WorkerEnv,
} from "./entry-worker.ts";
import { publicHostIdentity } from "./public-host-identity.ts";

/** Read-only service-binding identity used by the separate Form authority Worker. */
export class PublicHostIdentityEntrypoint extends WorkerEntrypoint<WorkerEnv> {
  async identity() {
    const implementation = resolvePublicWorkerImplementationIdentity(this.env);
    if (!implementation) throw new TypeError("public Host implementation identity is unavailable");
    return publicHostIdentity({
      hostId: requirePublicOrigin(this.env),
      workerVersionId: this.env.WORKER_VERSION.id,
      workerArtifactDigest: implementation.workerArtifactDigest,
      implementationPayloadDigest: implementation.implementationPayloadDigest,
      capabilityDigest: implementation.capabilityDigest,
      implementationDigest: implementation.implementationDigest,
    });
  }
}

export default worker;
