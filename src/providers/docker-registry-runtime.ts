import { createDockerImageRuntime } from "./docker-image-runtime.ts";
import {
  createDockerRegistrySourceFactory,
  type DockerRegistryCredentialOwner,
  type DockerRegistrySourcePolicy,
} from "./docker-registry-source.ts";

/** Concrete selfhost producer composition; existing entry activation is separate. */
export function createDockerRegistryRuntime(
  options: Omit<Parameters<typeof createDockerImageRuntime>[0], "source"> & {
    readonly registry: {
      readonly credentials: DockerRegistryCredentialOwner;
      readonly policy: DockerRegistrySourcePolicy;
    };
  },
) {
  const { registry, ...runtime } = options;
  const source = createDockerRegistrySourceFactory({
    credentials: registry.credentials,
    policy: registry.policy,
    limits: runtime.limits,
  });
  return createDockerImageRuntime({ ...runtime, source });
}
