import { WorkerEntrypoint } from "cloudflare:workers";
import type { SignedFormAuthorityRpcInvocation } from "./form-authority-operator-proof.ts";
import {
  type IntegrationFormAuthorityRawWorkerEnv,
  invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv,
} from "./form-authority-worker-composition.ts";

/** Integration-only named RPC entrypoint. It has no public fetch surface. */
export class IntegrationFormAuthorityEntrypoint extends WorkerEntrypoint<IntegrationFormAuthorityWorkerEnv> {
  plan(invocation: SignedFormAuthorityRpcInvocation) {
    return invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
      this.env as unknown as IntegrationFormAuthorityRawWorkerEnv,
      "plan",
      invocation,
    );
  }

  apply(invocation: SignedFormAuthorityRpcInvocation) {
    return invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
      this.env as unknown as IntegrationFormAuthorityRawWorkerEnv,
      "apply",
      invocation,
    );
  }

  readback(invocation: SignedFormAuthorityRpcInvocation) {
    return invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
      this.env as unknown as IntegrationFormAuthorityRawWorkerEnv,
      "readback",
      invocation,
    );
  }
}

export default IntegrationFormAuthorityEntrypoint;
