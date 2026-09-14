import {
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "./providers/selfhost-data-service.ts";
import {
  type SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
  SELFHOST_WORKER_EVENT_SERVICE_MODULE,
  SELFHOST_WORKER_EVENT_TOKEN_BINDING,
  selfhostEventServiceSource,
} from "./providers/selfhost-events.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "./providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  type SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  type SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  type SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_INTERNAL_BINDING_PREFIX,
  SELFHOST_WORKER_SERVICE_BINDING_KIND,
  type SelfhostWorkerBindingDescriptor,
  selfhostWorkerEntrypointSource,
} from "./providers/selfhost-worker-wrapper.ts";
import type { WorkerdModuleMediaType, WorkerdSite } from "./workerd-runtime.ts";

type WorkerdDataBindingKind =
  | typeof SELFHOST_WORKER_EDGE_KV_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_SQL_BINDING_KIND;

type WorkerdEnvironmentEntry = {
  readonly name: string;
  readonly value: string;
  readonly type: "plain_text" | "json" | "secret_text";
};

type WorkerdDataBinding = {
  readonly kind: WorkerdDataBindingKind;
  readonly publicName: string;
};

type WorkerdServiceBinding = {
  readonly publicName: string;
  readonly target: string;
  readonly targetResourceUid: string;
  readonly unavailableToken: string;
};

type WorkerdAssetInput = {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly notFoundHandling: "none" | "single-page-application";
  readonly runWorkerFirst: boolean;
  readonly mediaTypes: Readonly<Record<string, string>>;
};

/** The already-selected, credential-bearing facts needed to compile one Version graph. */
export interface WorkerdVersionGraphInput {
  readonly directory: string;
  readonly mainModule: string;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly moduleMediaTypes: NonNullable<WorkerdSite["moduleMediaTypes"]>;
  readonly assets?: WorkerdAssetInput;
  readonly environment: readonly WorkerdEnvironmentEntry[];
  readonly dataPlane?: {
    readonly address: string;
    readonly token: string;
    readonly bindings: readonly WorkerdDataBinding[];
  };
  readonly serviceBindings: readonly WorkerdServiceBinding[];
  readonly hostnames: readonly string[];
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly declaredHandlers: readonly ("fetch" | "queue" | "scheduled")[];
  readonly readiness: {
    readonly publication: string;
    readonly probeHostname: string;
  };
  readonly eventToken?: string;
}

/** The runtime projection and copied bytes for one selected Version. */
export interface WorkerdVersionGraph {
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly assets?: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
}

const WORKERD_MODULE_MEDIA_TYPES: readonly WorkerdModuleMediaType[] = [
  "application/javascript+module",
  "text/plain",
  "application/octet-stream",
  "application/wasm",
];

/**
 * Compiles one selected Version into the exact Host/private graph consumed by
 * workerd. This is deliberately a pure projection: all authority, storage,
 * leases, and publication decisions stay with the caller.
 */
export function compileWorkerdVersionGraph(input: WorkerdVersionGraphInput): WorkerdVersionGraph {
  if (
    !isRecord(input) ||
    typeof input.directory !== "string" ||
    input.directory.length === 0 ||
    typeof input.mainModule !== "string" ||
    input.mainModule.length === 0 ||
    !Array.isArray(input.environment) ||
    !Array.isArray(input.serviceBindings) ||
    !Array.isArray(input.hostnames) ||
    !Array.isArray(input.declaredHandlers) ||
    !isRecord(input.readiness)
  ) {
    invalid();
  }
  if (input.generation !== undefined && typeof input.generation !== "string") invalid();
  if (
    input.workerResourceUid !== undefined &&
    (typeof input.workerResourceUid !== "string" || input.workerResourceUid.length === 0)
  ) {
    invalid();
  }
  if (input.hostnames.some((hostname) => typeof hostname !== "string")) invalid();

  const { modules, moduleMediaTypes } = snapshotModules(
    input.mainModule,
    input.modules,
    input.moduleMediaTypes,
  );
  const assets = snapshotAssets(input.assets);
  const environment = projectEnvironment(input.environment);
  const dataPlane = projectDataPlane(input.dataPlane);
  const serviceBindings = projectServiceBindings(input.serviceBindings);
  if (serviceBindings.length > 0 && input.workerResourceUid === undefined) invalid();
  const eventToken = projectOpaqueToken(input.eventToken);

  const services = serviceBindings.map((binding, index) => ({
    name: serviceBindingName(index),
    target: binding.target,
    targetResourceUid: binding.targetResourceUid,
    unavailableToken: binding.unavailableToken,
  }));
  const bindings: SelfhostWorkerBindingDescriptor[] = [
    ...environment.descriptors,
    ...(dataPlane === undefined ? [] : dataPlane.descriptors),
    ...services.map((service, index) => ({
      kind: SELFHOST_WORKER_SERVICE_BINDING_KIND,
      publicName: serviceBindings[index]?.publicName as string,
      internalName: service.name,
      unavailableToken: service.unavailableToken,
    })),
  ];
  const wrapperSource = selfhostWorkerEntrypointSource({
    originalMainModule: input.mainModule,
    declaredHandlers: input.declaredHandlers,
    bindings,
    publication: input.readiness.publication,
    probeHostname: input.readiness.probeHostname,
    ...(eventToken === undefined ? {} : { events: true }),
  });

  const preludeModule = selfhostWorkerPreludeModuleName(input.mainModule);
  const encoder = new TextEncoder();
  const hostModules = new Map<string, Uint8Array>([
    [SELFHOST_WORKER_ENTRYPOINT_MODULE, encoder.encode(wrapperSource)],
    [preludeModule, encoder.encode(selfhostWorkerPreludeSource())],
  ]);
  if (dataPlane !== undefined) {
    hostModules.set(
      SELFHOST_WORKER_DATA_SERVICE_MODULE,
      encoder.encode(selfhostDataServiceSource()),
    );
  }
  if (eventToken !== undefined) {
    hostModules.set(
      SELFHOST_WORKER_EVENT_SERVICE_MODULE,
      encoder.encode(selfhostEventServiceSource()),
    );
  }

  const site: WorkerdSite = {
    directory: input.directory,
    mainModule: input.mainModule,
    hostEntrypoint: SELFHOST_WORKER_ENTRYPOINT_MODULE,
    hostModules: [preludeModule],
    hostnames: [...input.hostnames],
    modules: Object.keys(moduleMediaTypes).filter((name) => name !== input.mainModule),
    moduleMediaTypes,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.workerResourceUid === undefined
      ? {}
      : {
          workerResourceUid: input.workerResourceUid,
          fetchHandler: input.declaredHandlers.includes("fetch"),
        }),
    ...(services.length === 0 ? {} : { serviceBindings: services }),
    ...(assets === undefined ? {} : { assets: assets.configuration }),
    ...(environment.vars.length === 0 ? {} : { vars: environment.vars }),
    ...(dataPlane === undefined
      ? {}
      : {
          dataPlane: {
            address: dataPlane.address,
            module: SELFHOST_WORKER_DATA_SERVICE_MODULE,
            vars: [
              {
                name: SELFHOST_WORKER_DATA_TOKEN_BINDING,
                value: dataPlane.token,
                kind: "text" as const,
              },
            ],
          },
        }),
    ...(eventToken === undefined
      ? {}
      : {
          events: {
            module: SELFHOST_WORKER_EVENT_SERVICE_MODULE,
            vars: [
              {
                name: SELFHOST_WORKER_EVENT_TOKEN_BINDING,
                value: eventToken,
                kind: "text" as const,
              },
            ],
          },
        }),
  };
  return {
    site,
    modules,
    ...(assets === undefined ? {} : { assets: assets.files }),
    hostModules,
  };
}

function projectEnvironment(environment: readonly WorkerdEnvironmentEntry[]): {
  readonly vars: readonly {
    readonly name: string;
    readonly value: string;
    readonly kind: "text" | "json";
  }[];
  readonly descriptors: readonly SelfhostWorkerBindingDescriptor[];
} {
  const vars: Array<{
    readonly name: string;
    readonly value: string;
    readonly kind: "text" | "json";
  }> = [];
  const descriptors: SelfhostWorkerBindingDescriptor[] = [];
  for (const entry of environment) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.value !== "string" ||
      (entry.type !== "plain_text" && entry.type !== "json" && entry.type !== "secret_text")
    ) {
      invalid();
    }
    const type = entry.type;
    vars.push({
      name: entry.name,
      value: entry.value,
      kind: type === "json" ? "json" : "text",
    });
    descriptors.push({
      name: entry.name,
      type: type === "secret_text" ? "secret_text" : type,
    });
  }
  return { vars, descriptors };
}

function projectDataPlane(dataPlane: WorkerdVersionGraphInput["dataPlane"]):
  | {
      readonly address: string;
      readonly token: string;
      readonly descriptors: readonly SelfhostWorkerBindingDescriptor[];
    }
  | undefined {
  if (dataPlane === undefined) return undefined;
  if (
    !isRecord(dataPlane) ||
    typeof dataPlane.address !== "string" ||
    dataPlane.address.length === 0 ||
    typeof dataPlane.token !== "string" ||
    dataPlane.token.length === 0 ||
    !Array.isArray(dataPlane.bindings)
  ) {
    invalid();
  }
  const descriptors: SelfhostWorkerBindingDescriptor[] = [];
  for (const binding of dataPlane.bindings) {
    if (!isRecord(binding)) invalid();
    descriptors.push({
      kind: binding.kind as WorkerdDataBindingKind,
      publicName: binding.publicName as string,
    });
  }
  return { address: dataPlane.address, token: dataPlane.token, descriptors };
}

function projectServiceBindings(
  serviceBindings: readonly WorkerdServiceBinding[],
): readonly WorkerdServiceBinding[] {
  const copied: WorkerdServiceBinding[] = [];
  for (const binding of serviceBindings) {
    if (!isRecord(binding)) invalid();
    if (
      typeof binding.target !== "string" ||
      binding.target.length === 0 ||
      typeof binding.targetResourceUid !== "string" ||
      binding.targetResourceUid.length === 0
    ) {
      invalid();
    }
    copied.push({
      publicName: binding.publicName as string,
      target: binding.target,
      targetResourceUid: binding.targetResourceUid,
      unavailableToken: binding.unavailableToken as string,
    });
  }
  return copied;
}

function projectOpaqueToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function serviceBindingName(index: number): string {
  return `${SELFHOST_WORKER_INTERNAL_BINDING_PREFIX}SELFHOST_SERVICE_${index
    .toString(10)
    .padStart(5, "0")}`;
}

function snapshotModules(
  mainModule: string,
  modules: ReadonlyMap<string, Uint8Array>,
  moduleMediaTypes: NonNullable<WorkerdSite["moduleMediaTypes"]>,
): {
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly moduleMediaTypes: NonNullable<WorkerdSite["moduleMediaTypes"]>;
} {
  const copied = new Map<string, Uint8Array>();
  for (const [name, bytes] of modules) {
    if (typeof name !== "string" || !(bytes instanceof Uint8Array) || copied.has(name)) invalid();
    copied.set(name, new Uint8Array(bytes));
  }
  if (!isRecord(moduleMediaTypes)) invalid();
  const names = Object.keys(moduleMediaTypes);
  if (names.length !== copied.size) invalid();
  const normalized: Record<string, WorkerdModuleMediaType> = Object.create(null);
  for (const name of names) {
    const mediaType = moduleMediaTypes[name];
    if (!copied.has(name) || !isWorkerdModuleMediaType(mediaType)) invalid();
    normalized[name] = mediaType;
  }
  for (const name of copied.keys()) {
    if (!Object.hasOwn(moduleMediaTypes, name)) invalid();
  }
  if (!copied.has(mainModule) || normalized[mainModule] !== "application/javascript+module") {
    invalid();
  }
  return { modules: copied, moduleMediaTypes: normalized };
}

function snapshotAssets(assets: WorkerdVersionGraphInput["assets"]):
  | {
      readonly files: ReadonlyMap<string, Uint8Array>;
      readonly configuration: NonNullable<WorkerdSite["assets"]>;
    }
  | undefined {
  if (assets === undefined) return undefined;
  if (
    !isRecord(assets) ||
    !isRecord(assets.mediaTypes) ||
    (assets.notFoundHandling !== "none" && assets.notFoundHandling !== "single-page-application") ||
    typeof assets.runWorkerFirst !== "boolean" ||
    !assets.files ||
    typeof assets.files[Symbol.iterator] !== "function"
  ) {
    invalid();
  }
  const copied = new Map<string, Uint8Array>();
  for (const [name, bytes] of assets.files as ReadonlyMap<unknown, unknown>) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !(bytes instanceof Uint8Array) ||
      copied.has(name)
    ) {
      invalid();
    }
    copied.set(name, new Uint8Array(bytes));
  }
  if (copied.size === 0) invalid();
  const mediaNames = Object.keys(assets.mediaTypes);
  if (mediaNames.length !== copied.size) invalid();
  const mediaTypes: Record<string, string> = Object.create(null);
  for (const name of mediaNames) {
    const mediaType = assets.mediaTypes[name];
    if (!copied.has(name) || typeof mediaType !== "string" || mediaType.length === 0) {
      invalid();
    }
    mediaTypes[name] = mediaType;
  }
  for (const name of copied.keys()) {
    if (!Object.hasOwn(assets.mediaTypes, name)) invalid();
  }
  return {
    files: copied,
    configuration: {
      notFoundHandling: assets.notFoundHandling,
      runWorkerFirst: assets.runWorkerFirst,
      mediaTypes,
    },
  };
}

function isWorkerdModuleMediaType(value: unknown): value is WorkerdModuleMediaType {
  return (WORKERD_MODULE_MEDIA_TYPES as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new TypeError("invalid Workerd Version graph");
}
