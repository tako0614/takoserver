import { WorkerEntrypoint } from "cloudflare:workers";
import {
  existingSpaceOperatorRuntime,
  handleExistingSpaceOperator,
} from "./existing-space-operator.ts";

export default class ExistingSpaceOperatorEntrypoint extends WorkerEntrypoint<ExistingSpaceOperatorWorkerEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleExistingSpaceOperator(request, existingSpaceOperatorRuntime(this.env));
  }
}
