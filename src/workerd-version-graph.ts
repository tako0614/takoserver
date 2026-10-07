import { parseActorAbiRef } from "./actor-abi-ref.ts";
import {
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "./providers/selfhost-data-service.ts";
import {
  SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
  SELFHOST_WORKER_EVENT_SERVICE_MODULE,
  SELFHOST_WORKER_EVENT_TARGET_BINDING,
  SELFHOST_WORKER_EVENT_TOKEN_BINDING,
  selfhostEventServiceSource,
} from "./providers/selfhost-events.ts";
import {
  SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE,
  selfhostV2ObjectBucketDataServiceSource,
} from "./providers/selfhost-v2-object-bucket-data-service.ts";
import {
  V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
  V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
  v2QueueSettlementServiceSource,
} from "./providers/selfhost-v2-queue-transport.ts";
import {
  normalizeWorkflowBindings,
  type SelfhostVersionWorkflowBinding,
} from "./providers/selfhost-version-bindings.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "./providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_DATA_SERVICE_BINDING,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  type SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  type SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_INTERNAL_BINDING_PREFIX,
  SELFHOST_WORKER_SERVICE_BINDING_KIND,
  type SelfhostWorkerBindingDescriptor,
  selfhostWorkerEntrypointSource,
} from "./providers/selfhost-worker-wrapper.ts";
import {
  WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  WORKERD_V2_PRIVATE_KV_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
  WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING,
  workerdV2PrivateActorBindingName,
  workerdV2PrivateServiceBindingName,
  workerdV2PrivateWorkflowBindingName,
} from "./providers/workerd-v2-private-binding-names.ts";
import {
  renderSelfhostActorForwardRuntimeModuleSource,
  selfhostActorForwardEntrypointSource,
} from "./selfhost-actor-forward-worker-wrapper.ts";
import {
  renderSelfhostWorkflowBindingRuntimeModuleSource,
  SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE,
  SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
  selfhostWorkflowBindingEntrypointSource,
} from "./selfhost-workflow-binding-worker-wrapper.ts";
import type {
  WorkerdActorForward,
  WorkerdActorForwardBinding,
  WorkerdModuleMediaType,
  WorkerdSite,
  WorkerdWorkflowForward,
  WorkerdWorkflowForwardBinding,
} from "./workerd-runtime.ts";

const SELFHOST_ACTOR_FORWARD_ENTRYPOINT_MODULE =
  "__takoserver-selfhost-actor-forward-entrypoint.js" as const;
const SELFHOST_ACTOR_FORWARD_RUNTIME_MODULE =
  "__takoserver-selfhost-actor-forward-runtime.js" as const;
const ACTOR_FORWARD_PUBLIC_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const PUBLIC_VAR_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const ACTOR_FORWARD_RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;
const ACTOR_FORWARD_TOKEN = /^[a-f0-9]{64}$/u;

type WorkerdDataBindingKind =
  | typeof SELFHOST_WORKER_EDGE_KV_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_SQL_BINDING_KIND
  | typeof SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND;

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
  /** Host-owned v2 path grammar; omitted for retained v1 code assets. */
  readonly strictPaths?: true;
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
  /** Exact WorkerVersion-scoped signed grant, separate from the generic plane token. */
  readonly v2ObjectBucketBinding?: {
    readonly address: string;
    readonly token: string;
    readonly bindings: readonly { readonly publicName: string }[];
  };
  /** Exact selected-Version signed KV grant, separate from the generic SQL plane. */
  readonly v2KvBinding?: {
    readonly address: string;
    readonly token: string;
    readonly bindings: readonly { readonly publicName: string }[];
  };
  /** Exact selected-Version Queue producer grant, separate from settlement. */
  readonly v2QueueProducerBinding?: {
    readonly address: string;
    readonly token: string;
    readonly bindings: readonly { readonly publicName: string }[];
  };
  readonly serviceBindings: readonly WorkerdServiceBinding[];
  /** Unpublished opt-in forwarding facades for exact Host-owned Actor namespaces. */
  readonly actorForward?: readonly {
    readonly publicName: string;
    readonly tenantId: string;
    readonly namespaceResourceUid: string;
    readonly token: string;
    readonly runtimeClassRef?: WorkerdActorForwardBinding["runtimeClassRef"];
  }[];
  /** Unpublished opt-in bindings projected from one exact immutable V10 snapshot. */
  readonly workflowForward?: {
    readonly snapshotDigest: `sha256:${string}`;
    readonly bindings: readonly (Omit<SelfhostVersionWorkflowBinding, "name"> & {
      readonly publicName: string;
      readonly token: string;
    })[];
  };
  readonly hostnames: readonly string[];
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly declaredHandlers: readonly ("fetch" | "queue" | "scheduled")[];
  readonly readiness: {
    readonly publication: string;
    readonly probeHostname: string;
  };
  readonly eventToken?: string;
  /** Required at boot for the opt-in v2 queue handler, not resolved per call. */
  readonly v2QueueSettlement?: { readonly address: string; readonly token: string };
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
  const v2PrivateNames =
    typeof input.generation === "string" &&
    /^takoserver-v2-operation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.generation,
    );

  const { modules, moduleMediaTypes } = snapshotModules(
    input.mainModule,
    input.modules,
    input.moduleMediaTypes,
  );
  const assets = snapshotAssets(input.assets);
  const environment = projectEnvironment(input.environment);
  const dataPlane = projectDataPlane(input.dataPlane);
  const v2ObjectBucketBinding = projectV2ObjectBucketBinding(
    input.v2ObjectBucketBinding,
    v2PrivateNames,
  );
  const v2KvBinding = projectV2KvBinding(input.v2KvBinding, v2PrivateNames);
  const v2QueueProducerBinding = projectV2KvBinding(input.v2QueueProducerBinding, v2PrivateNames);
  const serviceBindings = projectServiceBindings(input.serviceBindings);
  const actorForward = projectActorForward(input.actorForward, v2PrivateNames);
  const workflowForward = projectWorkflowForward(
    input.workflowForward,
    {
      environment: environment.vars,
      dataPlane,
      serviceBindings,
      actorForward,
    },
    v2PrivateNames,
  );
  if (serviceBindings.length > 0 && input.workerResourceUid === undefined) invalid();
  const eventToken = projectOpaqueToken(input.eventToken);
  const v2QueueSettlement = input.v2QueueSettlement;
  if (
    v2QueueSettlement !== undefined &&
    (!isRecord(v2QueueSettlement) ||
      typeof v2QueueSettlement.address !== "string" ||
      v2QueueSettlement.address.length === 0 ||
      typeof v2QueueSettlement.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(v2QueueSettlement.token) ||
      eventToken === undefined ||
      !input.declaredHandlers.includes("queue"))
  )
    invalid();

  const services = serviceBindings.map((binding, index) => ({
    name: serviceBindingName(index, v2PrivateNames),
    target: binding.target,
    targetResourceUid: binding.targetResourceUid,
    unavailableToken: binding.unavailableToken,
  }));
  const bindings: SelfhostWorkerBindingDescriptor[] = [
    ...environment.descriptors,
    ...(dataPlane === undefined ? [] : dataPlane.descriptors),
    ...(v2ObjectBucketBinding === undefined
      ? []
      : v2ObjectBucketBinding.bindings.map((binding) => ({
          kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
          publicName: binding.publicName,
          internalName: WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
        }))),
    ...(v2KvBinding === undefined
      ? []
      : v2KvBinding.bindings.map((binding) => ({
          kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
          publicName: binding.publicName,
          internalName: WORKERD_V2_PRIVATE_KV_BINDING,
        }))),
    ...(v2QueueProducerBinding === undefined
      ? []
      : v2QueueProducerBinding.bindings.map((binding) => ({
          kind: SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
          publicName: binding.publicName,
          internalName: WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING,
        }))),
    ...services.map((service, index) => ({
      kind: SELFHOST_WORKER_SERVICE_BINDING_KIND,
      publicName: serviceBindings[index]?.publicName as string,
      internalName: service.name,
      unavailableToken: service.unavailableToken,
    })),
  ];
  const wrapperSource = selfhostWorkerEntrypointSource(
    {
      originalMainModule: input.mainModule,
      declaredHandlers: input.declaredHandlers,
      bindings: [
        ...bindings,
        ...(actorForward?.bindings.map((binding) => ({
          name: binding.publicName,
          type: "json" as const,
        })) ?? []),
        ...(workflowForward?.bindings.map((binding) => ({
          name: binding.publicName,
          type: "json" as const,
        })) ?? []),
      ],
      publication: input.readiness.publication,
      probeHostname: input.readiness.probeHostname,
      ...(eventToken === undefined ? {} : { events: true }),
      ...(v2QueueSettlement === undefined ? {} : { v2Queue: true }),
    },
    v2PrivateNames,
  );

  const preludeModule = selfhostWorkerPreludeModuleName(input.mainModule);
  const encoder = new TextEncoder();
  const wrapperModule = v2PrivateNames
    ? WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE
    : SELFHOST_WORKER_ENTRYPOINT_MODULE;
  const hostEntrypoint =
    workflowForward !== undefined
      ? SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE
      : actorForward === undefined
        ? wrapperModule
        : SELFHOST_ACTOR_FORWARD_ENTRYPOINT_MODULE;
  const hostModules = new Map<string, Uint8Array>([
    [wrapperModule, encoder.encode(wrapperSource)],
    [preludeModule, encoder.encode(selfhostWorkerPreludeSource())],
  ]);
  if (v2ObjectBucketBinding !== undefined) {
    hostModules.set(
      SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE,
      encoder.encode(selfhostV2ObjectBucketDataServiceSource()),
    );
  }
  const innerEntrypoint =
    actorForward === undefined ? wrapperModule : SELFHOST_ACTOR_FORWARD_ENTRYPOINT_MODULE;
  if (actorForward !== undefined) {
    hostModules.set(
      SELFHOST_ACTOR_FORWARD_ENTRYPOINT_MODULE,
      encoder.encode(
        selfhostActorForwardEntrypointSource({
          runtimeModule: SELFHOST_ACTOR_FORWARD_RUNTIME_MODULE,
          innerModule: wrapperModule,
          bindings: actorForward.bindings,
          queue: input.declaredHandlers.includes("queue"),
          scheduled: input.declaredHandlers.includes("scheduled"),
          ...(eventToken === undefined ? {} : { events: true }),
          ...(workflowForward === undefined ? {} : { projectEnvironment: true }),
        }),
      ),
    );
    hostModules.set(
      SELFHOST_ACTOR_FORWARD_RUNTIME_MODULE,
      encoder.encode(renderSelfhostActorForwardRuntimeModuleSource()),
    );
  }
  if (workflowForward !== undefined) {
    hostModules.set(
      SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE,
      encoder.encode(
        selfhostWorkflowBindingEntrypointSource({
          runtimeModule: SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
          innerModule: innerEntrypoint,
          bindings: workflowForward.bindings.map(({ publicName, serviceName, token }) => ({
            publicName,
            serviceName,
            token,
          })),
          queue: input.declaredHandlers.includes("queue"),
          scheduled: input.declaredHandlers.includes("scheduled"),
          ...(eventToken === undefined ? {} : { events: true }),
        }),
      ),
    );
    hostModules.set(
      SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
      encoder.encode(renderSelfhostWorkflowBindingRuntimeModuleSource()),
    );
  }
  if (
    dataPlane !== undefined ||
    v2KvBinding !== undefined ||
    v2QueueProducerBinding !== undefined
  ) {
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
  if (v2QueueSettlement !== undefined) {
    hostModules.set(
      V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
      encoder.encode(v2QueueSettlementServiceSource()),
    );
  }

  const site: WorkerdSite = {
    directory: input.directory,
    mainModule: input.mainModule,
    hostEntrypoint,
    hostModules: [
      preludeModule,
      ...(actorForward === undefined && workflowForward === undefined ? [] : [wrapperModule]),
      ...(actorForward === undefined ? [] : [SELFHOST_ACTOR_FORWARD_RUNTIME_MODULE]),
      ...(workflowForward === undefined
        ? []
        : [
            ...(actorForward === undefined ? [] : [SELFHOST_ACTOR_FORWARD_ENTRYPOINT_MODULE]),
            SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
          ]),
    ],
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
    ...(actorForward === undefined ? {} : { actorForward }),
    ...(workflowForward === undefined ? {} : { workflowForward }),
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
    ...(v2ObjectBucketBinding === undefined
      ? {}
      : {
          v2ObjectBucketPlane: {
            address: v2ObjectBucketBinding.address,
            token: v2ObjectBucketBinding.token,
          },
        }),
    ...(v2KvBinding === undefined
      ? {}
      : {
          v2KvPlane: {
            address: v2KvBinding.address,
            token: v2KvBinding.token,
          },
        }),
    ...(v2QueueProducerBinding === undefined
      ? {}
      : {
          v2QueueProducerPlane: {
            address: v2QueueProducerBinding.address,
            token: v2QueueProducerBinding.token,
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
    ...(v2QueueSettlement === undefined
      ? {}
      : {
          queueSettlement: {
            address: v2QueueSettlement.address,
            module: V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
            vars: [
              {
                name: V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
                value: v2QueueSettlement.token,
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
      !PUBLIC_VAR_NAME.test(entry.name) ||
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

function projectV2ObjectBucketBinding(
  input: WorkerdVersionGraphInput["v2ObjectBucketBinding"],
  v2PrivateNames: boolean,
): WorkerdVersionGraphInput["v2ObjectBucketBinding"] {
  if (input === undefined) return undefined;
  if (
    !isRecord(input) ||
    !v2PrivateNames ||
    Object.keys(input).sort().join(",") !== "address,bindings,token" ||
    typeof input.address !== "string" ||
    !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(input.address) ||
    typeof input.token !== "string" ||
    input.token.length > 32_768 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(input.token) ||
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0
  ) {
    invalid();
  }
  const seen = new Set<string>();
  const bindings = input.bindings.map((binding) => {
    if (
      !isRecord(binding) ||
      Object.keys(binding).sort().join(",") !== "publicName" ||
      typeof binding.publicName !== "string" ||
      !PUBLIC_VAR_NAME.test(binding.publicName) ||
      seen.has(binding.publicName)
    ) {
      invalid();
    }
    seen.add(binding.publicName);
    return { publicName: binding.publicName };
  });
  return { address: input.address, token: input.token, bindings };
}

function projectV2KvBinding(
  input: WorkerdVersionGraphInput["v2KvBinding"],
  v2PrivateNames: boolean,
): WorkerdVersionGraphInput["v2KvBinding"] {
  if (input === undefined) return undefined;
  if (
    !isRecord(input) ||
    !v2PrivateNames ||
    Object.keys(input).sort().join(",") !== "address,bindings,token" ||
    typeof input.address !== "string" ||
    !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(input.address) ||
    Number(input.address.slice(input.address.lastIndexOf(":") + 1)) > 65_535 ||
    typeof input.token !== "string" ||
    input.token.length > 32_768 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(input.token) ||
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0
  ) {
    invalid();
  }
  const seen = new Set<string>();
  const bindings = input.bindings.map((binding) => {
    if (
      !isRecord(binding) ||
      Object.keys(binding).sort().join(",") !== "publicName" ||
      typeof binding.publicName !== "string" ||
      !PUBLIC_VAR_NAME.test(binding.publicName) ||
      seen.has(binding.publicName)
    ) {
      invalid();
    }
    seen.add(binding.publicName);
    return { publicName: binding.publicName };
  });
  return { address: input.address, token: input.token, bindings };
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

function projectActorForward(
  actorForward: WorkerdVersionGraphInput["actorForward"],
  v2PrivateNames: boolean,
): WorkerdActorForward | undefined {
  if (actorForward === undefined) return undefined;
  if (!Array.isArray(actorForward) || actorForward.length === 0 || actorForward.length > 64)
    invalid();
  const names = new Set<string>();
  const bindings: WorkerdActorForwardBinding[] = actorForward.map((binding, index) => {
    if (!isRecord(binding)) invalid();
    if (
      typeof binding.publicName !== "string" ||
      !ACTOR_FORWARD_PUBLIC_NAME.test(binding.publicName) ||
      names.has(binding.publicName) ||
      typeof binding.tenantId !== "string" ||
      binding.tenantId.length === 0 ||
      binding.tenantId.length > 256 ||
      binding.tenantId.includes("\u0000") ||
      typeof binding.namespaceResourceUid !== "string" ||
      !ACTOR_FORWARD_RESOURCE_UID.test(binding.namespaceResourceUid) ||
      typeof binding.token !== "string" ||
      !ACTOR_FORWARD_TOKEN.test(binding.token)
    ) {
      invalid();
    }
    names.add(binding.publicName);
    const declaredRef = binding.runtimeClassRef;
    let runtimeClassRef: WorkerdActorForwardBinding["runtimeClassRef"];
    if (declaredRef !== undefined) {
      const selected = parseActorAbiRef(declaredRef);
      if (selected?.kind !== "v2") invalid();
      runtimeClassRef = selected.ref;
    }
    return {
      publicName: binding.publicName,
      tenantId: binding.tenantId,
      namespaceResourceUid: binding.namespaceResourceUid,
      httpService: v2PrivateNames
        ? workerdV2PrivateActorBindingName("HTTP", index)
        : `__TAKOSERVER_ACTOR_HTTP_${index.toString(10).padStart(5, "0")}`,
      upgradeService: v2PrivateNames
        ? workerdV2PrivateActorBindingName("UPGRADE", index)
        : `__TAKOSERVER_ACTOR_UPGRADE_${index.toString(10).padStart(5, "0")}`,
      token: binding.token,
      ...(runtimeClassRef === undefined ? {} : { runtimeClassRef }),
    };
  });
  return { schema: "takoserver.selfhost-actor-forward@v1", bindings };
}

function projectWorkflowForward(
  workflowForward: WorkerdVersionGraphInput["workflowForward"],
  existing: {
    readonly environment: ReturnType<typeof projectEnvironment>["vars"];
    readonly dataPlane: ReturnType<typeof projectDataPlane>;
    readonly serviceBindings: readonly WorkerdServiceBinding[];
    readonly actorForward: WorkerdActorForward | undefined;
  },
  v2PrivateNames: boolean,
): WorkerdWorkflowForward | undefined {
  if (workflowForward === undefined) return undefined;
  let snapshot: unknown;
  try {
    snapshot = structuredClone(workflowForward);
  } catch {
    invalid();
  }
  if (
    !isRecord(snapshot) ||
    !exactKeys(snapshot, ["bindings", "snapshotDigest"]) ||
    typeof snapshot.snapshotDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(snapshot.snapshotDigest) ||
    !Array.isArray(snapshot.bindings) ||
    snapshot.bindings.length === 0 ||
    snapshot.bindings.length > 64
  ) {
    invalid();
  }

  const publicNames = new Set<string>();
  const tokenByPublicName = new Map<string, string>();
  const normalizedInput: SelfhostVersionWorkflowBinding[] = [];
  for (const candidate of snapshot.bindings) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        "bindingRef",
        "publicName",
        "runtimeClassRef",
        "tenantId",
        "token",
        "workflowFormRef",
        "workflowResourceUid",
      ]) ||
      typeof candidate.publicName !== "string" ||
      !ACTOR_FORWARD_PUBLIC_NAME.test(candidate.publicName) ||
      (!v2PrivateNames &&
        candidate.publicName.startsWith(SELFHOST_WORKER_INTERNAL_BINDING_PREFIX)) ||
      typeof candidate.token !== "string" ||
      !ACTOR_FORWARD_TOKEN.test(candidate.token) ||
      publicNames.has(candidate.publicName)
    ) {
      invalid();
    }
    publicNames.add(candidate.publicName);
    tokenByPublicName.set(candidate.publicName, candidate.token);
    normalizedInput.push({
      name: candidate.publicName,
      tenantId: candidate.tenantId as string,
      workflowResourceUid: candidate.workflowResourceUid as string,
      workflowFormRef:
        candidate.workflowFormRef as SelfhostVersionWorkflowBinding["workflowFormRef"],
      bindingRef: candidate.bindingRef as SelfhostVersionWorkflowBinding["bindingRef"],
      runtimeClassRef:
        candidate.runtimeClassRef as SelfhostVersionWorkflowBinding["runtimeClassRef"],
    });
  }

  const collidingPublicNames = new Set<string>([
    ...existing.environment.map((entry) => entry.name),
    ...(existing.dataPlane?.descriptors.flatMap((binding) =>
      "publicName" in binding ? [binding.publicName] : [],
    ) ?? []),
    ...existing.serviceBindings.map((binding) => binding.publicName),
    ...(existing.actorForward?.bindings.map((binding) => binding.publicName) ?? []),
  ]);
  for (const name of publicNames) {
    if (collidingPublicNames.has(name)) invalid();
  }

  let normalized: readonly SelfhostVersionWorkflowBinding[] | undefined;
  try {
    normalized = normalizeWorkflowBindings(normalizedInput);
  } catch {
    invalid();
  }
  if (normalized === undefined || normalized.length !== snapshot.bindings.length) invalid();
  const collidingBindingNames = new Set<string>([
    ...collidingPublicNames,
    ...existing.serviceBindings.map((_, index) => serviceBindingName(index, v2PrivateNames)),
    ...(existing.actorForward?.bindings.flatMap((binding) => [
      binding.httpService,
      binding.upgradeService,
    ]) ?? []),
    v2PrivateNames ? WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING : SELFHOST_WORKER_DATA_SERVICE_BINDING,
    ...(v2PrivateNames ? [] : [SELFHOST_WORKER_EVENT_TARGET_BINDING]),
  ]);
  for (let index = 0; index < normalized.length; index += 1) {
    const binding = normalized[index];
    if (binding === undefined || collidingBindingNames.has(binding.name)) invalid();
    if (
      collidingBindingNames.has(
        v2PrivateNames
          ? workerdV2PrivateWorkflowBindingName(index)
          : `__TAKOSERVER_WORKFLOW_BINDING_${index.toString(10).padStart(5, "0")}`,
      )
    ) {
      invalid();
    }
  }
  return {
    schema: "takoserver.selfhost-workflow-binding-forward@v1",
    snapshotDigest: snapshot.snapshotDigest as `sha256:${string}`,
    bindings: normalized.map((binding, index): WorkerdWorkflowForwardBinding => {
      const token = tokenByPublicName.get(binding.name);
      if (token === undefined) invalid();
      return {
        publicName: binding.name,
        serviceName: v2PrivateNames
          ? workerdV2PrivateWorkflowBindingName(index)
          : `__TAKOSERVER_WORKFLOW_BINDING_${index.toString(10).padStart(5, "0")}`,
        tenantId: binding.tenantId,
        workflowResourceUid: binding.workflowResourceUid,
        workflowFormRef: binding.workflowFormRef,
        bindingRef: binding.bindingRef,
        runtimeClassRef: binding.runtimeClassRef,
        token,
      };
    }),
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function projectOpaqueToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function serviceBindingName(index: number, v2PrivateNames: boolean): string {
  if (v2PrivateNames) return workerdV2PrivateServiceBindingName(index);
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
    (assets.strictPaths !== undefined && assets.strictPaths !== true) ||
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
      ...(assets.strictPaths === true ? { strictPaths: true as const } : {}),
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
