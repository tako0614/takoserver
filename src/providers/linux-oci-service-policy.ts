import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { validateDockerContainerSpec } from "./docker-container-configured-inputs.ts";
import type { DockerContainerAcceptedExecution } from "./docker-container-core-owner.ts";
import type { DockerContainerCreateRecord } from "./docker-container-create-custody.ts";
import type { LinuxOciArtifactReceipt } from "./linux-oci-owned-bundle.ts";

export const LINUX_OCI_SERVICE_POLICY_FILE = ".tako-oci-service.json";

const fail = (): never => {
  throw new TypeError("linux_oci_service_policy_invalid");
};

/** Application data from the original accepted execution and newly won claim.
 * The creator writes it only inside its original private environment loan.
 * This supplies neither a Host port reservation, native observation nor grant.
 * Original policyDigest and separately selected limits remain unchanged. */
export function serializeLinuxOciServicePolicy(
  artifact: LinuxOciArtifactReceipt,
  record: DockerContainerCreateRecord,
  accepted: DockerContainerAcceptedExecution,
): string {
  validateDockerContainerSpec(accepted.spec);
  const { intent } = record;
  if (
    (accepted.action !== "create" && accepted.action !== "update") ||
    record.state !== "pending" ||
    record.nativeId !== null ||
    artifact.claimId !== record.claimId ||
    artifact.installationId !== intent.installationId ||
    artifact.resourceUid !== intent.resourceUid ||
    artifact.incarnationId !== intent.incarnationId ||
    artifact.revision !== intent.revision ||
    artifact.generation !== intent.policy.generation ||
    accepted.installationId !== intent.installationId ||
    accepted.resourceUid !== intent.resourceUid ||
    accepted.incarnationId !== intent.incarnationId ||
    accepted.revision !== intent.revision ||
    accepted.principal !== intent.policy.tenantRef ||
    accepted.generation !== intent.policy.generation ||
    accepted.outboundInternet !== intent.policy.outboundInternet ||
    (accepted.spec[C.fields.outboundInternet] ?? false) !== accepted.outboundInternet
  )
    return fail();
  return JSON.stringify({
    kind: "linux-oci-owned-service@1",
    artifact,
    service: {
      httpPort: accepted.spec[C.fields.httpPort],
      healthPath: accepted.spec[C.fields.healthPath],
    },
  });
}
