const CONFIG_NAME = "TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS";
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

export interface SelfhostV2WorkerEndpointHttpsSelection {
  readonly workerEndpointSuffix: string;
  readonly port: 443;
}

function canonicalSuffix(value: string): string {
  if (
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    value.length > 253 ||
    !HOSTNAME_PATTERN.test(value) ||
    value.split(".").length < 2 ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    /^\d+(?:\.\d+){3}$/u.test(value)
  ) {
    throw new TypeError("TAKOSERVER_WORKER_ENDPOINT_SUFFIX must be a canonical DNS suffix");
  }
  return value;
}

/** Explicitly select the existing private Endpoint boot without mounting its Form. */
export function parseSelfhostV2WorkerEndpointHttpsSelection(
  raw: string | undefined,
  input: {
    readonly workerEndpointSuffix: string | undefined;
    readonly tlsConfigured: boolean;
    readonly containerEndpointHttpsConfigured: boolean;
    readonly reservedPorts: readonly number[];
  },
): SelfhostV2WorkerEndpointHttpsSelection | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "1") throw new TypeError(`${CONFIG_NAME} must be exactly 1 when selected`);
  if (!input.tlsConfigured) {
    throw new TypeError(`${CONFIG_NAME} requires the existing Worker TLS certificate and key`);
  }
  if (!input.workerEndpointSuffix) {
    throw new TypeError(`${CONFIG_NAME} requires TAKOSERVER_WORKER_ENDPOINT_SUFFIX`);
  }
  const workerEndpointSuffix = canonicalSuffix(input.workerEndpointSuffix);
  if (input.containerEndpointHttpsConfigured) {
    throw new TypeError(
      `${CONFIG_NAME} conflicts with the existing Container Endpoint HTTPS listener on TCP 443`,
    );
  }
  if (input.reservedPorts.includes(443)) {
    throw new TypeError(
      `${CONFIG_NAME}: TCP 443 is already assigned to another self-host listener`,
    );
  }
  return Object.freeze({ workerEndpointSuffix, port: 443 });
}
