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

/**
 * Registration-only default handler. Named RPC consumers bind
 * `IntegrationFormAuthorityEntrypoint` explicitly; unqualified requests fail closed.
 */
export default {
  fetch(_request: Request): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<IntegrationFormAuthorityWorkerEnv>;
