import {
  createDockerContainerCoreOwner,
  type DockerContainerCoreOwner,
  type DockerContainerCoreOwnerOptions,
} from "./docker-container-core-owner.ts";
import {
  LinuxDockerRuntimePreparation,
  type LinuxDockerRuntimePreparationOptions,
} from "./linux-docker-runtime-preparation.ts";

export type LinuxDockerCoreRuntimeOptions = DockerContainerCoreOwnerOptions;
export type LinuxDockerCorePreparationOptions = Omit<
  LinuxDockerRuntimePreparationOptions,
  "owner" | "createCustody"
>;

export interface LinuxDockerCoreRuntime {
  /** Install this original owner's acceptance into Core using the same Sql. */
  readonly owner: DockerContainerCoreOwner;
  createRuntime(options: LinuxDockerCorePreparationOptions): LinuxDockerRuntimePreparation;
}

/**
 * Compose the original Core owner and Linux runtime without caller authority ports.
 * Each accepted revision gets its own policy/runtime while sharing Core acceptance
 * and the original owner's CREATE/START ledger. Construction performs no native IO
 * and does not establish coverage, readiness or serving publication.
 */
export function createLinuxDockerCoreRuntime(
  options: LinuxDockerCoreRuntimeOptions,
): LinuxDockerCoreRuntime {
  const owner = createDockerContainerCoreOwner(options);
  return Object.freeze({
    owner,
    createRuntime(input: LinuxDockerCorePreparationOptions) {
      if ("owner" in input || "createCustody" in input)
        throw new TypeError("linux_docker_core_runtime_invalid_request");
      const captured = { ...input };
      const createCustody = owner.createCustody(captured.policy, captured.requiredSecretNames);
      return new LinuxDockerRuntimePreparation({
        ...captured,
        owner: owner.owner,
        createCustody,
      });
    },
  });
}
