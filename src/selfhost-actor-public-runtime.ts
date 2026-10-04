import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseActorAbiRef } from "./actor-abi-ref.ts";
import { canonicalJson, isSha256Digest } from "./json.ts";
import { selfhostVersionBindingsRoot } from "./providers/selfhost.ts";
import {
  createSelfhostVersionBindingStore,
  deriveSelfhostActorForwardToken,
} from "./providers/selfhost-version-bindings.ts";
import {
  snapshotWorkerActorClassExpectedGraph,
  type WorkerActorClassExpectedGraph,
  type WorkerModuleInspectionModule,
} from "./providers/worker-module-semantic-inspection.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import { createSelfhostActorExecutionHost } from "./selfhost-actor-execution-host.ts";
import { openSelfhostActorForwardBrokers } from "./selfhost-actor-forward-brokers.ts";
import type {
  ActorResourceGraphReader,
  ProviderWorkerClassRuntime,
  WorkerClassInspectionInput,
  WorkerClassInspectionVerdict,
} from "./worker-class-runtime-port.ts";
import type {
  WorkerdActorForwardPublication,
  WorkerdActorForwardSocket,
} from "./workerd-runtime.ts";
import { readWorkerdActiveActorGraph } from "./workerd-runtime.ts";
import { createWorkerdWorkerModuleInspector } from "./workerd-worker-module-inspector.ts";

const OWNED_ACTOR_RUNTIME = Symbol("owned self-host Actor runtime");
const MAX_SOCKET_PAIRS = 128;

type ExecutionHost = ReturnType<typeof createSelfhostActorExecutionHost>;
type ActiveWorkerDeployment = Awaited<ReturnType<ResourceDeploymentStore["active"]>>;
type SelfhostActorClassInspectionInput = Parameters<ProviderWorkerClassRuntime["inspect"]>[0];
type ForwardBrokers = Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>>;

export interface SelfhostActorPublicRuntime {
  readonly [OWNED_ACTOR_RUNTIME]: true;
  readonly actorNamespace: Pick<
    ExecutionHost,
    | "readCurrentGraph"
    | "registerNamespace"
    | "hasNamespace"
    | "namespaceAbsent"
    | "forgetNamespace"
  >;
  readonly inspectWorkerClass: (
    input: SelfhostActorClassInspectionInput,
    expectedGraph: WorkerActorClassExpectedGraph,
  ) => Promise<WorkerClassInspectionVerdict>;
  readonly actorForwardLifecycle: {
    prepare(publications: readonly WorkerdActorForwardPublication[]): Promise<void>;
    reserve(publications: readonly WorkerdActorForwardPublication[]): Promise<{
      release(): Promise<void>;
    }>;
    activated(publications: readonly WorkerdActorForwardPublication[]): void;
    uncertain(): void;
  };
  actorForwardSockets(): readonly WorkerdActorForwardSocket[];
  isOpen(): boolean;
  isRestored(): boolean;
  close(): Promise<void>;
}

/** Only the completed native owner can grant this composition capability. */
export function isOwnedSelfhostActorPublicRuntime(
  value: SelfhostActorPublicRuntime | undefined,
): value is SelfhostActorPublicRuntime {
  return value?.[OWNED_ACTOR_RUNTIME] === true;
}

function brokerKey(binding: {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly token: string;
}): string {
  return JSON.stringify([binding.tenantId, binding.namespaceResourceUid, binding.token]);
}

function validActorClassInspectionInput(
  input: SelfhostActorClassInspectionInput,
  providerInstallationRef: string,
): boolean {
  if (
    input.providerInstallationRef !== providerInstallationRef ||
    input.contract.formRef.apiVersion !== "edge.forms.takoform.com" ||
    input.contract.formRef.kind !== "ActorNamespace" ||
    !isSha256Digest(input.contract.packageDigest) ||
    parseActorAbiRef(input.contract.runtimeClassRef)?.kind !== "v2" ||
    input.holderNativeId !== `selfhost-actor:${input.holder.uid}` ||
    !parseSelfhostVersionNativeId(input.versionNativeId) ||
    input.holder.formRef.apiVersion !== input.contract.formRef.apiVersion ||
    input.holder.formRef.kind !== input.contract.formRef.kind ||
    input.holder.formRef.definitionVersion !== input.contract.formRef.definitionVersion ||
    input.holder.formRef.schemaDigest !== input.contract.formRef.schemaDigest ||
    input.worker.formRef.kind !== "ModuleWorker" ||
    input.deployment.formRef.kind !== "WorkerDeployment" ||
    input.version.formRef.kind !== "WorkerVersion" ||
    input.bundle.formRef.kind !== "WorkerBundle" ||
    !isSha256Digest(input.bundle.manifestDigest) ||
    !Number.isSafeInteger(input.weight) ||
    input.weight !== 10_000 ||
    typeof input.className !== "string" ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(input.className) ||
    !input.tenantId ||
    !input.space
  )
    return false;
  return [input.holder, input.worker, input.deployment, input.version, input.bundle].every(
    (identity) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(identity.uid) &&
      Boolean(identity.generation) &&
      Boolean(identity.revision),
  );
}

function parseSelfhostVersionNativeId(
  value: string,
): { readonly script: string; readonly versionId: string } | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  const parts = value.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "selfhost-version" ||
    !parts[1] ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(parts[1]) ||
    !parts[2] ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(parts[2]) ||
    !parts[3] ||
    parts[3].includes("\0")
  )
    return null;
  return { script: parts[1], versionId: parts[2] };
}

function matchesActorClassGraph(
  input: WorkerClassInspectionInput,
  graph: Awaited<ReturnType<ExecutionHost["readCurrentGraph"]>>,
): boolean {
  return Boolean(
    graph &&
      graph.tenantId === input.tenantId &&
      graph.namespace.uid === input.holder.uid &&
      graph.namespace.generation === input.holder.generation &&
      graph.namespace.revision === input.holder.revision &&
      graph.namespace.address.space === input.space &&
      graph.namespace.className === input.className &&
      sameFormRef(graph.namespace.formRef, input.holder.formRef) &&
      graph.worker.uid === input.worker.uid &&
      graph.worker.generation === input.worker.generation &&
      graph.worker.revision === input.worker.revision &&
      sameFormRef(graph.worker.formRef, input.worker.formRef) &&
      graph.runtimeClassRef !== undefined &&
      canonicalJson(graph.runtimeClassRef) === canonicalJson(input.contract.runtimeClassRef),
  );
}

function matchesActorClassDeployment(
  deployment: ActiveWorkerDeployment,
  input: WorkerClassInspectionInput,
  script: string,
  options: {
    readonly providerPackRef: string;
    readonly providerInstallationRef: string;
  },
): boolean {
  return Boolean(
    deployment &&
      deployment.tenantId === input.tenantId &&
      deployment.resourceUid === input.worker.uid &&
      deployment.state === "active" &&
      deployment.providerPackRef === options.providerPackRef &&
      deployment.providerInstallationRef === options.providerInstallationRef &&
      deployment.nativeId.startsWith(`selfhost-worker:${script}:`) &&
      deployment.nativeId !== `selfhost-worker:${script}:` &&
      deployment.observed.scriptName === script &&
      deployment.outputs.scriptName === script,
  );
}

function sameFormRef(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function sameWorkerdActorGraph(
  left: Awaited<ReturnType<typeof readWorkerdActiveActorGraph>>,
  right: Awaited<ReturnType<typeof readWorkerdActiveActorGraph>>,
): boolean {
  if (
    !left ||
    !right ||
    left.generation !== right.generation ||
    left.generationKey !== right.generationKey ||
    left.workerResourceUid !== right.workerResourceUid ||
    left.versions.length !== right.versions.length
  )
    return false;
  return left.versions.every((version, index) => {
    const other = right.versions[index];
    return Boolean(
      other &&
        version.versionId === other.versionId &&
        version.workerVersionUid === other.workerVersionUid &&
        version.weight === other.weight &&
        version.variantKey === other.variantKey &&
        version.site.mainModule === other.site.mainModule &&
        canonicalJson(version.site.moduleMediaTypes ?? {}) ===
          canonicalJson(other.site.moduleMediaTypes ?? {}) &&
        sameByteMap(version.modules, other.modules) &&
        sameByteMap(version.hostModules, other.hostModules),
    );
  });
}

function sameByteMap(
  left: ReadonlyMap<string, Uint8Array>,
  right: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) {
    const other = right.get(name);
    if (!other || bytes.byteLength !== other.byteLength) return false;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== other[index]) return false;
    }
  }
  return true;
}

/**
 * One native namespace owner and one volatile, bounded socket graph. No second
 * durable Actor ledger or Version secret is written here. Workerd drives this
 * owner with its exact immutable publication snapshot before every render.
 */
export async function openSelfhostActorPublicRuntime(options: {
  readonly dataRoot: string;
  readonly runtimeRoot: string;
  readonly socketParent: string;
  readonly binary: string;
  readonly graph: ActorResourceGraphReader;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
}): Promise<SelfhostActorPublicRuntime> {
  if (
    !isAbsolute(options.dataRoot) ||
    !isAbsolute(options.runtimeRoot) ||
    !isAbsolute(options.socketParent) ||
    !isAbsolute(options.binary)
  )
    throw new Error("Actor owner configuration unavailable");
  await mkdir(options.socketParent, { recursive: true, mode: 0o700 });
  const socketDirectory = await mkdtemp(join(options.socketParent, "actor-"));
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: options.runtimeRoot,
    storageRoot: join(options.dataRoot, "actor-namespaces"),
    binary: options.binary,
    graph: options.graph,
    deployments: options.deployments,
    providerPackRef: options.providerPackRef,
    providerInstallationRef: options.providerInstallationRef,
  });
  try {
    await host.ready;
  } catch (error) {
    await host.close().catch(() => {});
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
  const classInspector = createWorkerdWorkerModuleInspector({
    binary: options.binary,
    temporaryRoot: join(options.dataRoot, "selfhost", "actor-class-inspection"),
  });
  const inspectWorkerClass: SelfhostActorPublicRuntime["inspectWorkerClass"] = async (
    untrusted,
    untrustedExpectedGraph,
  ) => {
    try {
      const input = structuredClone(untrusted) as SelfhostActorClassInspectionInput;
      const expectedGraph = snapshotWorkerActorClassExpectedGraph(untrustedExpectedGraph);
      if (!validActorClassInspectionInput(input, options.providerInstallationRef))
        return "unavailable";
      const native = parseSelfhostVersionNativeId(input.versionNativeId);
      if (!native) return "unavailable";
      const scope = {
        tenantId: input.tenantId,
        namespaceResourceUid: input.holder.uid,
      };
      const actorGraph = await host.readCurrentGraph(scope, AbortSignal.timeout(30_000));
      if (!actorGraph || !matchesActorClassGraph(input, actorGraph)) return "unavailable";
      const deployment = await options.deployments.active(input.tenantId, input.worker.uid);
      if (!matchesActorClassDeployment(deployment, input, native.script, options))
        return "unavailable";
      const active = await readWorkerdActiveActorGraph(
        options.runtimeRoot,
        native.script,
        input.worker.uid,
      );
      const selected = active?.versions.find(
        (version) =>
          version.versionId === native.versionId &&
          version.workerVersionUid === input.version.uid &&
          version.weight === input.weight,
      );
      // Until the class port carries a complete weighted Version set, never
      // claim one class inspection qualifies an additional active Version.
      if (active?.versions.length !== 1 || !selected) return "unavailable";
      if (
        !sameExpectedModules(
          selected.modules,
          expectedGraph.modules,
          selected.site.moduleMediaTypes ?? {},
        )
      )
        return "unavailable";
      if (selected.site.mainModule !== expectedGraph.mainModule) return "unavailable";
      const moduleEntries = [...selected.modules].map(([name, bytes]) => {
        const mediaType = selected.site.moduleMediaTypes?.[name] ?? "application/javascript+module";
        return {
          name,
          bytes: new Uint8Array(bytes),
          mediaType,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
        };
      });
      let verdict: WorkerClassInspectionVerdict;
      try {
        const result = await classInspector.inspectActorClass({
          mainModule: selected.site.mainModule,
          modules: moduleEntries,
          className: input.className,
          runtimeClassRef: input.contract.runtimeClassRef,
        });
        verdict =
          result.outcome === "valid"
            ? "valid"
            : result.outcome === "invalid"
              ? "invalid"
              : "unavailable";
      } catch {
        return "unavailable";
      }
      const [afterGraph, afterDeployment, afterActive] = await Promise.all([
        host.readCurrentGraph(scope, AbortSignal.timeout(30_000)),
        options.deployments.active(input.tenantId, input.worker.uid),
        readWorkerdActiveActorGraph(options.runtimeRoot, native.script, input.worker.uid),
      ]);
      if (
        !afterGraph ||
        !matchesActorClassGraph(input, afterGraph) ||
        !matchesActorClassDeployment(afterDeployment, input, native.script, options) ||
        JSON.stringify(deployment) !== JSON.stringify(afterDeployment) ||
        !sameWorkerdActorGraph(active, afterActive)
      )
        return "unavailable";
      return verdict;
    } catch {
      return "unavailable";
    }
  };
  const actorNamespace = host;
  const versionBindings = createSelfhostVersionBindingStore({
    root: selfhostVersionBindingsRoot(options.dataRoot),
  });
  const brokers = new Map<string, ForwardBrokers>();
  const draining = new Set<{ readonly key: string; readonly pair: ForwardBrokers }>();
  const reservations = new Map<string, number>();
  const everAdmitted = new WeakSet<ForwardBrokers>();
  let admitted = new Set<string>();
  let closed = false;
  let restored = false;
  let uncertain = false;
  let brokerOrdinal = 0;
  let brokerTail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const exclusiveBroker = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = brokerTail.then(operation, operation);
    brokerTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const prove = async (publication: WorkerdActorForwardPublication): Promise<void> => {
    const stored = await versionBindings.read(publication.script, publication.versionId);
    if (
      !stored ||
      stored.workerResourceUid !== publication.workerResourceUid ||
      stored.workerVersionResourceUid !== publication.workerVersionResourceUid ||
      !stored.eventToken ||
      !stored.actorBindings ||
      stored.actorBindings.length !== publication.bindings.length
    )
      throw new Error("Actor immutable Version authority unavailable");
    for (const binding of publication.bindings) {
      const exact = stored.actorBindings.filter((item) => item.name === binding.publicName);
      const target = exact[0];
      const storedRef = target?.runtimeClassRef;
      const publishedRef = binding.runtimeClassRef;
      const storedAbi = storedRef === undefined ? null : parseActorAbiRef(storedRef);
      const publishedAbi = publishedRef === undefined ? null : parseActorAbiRef(publishedRef);
      if (
        exact.length !== 1 ||
        !target ||
        (storedRef !== undefined && storedAbi?.kind !== "v2") ||
        (publishedRef !== undefined && publishedAbi?.kind !== "v2") ||
        storedAbi?.ref !== publishedAbi?.ref ||
        target.tenantId !== binding.tenantId ||
        target.namespaceResourceUid !== binding.namespaceResourceUid ||
        deriveSelfhostActorForwardToken({
          eventToken: stored.eventToken,
          workerVersionResourceUid: publication.workerVersionResourceUid,
          binding: target,
        }) !== binding.token
      )
        throw new Error("Actor immutable Version relation changed");
      const scope = {
        tenantId: target.tenantId,
        namespaceResourceUid: target.namespaceResourceUid,
      };
      const graph = await host.readCurrentGraph(scope, AbortSignal.timeout(30_000));
      const graphRef = graph?.runtimeClassRef;
      const graphAbi = graphRef === undefined ? null : parseActorAbiRef(graphRef);
      if (
        !graph ||
        (graphRef !== undefined && graphAbi?.kind !== "v2") ||
        storedAbi?.ref !== graphAbi?.ref ||
        graph.worker.uid !== target.workerResourceUid ||
        graph.namespace.className !== target.className ||
        !(await host.hasNamespace(scope))
      )
        throw new Error("Actor namespace authority unavailable");
    }
  };

  const prepareGraph = async (
    publications: readonly WorkerdActorForwardPublication[],
  ): Promise<Set<string>> => {
    if (closed) {
      if (publications.length === 0) return new Set();
      throw new Error("Actor owner closed");
    }
    const requested = new Map<string, (typeof publications)[number]["bindings"][number]>();
    for (const publication of publications) {
      await prove(publication);
      for (const binding of publication.bindings) {
        const key = brokerKey(binding);
        if (!requested.has(key)) requested.set(key, binding);
      }
    }
    const newKeys = [...requested.keys()].filter((key) => !brokers.has(key));
    if (brokers.size + draining.size + newKeys.length > MAX_SOCKET_PAIRS)
      throw new Error("Actor forward socket capacity exceeded");
    const opened: [string, ForwardBrokers][] = [];
    try {
      for (const [key, binding] of requested) {
        if (brokers.has(key)) continue;
        // A retired transport can still hold an old request on this token.
        // A later reweight uses a distinct private pathname until it drains.
        const overlapping = [...draining].some((entry) => entry.key === key);
        const hash = createHash("sha256")
          .update(key)
          .update(overlapping ? `:${++brokerOrdinal}` : "")
          .digest("hex")
          .slice(0, 20);
        const httpSocketPath = join(socketDirectory, `${hash}.h.sock`);
        const upgradeSocketPath = join(socketDirectory, `${hash}.u.sock`);
        if (Buffer.byteLength(upgradeSocketPath) >= 100)
          throw new Error("Actor forward socket path unavailable");
        const pair = await openSelfhostActorForwardBrokers({
          tenantId: binding.tenantId,
          namespaceResourceUid: binding.namespaceResourceUid,
          token: binding.token,
          httpSocketPath,
          upgradeSocketPath,
          executionHost: {
            fetch(scope, request) {
              if (!admitted.has(key)) throw new Error("Actor Version not active");
              return host.fetch(scope, request);
            },
            reserveDuplex(scope, request) {
              if (!admitted.has(key)) throw new Error("Actor Version not active");
              return host.reserveDuplex(scope, request);
            },
          },
        });
        opened.push([key, pair]);
      }
    } catch (error) {
      await Promise.all(opened.map(([, pair]) => pair.close()));
      throw error;
    }
    try {
      for (const publication of publications) await prove(publication);
    } catch (error) {
      await Promise.all(opened.map(([, pair]) => pair.close()));
      throw error;
    }
    for (const [key, pair] of opened) brokers.set(key, pair);
    return new Set(requested.keys());
  };

  const cleanupInactive = async (): Promise<void> => {
    if (uncertain || closed) return;
    for (const [key, pair] of brokers) {
      // `uncertain()` can arrive while an earlier never-admitted pair's
      // hard-close is awaiting its listener. Preserve every remaining pair
      // for exact rollback instead of interpreting revoked admission as a
      // request to retire the rest of the old graph.
      if (uncertain || closed) return;
      if (admitted.has(key) || (reservations.get(key) ?? 0) > 0) continue;
      brokers.delete(key);
      const entry = { key, pair };
      draining.add(entry);
      if (everAdmitted.has(pair)) {
        // Accepted transports are not destroyed to reclaim a slot. The
        // retirement promise removes the slot only after bodies, provisional
        // upgrades and committed duplex sockets settle naturally.
        void pair.retire().then(
          () => draining.delete(entry),
          () => {
            uncertain = true;
            admitted = new Set();
            restored = false;
          },
        );
      } else {
        try {
          await pair.close();
          draining.delete(entry);
        } catch (error) {
          uncertain = true;
          admitted = new Set();
          restored = false;
          throw error;
        }
      }
    }
  };

  const lifecycle = Object.freeze({
    prepare(publications: readonly WorkerdActorForwardPublication[]): Promise<void> {
      return exclusiveBroker(async () => {
        await prepareGraph(publications);
      });
    },
    reserve(publications: readonly WorkerdActorForwardPublication[]) {
      return exclusiveBroker(async () => {
        const keys = await prepareGraph(publications);
        for (const key of keys) reservations.set(key, (reservations.get(key) ?? 0) + 1);
        let released = false;
        return {
          release(): Promise<void> {
            return exclusiveBroker(async () => {
              if (released) return;
              released = true;
              for (const key of keys) {
                const remaining = (reservations.get(key) ?? 1) - 1;
                if (remaining > 0) reservations.set(key, remaining);
                else reservations.delete(key);
              }
              await cleanupInactive();
            });
          },
        };
      });
    },
    activated(publications: readonly WorkerdActorForwardPublication[]): void {
      if (closed) return;
      const next = new Set(publications.flatMap((item) => item.bindings.map(brokerKey)));
      restored = [...next].every((key) => brokers.has(key));
      admitted = restored ? next : new Set();
      uncertain = !restored;
      if (restored) {
        for (const key of next) {
          const pair = brokers.get(key);
          if (pair) everAdmitted.add(pair);
        }
        void exclusiveBroker(cleanupInactive).catch(() => {
          uncertain = true;
          admitted = new Set();
          restored = false;
        });
      }
    },
    uncertain(): void {
      admitted = new Set();
      restored = false;
      uncertain = true;
    },
  });

  return Object.freeze({
    [OWNED_ACTOR_RUNTIME]: true as const,
    actorNamespace,
    inspectWorkerClass,
    actorForwardLifecycle: lifecycle,
    actorForwardSockets: () =>
      closed ? [] : [...brokers.values()].map((pair) => pair.socketMapping),
    isOpen: () => !closed,
    isRestored: () => !closed && restored,
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        restored = false;
        admitted = new Set();
        closing = (async () => {
          await brokerTail;
          const pairs = new Set([...brokers.values(), ...[...draining].map((entry) => entry.pair)]);
          // A failed provisional settlement must not skip the exact native
          // owner's shutdown, nor turn a later close into a false success.
          const brokerResults = await Promise.allSettled(
            [...pairs].map((pair) => Promise.resolve().then(() => pair.close())),
          );
          // A provisional transport may need the native owner alive while its
          // broker settles. Still attempt owner shutdown after any broker error.
          const hostResult = await Promise.allSettled([Promise.resolve().then(() => host.close())]);
          if (
            brokerResults.some((result) => result.status === "rejected") ||
            hostResult[0]?.status === "rejected"
          )
            throw new Error("Actor owner shutdown incomplete");
          await rm(socketDirectory, { recursive: true, force: true });
        })();
      }
      return closing;
    },
  });
}

function sameExpectedModules(
  actual: ReadonlyMap<string, Uint8Array>,
  expected: readonly WorkerModuleInspectionModule[],
  actualMediaTypes: Readonly<Record<string, string>>,
): boolean {
  if (expected.length === 0 || actual.size !== expected.length) return false;
  const seen = new Set<string>();
  for (const entry of expected) {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    const bytes = actual.get(entry.name);
    if (!bytes || bytes.byteLength !== entry.bytes.byteLength) return false;
    if ((actualMediaTypes[entry.name] ?? "application/javascript+module") !== entry.mediaType)
      return false;
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.digest) return false;
    if (entry.bytes.some((byte, index) => byte !== bytes[index])) return false;
  }
  return true;
}
