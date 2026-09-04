import { WorkerEntrypoint } from "cloudflare:workers";
import {
  handleIntegrationFormAuthorityGateway,
  integrationFormAuthorityGatewayEnv,
} from "./integration-form-authority-gateway.ts";

/** Integration-only authenticated operator gateway; never part of the customer Worker. */
export default class IntegrationFormAuthorityOperatorEntrypoint extends WorkerEntrypoint<IntegrationFormAuthorityOperatorWorkerEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleIntegrationFormAuthorityGateway(
      request,
      integrationFormAuthorityGatewayEnv(this.env),
    );
  }
}
