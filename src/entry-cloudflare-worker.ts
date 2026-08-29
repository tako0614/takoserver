import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { requirePublicOrigin, type WorkerEnv } from "./entry-worker.ts";
import { publicHostIdentity } from "./public-host-identity.ts";

/** Read-only service-binding identity used by the separate Form authority Worker. */
export class PublicHostIdentityEntrypoint extends WorkerEntrypoint<WorkerEnv> {
  identity() {
    return publicHostIdentity({
      hostId: requirePublicOrigin(this.env),
      workerVersionId: this.env.WORKER_VERSION.id,
    });
  }
}

export default worker;
