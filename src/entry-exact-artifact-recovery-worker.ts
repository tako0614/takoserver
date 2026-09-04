import { WorkerEntrypoint } from "cloudflare:workers";
import type { SignedExactArtifactRecoveryRpcInvocation } from "./exact-artifact-recovery-operator-proof.ts";
import {
  exactArtifactRecoveryWorkerEnv,
  exactArtifactRecoveryWorkerIdentity,
  invokeExactArtifactRecoveryFromWorkerEnv,
  routeLessExactArtifactRecoveryFetch,
} from "./exact-artifact-recovery-worker.ts";

/** Temporary named RPC entrypoint. It deliberately has no public fetch route. */
export class ExactArtifactRecoveryEntrypoint extends WorkerEntrypoint<ExactArtifactRecoveryWorkerEnv> {
  identity() {
    return exactArtifactRecoveryWorkerIdentity(exactArtifactRecoveryWorkerEnv(this.env));
  }

  status(invocation: SignedExactArtifactRecoveryRpcInvocation) {
    return invokeExactArtifactRecoveryFromWorkerEnv(
      exactArtifactRecoveryWorkerEnv(this.env),
      "status",
      invocation,
    );
  }

  apply(invocation: SignedExactArtifactRecoveryRpcInvocation) {
    return invokeExactArtifactRecoveryFromWorkerEnv(
      exactArtifactRecoveryWorkerEnv(this.env),
      "apply",
      invocation,
    );
  }

  purge(invocation: SignedExactArtifactRecoveryRpcInvocation) {
    return invokeExactArtifactRecoveryFromWorkerEnv(
      exactArtifactRecoveryWorkerEnv(this.env),
      "purge",
      invocation,
    );
  }
}

export default {
  fetch: routeLessExactArtifactRecoveryFetch,
} satisfies ExportedHandler<ExactArtifactRecoveryWorkerEnv>;
