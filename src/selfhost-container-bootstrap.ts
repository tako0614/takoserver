import { isAbsolute, join } from "node:path";
import { createDockerHttpRevisionRuntime } from "./providers/docker-http-revision.ts";
import type {
  SelfhostContainerCapacityProfile,
  SelfhostContainerRuntimeHandle,
} from "./providers/selfhost-container-lifecycle.ts";
import {
  createSelfhostContainerRuntime,
  SelfhostContainerError,
  type SelfhostContainerIdentity,
  type SelfhostContainerRevision,
} from "./providers/selfhost-container-runtime.ts";
import type { StandaloneProviderMode } from "./standalone-provider-composition.ts";

export type {
  SelfhostContainerCapacityProfile,
  SelfhostContainerRuntimeHandle,
} from "./providers/selfhost-container-lifecycle.ts";

/**
 * The first opt-in self-host profile is intentionally one bounded, code-owned
 * choice. These are per-revision ceilings, not aggregate scheduling capacity.
 */
export const SELFHOST_CONTAINER_CAPACITY_PROFILE: SelfhostContainerCapacityProfile = Object.freeze({
  id: "selfhost.container.http.standard",
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pidsLimit: 128,
});

export const SELFHOST_CONTAINER_ENVIRONMENT = Object.freeze({
  dockerSocket: "TAKOSERVER_SELFHOST_CONTAINER_DOCKER_SOCKET",
  network: "TAKOSERVER_SELFHOST_CONTAINER_NETWORK",
});

export interface SelfhostContainerBootstrapConfiguration {
  readonly socketPath: string;
  readonly network: string;
}

export interface SelfhostContainerBootstrap {
  readonly runtime: SelfhostContainerRuntimeHandle;
  readonly capacityProfile: SelfhostContainerCapacityProfile;
  close(): Promise<void>;
}

/**
 * Build the process-signal cleanup path. Even without Container opt-in, the
 * replacement signal handler must stop workerd and exit; when configured, it
 * closes the runtime first and still completes shutdown if close fails.
 */
export function createSelfhostContainerSignalHandler(
  container: Pick<SelfhostContainerBootstrap, "close"> | undefined,
  onCloseFailure: () => void,
  stopWorkerd: () => void,
  exitProcess: () => void,
): () => Promise<void> {
  return () => {
    const closing = container ? Promise.resolve().then(() => container.close()) : Promise.resolve();
    return closing.catch(onCloseFailure).finally(() => {
      stopWorkerd();
      exitProcess();
    });
  };
}

export interface SelfhostContainerBootstrapFactories {
  readonly createDockerRuntime: typeof createDockerHttpRevisionRuntime;
  readonly createSelfhostRuntime: typeof createSelfhostContainerRuntime;
}

const defaultFactories: SelfhostContainerBootstrapFactories = {
  createDockerRuntime: createDockerHttpRevisionRuntime,
  createSelfhostRuntime: createSelfhostContainerRuntime,
};

/**
 * Parse explicit local operator settings without opening the Docker socket or
 * creating any runtime state. Ambient DOCKER_HOST is deliberately ignored.
 */
export function parseSelfhostContainerBootstrapConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): SelfhostContainerBootstrapConfiguration | undefined {
  const socketValue = environment[SELFHOST_CONTAINER_ENVIRONMENT.dockerSocket];
  const networkValue = environment[SELFHOST_CONTAINER_ENVIRONMENT.network];
  if (socketValue === undefined && networkValue === undefined) return undefined;

  const socketPath = socketValue?.trim();
  const network = networkValue?.trim();
  if (!socketPath || !network) {
    throw new TypeError(
      `${SELFHOST_CONTAINER_ENVIRONMENT.dockerSocket} and ${SELFHOST_CONTAINER_ENVIRONMENT.network} must be configured together`,
    );
  }
  if (!isAbsolute(socketPath) || socketPath.includes("\0") || socketPath.length > 4096) {
    throw new TypeError(
      `${SELFHOST_CONTAINER_ENVIRONMENT.dockerSocket} must be an absolute Unix socket path`,
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(network) ||
    ["host", "bridge", "none"].includes(network)
  ) {
    throw new TypeError(
      `${SELFHOST_CONTAINER_ENVIRONMENT.network} must be a valid non-reserved Docker network name`,
    );
  }
  // Operators must pre-create this network as an internal local bridge with
  // `docker network create --driver bridge --internal --label
  // takoserver.installation=local.primary <name>`. It must remain non-ingress
  // and non-attachable. The adapter verifies Name, Driver, Scope, Internal,
  // Ingress, Attachable, and the installation label before pull/create/start;
  // it never creates, adopts, or relabels a network. This syntax check alone
  // is not proof of any of those facts.
  return { socketPath, network };
}

/**
 * Construct the opt-in Docker-backed runtime using the existing native
 * adapter. The returned runtime is lazy: a Bun boot failure before the first
 * provider operation has no open state handle to leak. Calls still use the
 * existing durable runtime under the configured data root.
 */
export function createSelfhostContainerBootstrap(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dataRoot: string;
  readonly providerMode: StandaloneProviderMode;
  readonly factories?: SelfhostContainerBootstrapFactories;
}): SelfhostContainerBootstrap | undefined {
  const configuration = parseSelfhostContainerBootstrapConfiguration(input.environment);
  if (!configuration) return undefined;
  if (input.providerMode !== "stable-selfhost") {
    throw new TypeError("self-host Container runtime cannot be enabled in retired-provider mode");
  }
  if (input.dataRoot === ":memory:") {
    throw new TypeError("self-host Container runtime requires the durable TAKOSERVER_DATA_ROOT");
  }

  const factories = input.factories ?? defaultFactories;
  const backend = factories.createDockerRuntime({
    socketPath: configuration.socketPath,
    installationId: "local.primary",
    network: configuration.network,
    maxMemoryBytes: SELFHOST_CONTAINER_CAPACITY_PROFILE.memoryBytes,
    maxNanoCpus: SELFHOST_CONTAINER_CAPACITY_PROFILE.nanoCpus,
    pidsLimit: SELFHOST_CONTAINER_CAPACITY_PROFILE.pidsLimit,
  });

  let runtimePromise: Promise<SelfhostContainerRuntimeHandle> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const open = (): Promise<SelfhostContainerRuntimeHandle> => {
    if (closed) return Promise.reject(new SelfhostContainerError("closed"));
    runtimePromise ??= factories.createSelfhostRuntime({
      root: join(input.dataRoot, "container-runtime"),
      backend,
      drainTimeoutMs: 5_000,
    });
    return runtimePromise;
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = runtimePromise
      ? runtimePromise.then((runtime) => runtime.close())
      : Promise.resolve();
    return closePromise;
  };

  const runtime: SelfhostContainerRuntimeHandle = {
    reconcile(input: SelfhostContainerRevision) {
      return open().then((handle) => handle.reconcile(input));
    },
    observe(identity: SelfhostContainerIdentity) {
      return open().then((handle) => handle.observe(identity));
    },
    fetch(identity: SelfhostContainerIdentity, request: Request) {
      return open().then((handle) => handle.fetch(identity, request));
    },
    remove(identity: SelfhostContainerIdentity) {
      return open().then((handle) => handle.remove(identity));
    },
    close,
  };

  return {
    runtime,
    capacityProfile: SELFHOST_CONTAINER_CAPACITY_PROFILE,
    close,
  };
}
