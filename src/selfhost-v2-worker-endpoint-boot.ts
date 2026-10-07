import type { Sql } from "./ports.ts";
import {
  createSelfhostV2WorkerEndpointFrontend,
  type V2WorkerEndpointAddress,
} from "./selfhost-v2-worker-endpoint-frontend.ts";
import {
  createSelfhostV2WorkerEndpointHttpsListener,
  type SelfhostV2WorkerEndpointHttpsFactories,
} from "./selfhost-v2-worker-endpoint-https.ts";
import type { V2Execution } from "./takoform-v2/types.ts";
import type {
  createWorkerEndpointForm,
  V2EndpointRouteAbsenceObservation,
  V2EndpointTlsObservation,
} from "./takoform-v2/worker-endpoint-backend.ts";

type FrontendOptions = Parameters<typeof createSelfhostV2WorkerEndpointFrontend>[0];

/** The existing Endpoint Form ports, now supplied by one trusted self-host boot. */
export type SelfhostV2WorkerEndpointPorts = Pick<
  Parameters<typeof createWorkerEndpointForm>[0],
  "assignHostname" | "observeTls" | "observeRouteAbsent"
>;

export interface SelfhostV2WorkerEndpointBootOptions {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicOrigin: string;
  readonly configuration: { readonly workerEndpointSuffix: string; readonly port: 443 };
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly publicationState: FrontendOptions["publicationState"];
  readonly ownerForWorkerUid: FrontendOptions["ownerForWorkerUid"];
  /** Only the OS listener and its local TLS probe are replaceable in tests. */
  readonly factories?: SelfhostV2WorkerEndpointHttpsFactories;
}

export interface SelfhostV2WorkerEndpointBoot {
  readonly endpoint: SelfhostV2WorkerEndpointPorts;
  close(closeActiveConnections?: boolean): Promise<void>;
}

const RESOURCE_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function assignedHostname(resourceUid: string, suffix: string): string {
  if (!RESOURCE_UID.test(resourceUid)) {
    throw new TypeError("self-host Worker Endpoint requires a canonical Resource UID");
  }
  // Reuse the exercised native-fixture identity: the complete UUID, without
  // separators, occupies one DNS label. It is injective for canonical UUIDs.
  const label = `v2-${resourceUid.replaceAll("-", "")}`;
  const hostname = `${label}.${suffix}`;
  if (label.length > 63 || hostname.length > 253) {
    throw new TypeError("self-host Worker Endpoint hostname exceeds DNS limits");
  }
  return hostname;
}

function unavailableTls(input: V2WorkerEndpointAddress): V2EndpointTlsObservation {
  return { ...input, ready: false };
}

function unavailableRoute(input: V2WorkerEndpointAddress): V2EndpointRouteAbsenceObservation {
  return { ...input, absent: false };
}

/**
 * Compose the stateless SQL/native route adapter with the shared HTTPS listener.
 * The listener callbacks are wired through a fail-closed deferred reference so
 * the frontend can use that same listener's SNI/retirement witness.
 */
export async function createSelfhostV2WorkerEndpointBoot(
  options: SelfhostV2WorkerEndpointBootOptions,
): Promise<SelfhostV2WorkerEndpointBoot> {
  if (
    !options?.sql ||
    !options.targetKey ||
    typeof options.publicOrigin !== "string" ||
    typeof options.ownerForWorkerUid !== "function" ||
    !options.publicationState
  ) {
    throw new TypeError("self-host Worker Endpoint boot requires SQL, target and owner authority");
  }

  let frontend: ReturnType<typeof createSelfhostV2WorkerEndpointFrontend> | undefined;
  let closed = false;
  const listener = await createSelfhostV2WorkerEndpointHttpsListener({
    configuration: options.configuration,
    certificateChain: options.certificateChain,
    privateKey: options.privateKey,
    fetch: async (request) => {
      if (closed || !frontend) return new Response(null, { status: 503 });
      return await frontend.fetch(request);
    },
    routeDenies: async (address) => {
      if (closed || !frontend) return false;
      return await frontend.routeDenies(address);
    },
    ...(options.factories ? { factories: options.factories } : {}),
  });

  try {
    frontend = createSelfhostV2WorkerEndpointFrontend({
      sql: options.sql,
      targetKey: options.targetKey,
      publicOrigin: options.publicOrigin,
      workerEndpointSuffix: options.configuration.workerEndpointSuffix,
      publicationState: options.publicationState,
      ownerForWorkerUid: options.ownerForWorkerUid,
      witness: listener.witness,
    });
  } catch (error) {
    closed = true;
    frontend = undefined;
    try {
      await listener.close(true);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "self-host Worker Endpoint boot failed and listener cleanup was not confirmed",
      );
    }
    throw error;
  }

  const endpoint = Object.freeze({
    assignHostname({
      resourceUid,
    }: {
      readonly resourceUid: string;
      readonly space: string;
      readonly name: string;
    }) {
      if (closed) throw new Error("self-host Worker Endpoint boot is closed");
      return assignedHostname(resourceUid, options.configuration.workerEndpointSuffix);
    },
    async observeTls(input: V2WorkerEndpointAddress, execution: V2Execution) {
      if (closed || !frontend) return unavailableTls(input);
      return await frontend.observeTls(input, execution);
    },
    async observeRouteAbsent(input: V2WorkerEndpointAddress, execution: V2Execution) {
      if (closed || !frontend) return unavailableRoute(input);
      return await frontend.observeRouteAbsent(input, execution);
    },
  }) satisfies SelfhostV2WorkerEndpointPorts;

  return {
    endpoint,
    close(closeActiveConnections = true) {
      closed = true;
      return listener.close(closeActiveConnections);
    },
  };
}
