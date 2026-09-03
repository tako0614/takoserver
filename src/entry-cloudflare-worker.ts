import { WorkerEntrypoint } from "cloudflare:workers";
import { invokeArtifactRecoveryRpc } from "./artifact-recovery-worker.ts";
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

/** Integration-only owner maintenance RPC; deliberately has no fetch method. */
export class ExactFailedRunArtifactRecoveryEntrypoint extends WorkerEntrypoint<WorkerEnv> {
  async recoverExactFailedRunArtifact(input: unknown) {
    return await invokeArtifactRecoveryRpc(this.env, input);
  }
}

export default worker;
