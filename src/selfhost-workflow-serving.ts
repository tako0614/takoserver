import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canonicalJson } from "./json.ts";
import {
  SELFHOST_WORKFLOW_VERSION_FORM_REF,
  SELFHOST_WORKFLOW_WORKER_FORM_REF,
  selfhostVersionBindingsRoot,
} from "./providers/selfhost.ts";
import {
  createSelfhostVersionBindingStore,
  deriveSelfhostWorkflowBindingToken,
  normalizeWorkflowBindings,
  type SelfhostVersionWorkflowBinding,
} from "./providers/selfhost-version-bindings.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import { openSelfhostWorkflowBindingBroker } from "./selfhost-workflow-binding-broker.ts";
import type { SelfhostWorkflowPrivateOwner } from "./selfhost-workflow-private-owner.ts";
import { sameFormRef } from "./takoform/forms.ts";
import { forwardTakoformCandidates } from "./takoform/forward-candidates.ts";
import type { TakoformStore } from "./takoform/store.ts";
import type { WorkflowResourceGraphReader } from "./worker-class-runtime-port.ts";
import type {
  WorkerdWorkflowForwardBinding,
  WorkerdWorkflowForwardSocket,
} from "./workerd-runtime.ts";
import { isExactWorkflowV3InterfaceRef, WorkflowInstanceError } from "./workflow-instances.ts";

const MAX_BROKERS = 128;
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const SERVICE = /^__TAKOSERVER_WORKFLOW_BINDING_[0-9]{5}$/u;

type Broker = Awaited<ReturnType<typeof openSelfhostWorkflowBindingBroker>>;
type Owner = Pick<SelfhostWorkflowPrivateOwner, "instances" | "close">;
type BrokerEntry = {
  readonly key: string;
  readonly admission: object;
  readonly broker: Broker;
  readonly socket: WorkerdWorkflowForwardSocket;
};

function invalid(): never {
  throw new Error("private Workflow publication authority unavailable");
}

function exactNativeId(nativeId: unknown, prefix: string): boolean {
  return (
    typeof nativeId === "string" &&
    nativeId.startsWith(`${prefix}:`) &&
    nativeId.slice(prefix.length + 1).length > 0 &&
    !nativeId.slice(prefix.length + 1).includes(":")
  );
}

function socketKey(
  publication: SelfhostWorkflowPublication,
  binding: WorkerdWorkflowForwardBinding,
): string {
  return canonicalJson([
    publication.script,
    publication.workerResourceUid,
    publication.versionId,
    publication.workerVersionResourceUid,
    publication.snapshotDigest,
    binding,
  ]);
}

function capture(
  publications: readonly SelfhostWorkflowPublication[],
): readonly SelfhostWorkflowPublication[] {
  if (!Array.isArray(publications) || publications.length > 128) invalid();
  let cloned: readonly SelfhostWorkflowPublication[];
  try {
    cloned = structuredClone(publications);
  } catch {
    return invalid();
  }
  if (!Array.isArray(cloned)) invalid();
  return cloned;
}

function publicationFingerprint(publications: readonly SelfhostWorkflowPublication[]): string {
  return canonicalJson(publications);
}

export type SelfhostWorkflowPublication = Omit<
  WorkerdWorkflowForwardSocket,
  "binding" | "socketPath"
> & {
  readonly bindings: readonly WorkerdWorkflowForwardBinding[];
};

export interface SelfhostWorkflowServing {
  prepare(publications: readonly SelfhostWorkflowPublication[]): Promise<void>;
  reserve(
    publications: readonly SelfhostWorkflowPublication[],
  ): Promise<{ release(): Promise<void> }>;
  activated(publications: readonly SelfhostWorkflowPublication[]): boolean;
  uncertain(): void;
  socketsFor(
    publications: readonly SelfhostWorkflowPublication[],
  ): readonly WorkerdWorkflowForwardSocket[];
  sockets(): readonly WorkerdWorkflowForwardSocket[];
  isRestored(): boolean;
  close(): Promise<void>;
}

export async function openSelfhostWorkflowServing(options: {
  readonly dataRoot: string;
  readonly socketParent: string;
  readonly owner: Owner;
  readonly graph: WorkflowResourceGraphReader;
  readonly resources: Pick<TakoformStore, "resourceWithRelationTargetByUid">;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  /** Internal transport-construction seam; the default is the real UDS broker. */
  readonly openBroker?: typeof openSelfhostWorkflowBindingBroker;
}): Promise<SelfhostWorkflowServing> {
  if (
    !isAbsolute(options.dataRoot) ||
    !isAbsolute(options.socketParent) ||
    !options.providerPackRef ||
    !options.providerInstallationRef
  )
    invalid();
  await mkdir(options.socketParent, { recursive: true, mode: 0o700 });
  const parent = await lstat(options.socketParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && parent.uid !== process.getuid()) ||
    (await realpath(options.socketParent)) !== options.socketParent
  )
    invalid();
  const directory = await mkdtemp(join(options.socketParent, "workflow-"));
  if (Buffer.byteLength(join(directory, "01234567890123456789.sock")) > 100) {
    await rm(directory, { recursive: true, force: true });
    invalid();
  }
  const native = createSelfhostVersionBindingStore({
    root: selfhostVersionBindingsRoot(options.dataRoot),
  });
  const selected = forwardTakoformCandidates();
  const workflowForm = selected.forms.find(
    (form) => form.identity.formRef.kind === "DurableWorkflow",
  );
  const workerForm = selected.forms.find((form) => form.identity.formRef.kind === "ModuleWorker");
  const versionForm = selected.forms.find((form) => form.identity.formRef.kind === "WorkerVersion");
  const bindingRef = selected.bindings.find(
    (binding) => binding.bindingRef.name === "module-worker.workflow",
  )?.bindingRef;
  const runtimeRef = workflowForm?.workerClassRuntime?.runtimeClassRef;
  if (
    !workflowForm ||
    !workerForm ||
    !versionForm ||
    !bindingRef ||
    workflowForm.identity.formRef.definitionVersion !== "0.2.0" ||
    !sameFormRef(workerForm.identity.formRef, SELFHOST_WORKFLOW_WORKER_FORM_REF) ||
    !sameFormRef(versionForm.identity.formRef, SELFHOST_WORKFLOW_VERSION_FORM_REF) ||
    bindingRef.version !== "3.0.0" ||
    !isExactWorkflowV3InterfaceRef(runtimeRef)
  ) {
    await rm(directory, { recursive: true, force: true });
    invalid();
  }

  const brokers = new Map<string, BrokerEntry>();
  const draining = new Set<BrokerEntry>();
  const reservations = new Map<string, number>();
  const reservedGraphs = new Map<string, number>();
  const everAdmitted = new WeakSet<Broker>();
  const retired = new WeakSet<Broker>();
  let admitted = new Set<object>();
  let admittedFingerprint: string | undefined;
  let reservationEpoch = 0;
  let restored = false;
  let uncertain = false;
  let closed = false;
  let ordinal = 0;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let ownerClosed = false;
  const markUncertain = (): void => {
    uncertain = true;
    restored = false;
    admitted = new Set();
    admittedFingerprint = undefined;
    // Old leases still protect their broker handles for cleanup, but cannot
    // authorize a later render or activation without a fresh SQL proof.
    reservationEpoch += 1;
    reservedGraphs.clear();
  };
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const prove = async (publication: SelfhostWorkflowPublication): Promise<void> => {
    if (
      !SCRIPT.test(publication.script) ||
      !VERSION_ID.test(publication.versionId) ||
      !RESOURCE_UID.test(publication.workerResourceUid) ||
      !RESOURCE_UID.test(publication.workerVersionResourceUid) ||
      !DIGEST.test(publication.snapshotDigest) ||
      !Array.isArray(publication.bindings) ||
      publication.bindings.length < 1 ||
      publication.bindings.length > 64
    )
      invalid();
    const stored = await native.read(publication.script, publication.versionId);
    if (
      !stored?.workflowBindings ||
      !stored.eventToken ||
      stored.workerResourceUid !== publication.workerResourceUid ||
      stored.workerVersionResourceUid !== publication.workerVersionResourceUid ||
      stored.digest !== publication.snapshotDigest ||
      stored.workflowBindings.length !== publication.bindings.length
    )
      invalid();
    const first = stored.workflowBindings[0];
    if (!first) invalid();
    // The sidecar reader normalizes all three references against its exact
    // V10 owner pins. Match this selected candidate to that readback before
    // treating the candidate's catalog metadata as an execution grant.
    if (
      !sameFormRef(workflowForm.identity.formRef, first.workflowFormRef) ||
      canonicalJson(bindingRef) !== canonicalJson(first.bindingRef) ||
      canonicalJson(runtimeRef) !== canonicalJson(first.runtimeClassRef)
    )
      invalid();
    const tenantId = first.tenantId;
    const canonical = await options.deployments.active(
      tenantId,
      publication.workerVersionResourceUid,
    );
    if (
      !canonical ||
      canonical.tenantId !== tenantId ||
      canonical.resourceUid !== publication.workerVersionResourceUid ||
      canonical.providerPackRef !== options.providerPackRef ||
      canonical.providerInstallationRef !== options.providerInstallationRef ||
      !exactNativeId(
        canonical.nativeId,
        `selfhost-version:${publication.script}:${publication.versionId}`,
      ) ||
      canonical.observed.scriptName !== publication.script ||
      canonical.observed.versionId !== publication.versionId ||
      canonical.observed.workflowBindingsDigest !== stored.digest
    )
      invalid();
    const version = await options.resources.resourceWithRelationTargetByUid(
      tenantId,
      publication.workerVersionResourceUid,
      "/worker",
    );
    if (
      !version ||
      version.source.uid !== publication.workerVersionResourceUid ||
      !sameFormRef(version.source.resource.form.formRef, versionForm.identity.formRef) ||
      version.source.resource.form.packageDigest !== versionForm.identity.packageDigest ||
      version.source.space !== version.target.space ||
      version.target.uid !== publication.workerResourceUid ||
      !sameFormRef(version.target.resource.form.formRef, workerForm.identity.formRef) ||
      version.target.resource.form.packageDigest !== workerForm.identity.packageDigest
    )
      invalid();
    const worker = await options.deployments.active(tenantId, publication.workerResourceUid);
    if (
      !worker ||
      worker.tenantId !== tenantId ||
      worker.resourceUid !== publication.workerResourceUid ||
      worker.state !== "active" ||
      worker.providerPackRef !== options.providerPackRef ||
      worker.providerInstallationRef !== options.providerInstallationRef ||
      !exactNativeId(worker.nativeId, `selfhost-worker:${publication.script}`) ||
      worker.outputs.scriptName !== publication.script
    )
      invalid();
    const sorted = [...publication.bindings].sort((a, b) =>
      a.publicName.localeCompare(b.publicName),
    );
    const targetBindings: SelfhostVersionWorkflowBinding[] = [];
    for (let index = 0; index < sorted.length; index += 1) {
      const binding = sorted[index];
      if (
        !binding ||
        !SERVICE.test(binding.serviceName) ||
        binding.serviceName !==
          `__TAKOSERVER_WORKFLOW_BINDING_${index.toString().padStart(5, "0")}` ||
        !TOKEN.test(binding.token) ||
        binding.tenantId !== tenantId ||
        !sameFormRef(binding.workflowFormRef, workflowForm.identity.formRef) ||
        canonicalJson(binding.bindingRef) !== canonicalJson(bindingRef) ||
        canonicalJson(binding.runtimeClassRef) !== canonicalJson(runtimeRef)
      )
        invalid();
      const expected = stored.workflowBindings.find((item) => item.name === binding.publicName);
      if (
        !expected ||
        expected.tenantId !== tenantId ||
        expected.workflowResourceUid !== binding.workflowResourceUid ||
        canonicalJson(expected.workflowFormRef) !== canonicalJson(binding.workflowFormRef) ||
        canonicalJson(expected.bindingRef) !== canonicalJson(binding.bindingRef) ||
        canonicalJson(expected.runtimeClassRef) !== canonicalJson(binding.runtimeClassRef) ||
        deriveSelfhostWorkflowBindingToken({
          eventToken: stored.eventToken,
          workerVersionResourceUid: publication.workerVersionResourceUid,
          binding: expected,
        }) !== binding.token
      )
        invalid();
      const graph = await options.graph(
        { tenantId, workflowResourceUid: binding.workflowResourceUid },
        AbortSignal.timeout(30_000),
      );
      if (
        !graph ||
        graph.tenantId !== tenantId ||
        graph.workflow.uid !== binding.workflowResourceUid ||
        graph.workflow.address.space !== version.source.space ||
        !sameFormRef(graph.workflow.formRef, workflowForm.identity.formRef) ||
        graph.worker.uid !== publication.workerResourceUid ||
        graph.worker.address.space !== version.target.space ||
        !sameFormRef(graph.worker.formRef, workerForm.identity.formRef) ||
        canonicalJson(graph.runtimeClassRef) !== canonicalJson(runtimeRef)
      )
        invalid();
      targetBindings.push(expected);
    }
    if (
      canonicalJson(normalizeWorkflowBindings(targetBindings)) !==
      canonicalJson(stored.workflowBindings)
    )
      invalid();
  };

  const prepareGraph = async (
    publications: readonly SelfhostWorkflowPublication[],
  ): Promise<Set<string>> => {
    if (closed) invalid();
    const requested = new Map<
      string,
      { publication: SelfhostWorkflowPublication; binding: WorkerdWorkflowForwardBinding }
    >();
    for (const publication of publications) {
      await prove(publication);
      for (const binding of publication.bindings) {
        const key = socketKey(publication, binding);
        if (requested.has(key)) invalid();
        requested.set(key, { publication, binding });
      }
    }
    const needed = [...requested.keys()].filter((key) => !brokers.has(key));
    if (brokers.size + draining.size + needed.length > MAX_BROKERS) invalid();
    const opened: BrokerEntry[] = [];
    try {
      for (const [key, { publication, binding }] of requested) {
        if (brokers.has(key)) continue;
        const overlap = [...draining].some((item) => item.key === key);
        const hash = createHash("sha256")
          .update(key)
          .update(overlap ? `:${++ordinal}` : "")
          .digest("hex")
          .slice(0, 20);
        const socketPath = join(directory, `${hash}.sock`);
        const admission = Object.freeze({});
        const admit = async (): Promise<void> => {
          if (!admitted.has(admission)) invalid();
          // A volatile reservation proves a publication at activation, not
          // forever. Recheck the SQL pin, sidecar, and live graph before each
          // accepted owner operation, including requests on an old socket.
          try {
            await prove(publication);
          } catch {
            throw new WorkflowInstanceError("backend_unavailable");
          }
          if (!admitted.has(admission)) invalid();
        };
        const broker = await (options.openBroker ?? openSelfhostWorkflowBindingBroker)({
          socketPath,
          token: binding.token,
          scope: { tenantId: binding.tenantId, workflowResourceUid: binding.workflowResourceUid },
          instances: {
            async create(scope, input) {
              await admit();
              return options.owner.instances.create(scope, input);
            },
            async get(scope, id) {
              await admit();
              return options.owner.instances.get(scope, id);
            },
            async status(scope, id) {
              await admit();
              return options.owner.instances.status(scope, id);
            },
            async sendEvent(scope, id, input) {
              await admit();
              return options.owner.instances.sendEvent(scope, id, input);
            },
            async terminate(scope, id) {
              await admit();
              return options.owner.instances.terminate(scope, id);
            },
          },
        });
        opened.push({
          key,
          admission,
          broker,
          socket: {
            script: publication.script,
            workerResourceUid: publication.workerResourceUid,
            versionId: publication.versionId,
            workerVersionResourceUid: publication.workerVersionResourceUid,
            snapshotDigest: publication.snapshotDigest,
            binding,
            socketPath,
          },
        });
      }
      // A graph could move while listeners are opening. No socket becomes a
      // manager-owned candidate until every source and pin still prove exact.
      for (const publication of publications) await prove(publication);
    } catch (error) {
      const results = await Promise.allSettled(opened.map((entry) => entry.broker.close()));
      for (let index = 0; index < results.length; index += 1) {
        const entry = opened[index];
        if (!entry) continue;
        if (results[index]?.status === "fulfilled") retired.add(entry.broker);
        else draining.add(entry);
      }
      if (results.some((result) => result.status === "rejected")) {
        markUncertain();
      }
      throw error;
    }
    for (const entry of opened) brokers.set(entry.key, entry);
    return new Set(requested.keys());
  };

  const cleanup = async (): Promise<void> => {
    if (uncertain || closed) return;
    for (const [key, entry] of brokers) {
      if (uncertain || closed) return;
      if (admitted.has(entry.admission) || (reservations.get(key) ?? 0) > 0) continue;
      brokers.delete(key);
      draining.add(entry);
      if (everAdmitted.has(entry.broker)) {
        void entry.broker.retire().then(
          () => {
            retired.add(entry.broker);
            draining.delete(entry);
          },
          () => {
            markUncertain();
          },
        );
      } else {
        try {
          await entry.broker.close();
          retired.add(entry.broker);
          draining.delete(entry);
        } catch (error) {
          markUncertain();
          throw error;
        }
      }
    }
  };

  return Object.freeze({
    prepare(publications: readonly SelfhostWorkflowPublication[]): Promise<void> {
      return exclusive(async () => {
        await prepareGraph(capture(publications));
      });
    },
    reserve(publications: readonly SelfhostWorkflowPublication[]) {
      return exclusive(async () => {
        const snapshot = capture(publications);
        const keys = await prepareGraph(snapshot);
        const fingerprint = publicationFingerprint(snapshot);
        const epoch = reservationEpoch;
        reservedGraphs.set(fingerprint, (reservedGraphs.get(fingerprint) ?? 0) + 1);
        for (const key of keys) reservations.set(key, (reservations.get(key) ?? 0) + 1);
        let released = false;
        return {
          release(): Promise<void> {
            return exclusive(async () => {
              if (released) return;
              released = true;
              if (epoch === reservationEpoch) {
                const graphCount = (reservedGraphs.get(fingerprint) ?? 1) - 1;
                if (graphCount > 0) reservedGraphs.set(fingerprint, graphCount);
                else reservedGraphs.delete(fingerprint);
              }
              for (const key of keys) {
                const count = (reservations.get(key) ?? 1) - 1;
                if (count > 0) reservations.set(key, count);
                else reservations.delete(key);
              }
              await cleanup();
            });
          },
        };
      });
    },
    activated(publications: readonly SelfhostWorkflowPublication[]): boolean {
      if (closed) return false;
      try {
        const snapshot = capture(publications);
        const fingerprint = publicationFingerprint(snapshot);
        const keys = new Set(
          snapshot.flatMap((item) => item.bindings.map((binding) => socketKey(item, binding))),
        );
        if (
          (reservedGraphs.get(fingerprint) ?? 0) < 1 ||
          [...keys].some((key) => !brokers.has(key))
        ) {
          markUncertain();
          return false;
        }
        uncertain = false;
        restored = true;
        admittedFingerprint = fingerprint;
        admitted = new Set(
          [...keys].map((key) => {
            const entry = brokers.get(key);
            if (!entry) invalid();
            return entry.admission;
          }),
        );
        for (const key of keys) {
          const entry = brokers.get(key);
          if (entry) everAdmitted.add(entry.broker);
        }
        void exclusive(cleanup).catch(() => {
          markUncertain();
        });
        return true;
      } catch {
        markUncertain();
        return false;
      }
    },
    uncertain(): void {
      markUncertain();
    },
    socketsFor(
      publications: readonly SelfhostWorkflowPublication[],
    ): readonly WorkerdWorkflowForwardSocket[] {
      if (closed) invalid();
      const snapshot = capture(publications);
      const fingerprint = publicationFingerprint(snapshot);
      if ((reservedGraphs.get(fingerprint) ?? 0) < 1 && admittedFingerprint !== fingerprint)
        invalid();
      const seen = new Set<string>();
      const sockets: WorkerdWorkflowForwardSocket[] = [];
      for (const publication of snapshot) {
        for (const binding of publication.bindings) {
          const key = socketKey(publication, binding);
          if (seen.has(key)) invalid();
          seen.add(key);
          const entry = brokers.get(key);
          if (!entry) invalid();
          sockets.push(entry.socket);
        }
      }
      return sockets;
    },
    sockets(): readonly WorkerdWorkflowForwardSocket[] {
      return closed ? [] : [...brokers.values()].map((entry) => entry.socket);
    },
    isRestored(): boolean {
      return !closed && restored;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      restored = false;
      admitted = new Set();
      admittedFingerprint = undefined;
      const attempt = (async () => {
        await tail;
        const all = new Set([...brokers.values()].map((entry) => entry.broker));
        for (const entry of draining) all.add(entry.broker);
        // No new broker admission survives this point. Each broker joins
        // already accepted SQL calls, including an absent client response.
        const pending = [...all].filter((broker) => !retired.has(broker));
        const brokerResults = await Promise.allSettled(pending.map((broker) => broker.retire()));
        for (let index = 0; index < brokerResults.length; index += 1) {
          if (brokerResults[index]?.status === "fulfilled") {
            const broker = pending[index];
            if (broker) retired.add(broker);
          }
        }
        if (brokerResults.some((result) => result.status === "rejected"))
          throw new Error("private Workflow serving broker drain incomplete");
        if (!ownerClosed) {
          await options.owner.close();
          ownerClosed = true;
        }
        await rm(directory, { recursive: true, force: true });
      })();
      closing = attempt.catch((error) => {
        uncertain = true;
        closing = undefined;
        throw error;
      });
      return closing;
    },
  });
}
