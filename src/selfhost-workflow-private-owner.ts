import { randomInt } from "node:crypto";
import { canonicalJson } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";
import { createResourceDeploymentStore, type ResourceDeployment } from "./resource-deployments.ts";
import { createWorkerdWorkflowExecutionHost } from "./selfhost-workflow-execution-host.ts";
import {
  createSelfhostWorkflowPreparation,
  type SelfhostWorkflowTarget,
} from "./selfhost-workflow-preparation.ts";
import { sameFormRef } from "./takoform/forms.ts";
import { forwardTakoformCandidates } from "./takoform/forward-candidates.ts";
import { createTakoformStore } from "./takoform/store.ts";
import { type HostedWorkerdRuntime, readWorkerdSelectedActiveVersion } from "./workerd-runtime.ts";
import { WorkflowRuntimeError } from "./workflow-driver.ts";
import {
  createWorkflowDueScheduler,
  type WorkflowDuePollResult,
} from "./workflow-due-scheduler.ts";
import {
  createWorkflowRuntime,
  type WorkflowRunIdentity,
  type WorkflowRunOutcome,
} from "./workflow-execution.ts";
import {
  isExactWorkflowV3InterfaceRef,
  WorkflowInstanceError,
  type WorkflowInstances,
  type WorkflowScope,
} from "./workflow-instances.ts";
import {
  createWorkflowResourceGraphReader,
  type WorkflowResourceGraph,
} from "./workflow-resource-graph.ts";
import {
  createWorkflowResourceDeletionContribution,
  isSelectedWorkflowResourceFormRef,
  type WorkflowResourceDeletionContribution,
  workflowResourceLiveSql,
} from "./workflow-resource-lifecycle.ts";

const SELECTED_WORKER_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ModuleWorker",
  definitionVersion: "0.2.0",
  schemaDigest: "sha256:761180705a6f2a75fa0bc0061794a269342fafe0309c26ecd7530f12fcda1399",
} as const;
const SELECTED_VERSION_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "WorkerVersion",
  definitionVersion: "0.4.0",
  schemaDigest: "sha256:ba59a72fb2c12aa6e9d09173943eb4bb8d2eadac25840d87356a25286007354b",
} as const;
const SELECTED_WORKER_RUNTIME_REF = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.runtime",
  version: "2.0.0",
  schemaDigest: "sha256:8c3fbdef49053c7522c55b9a540d03672c688b617404f23fa29e23b8dd57f37c",
} as const;
const SELECTED_WORKFLOW_BINDING_REF = {
  apiVersion: "bindings.takoform.com/v1alpha2",
  name: "module-worker.workflow",
  version: "3.0.0",
  schemaDigest: "sha256:2b8df3ba036b2781ee3ea8af6603b3de5f09226f4eb1f3385565211cdacc854b",
} as const;

function abortAwareWaitUntil(
  waitUntil: (epochMs: number, signal: AbortSignal) => Promise<void>,
  epochMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => waitUntil(epochMs, signal))
      .then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
  });
}

/** Dormant, private self-host composition; it grants no public Form support. */
export interface SelfhostWorkflowPrivateOwner {
  readonly contribution: WorkflowResourceDeletionContribution;
  readonly instances: Pick<
    WorkflowInstances,
    "create" | "get" | "status" | "sendEvent" | "terminate"
  >;
  runOne(scope: WorkflowScope, id: string): Promise<WorkflowRunOutcome>;
  pollDue(): Promise<WorkflowDuePollResult>;
  close(): Promise<void>;
}

export function createSelfhostWorkflowPrivateOwner(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly waitUntil: (epochMs: number, signal: AbortSignal) => Promise<void>;
  readonly runtimeRoot: string;
  readonly guardBinary: string;
  readonly workerdBinary: string;
  readonly maximumRegistrations: number;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly basisPoint?: () => number;
  readonly temporaryRoot?: string;
  /** Exact Host-owned private service authority, never a provider/public port. */
  readonly serviceRuntime?: Pick<HostedWorkerdRuntime, "acquirePrivateServiceBindings">;
  /** Host-owned current data-plane address for selected sites that require it. */
  readonly dataPlaneAddress?: () => string;
}): SelfhostWorkflowPrivateOwner {
  if (
    typeof options.providerPackRef !== "string" ||
    options.providerPackRef.length === 0 ||
    typeof options.providerInstallationRef !== "string" ||
    options.providerInstallationRef.length === 0
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  const forward = forwardTakoformCandidates();
  const workflowForm = forward.forms.find((form) =>
    isSelectedWorkflowResourceFormRef(form.identity.formRef),
  );
  const workerForm = forward.forms.find((form) =>
    sameFormRef(form.identity.formRef, SELECTED_WORKER_FORM_REF),
  );
  const versionForm = forward.forms.find((form) =>
    sameFormRef(form.identity.formRef, SELECTED_VERSION_FORM_REF),
  );
  const workflowInterfaceRef = workflowForm?.workerClassRuntime?.runtimeClassRef;
  const workerRuntimeRefs = workerForm?.providedInterfaces?.filter(
    (ref) => ref.name === "worker.runtime",
  );
  const binding = forward.bindings.find(
    (candidate) =>
      canonicalJson(candidate.bindingRef) === canonicalJson(SELECTED_WORKFLOW_BINDING_REF),
  );
  if (
    !workflowForm ||
    !workerForm ||
    !versionForm ||
    !workflowForm.identity.packageDigest ||
    !workerForm.identity.packageDigest ||
    !versionForm.identity.packageDigest ||
    !isExactWorkflowV3InterfaceRef(workflowInterfaceRef) ||
    workerRuntimeRefs?.length !== 1 ||
    canonicalJson(workerRuntimeRefs[0]) !== canonicalJson(SELECTED_WORKER_RUNTIME_REF) ||
    !binding ||
    canonicalJson(binding.targetInterface) !== canonicalJson(workflowInterfaceRef) ||
    !versionForm.acceptedBindings?.some(
      (ref) => canonicalJson(ref) === canonicalJson(binding.bindingRef),
    )
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  const contribution = createWorkflowResourceDeletionContribution(
    options.sql,
    workflowForm.identity.formRef,
  );
  const store = createTakoformStore(options.sql, options.clock, contribution);
  const graph = createWorkflowResourceGraphReader({ store, form: workflowForm });
  const deployments = createResourceDeploymentStore(options.sql, options.clock);
  const readTrustedTarget = async (
    scope: WorkflowScope,
    signal: AbortSignal,
    unsupportedIfNoActiveDeployment = false,
  ): Promise<{
    readonly graph: WorkflowResourceGraph;
    readonly deployment: ResourceDeployment;
    readonly target: SelfhostWorkflowTarget;
  } | null> => {
    const resolved = await graph(scope, signal);
    if (
      !resolved ||
      !isExactWorkflowV3InterfaceRef(resolved.runtimeClassRef) ||
      !sameFormRef(resolved.worker.formRef, workerForm.identity.formRef)
    )
      return null;
    const livePair = await store.resourceWithRelationTargetByUid(
      scope.tenantId,
      scope.workflowResourceUid,
      "/worker",
    );
    signal.throwIfAborted();
    if (
      !livePair ||
      livePair.source.uid !== resolved.workflow.uid ||
      livePair.source.revision !== resolved.workflow.revision ||
      livePair.target.uid !== resolved.worker.uid ||
      livePair.target.revision !== resolved.worker.revision ||
      livePair.target.resource.form.packageDigest !== workerForm.identity.packageDigest ||
      !sameFormRef(livePair.target.resource.form.formRef, workerForm.identity.formRef)
    )
      return null;
    const active = await deployments.active(scope.tenantId, resolved.worker.uid);
    signal.throwIfAborted();
    if (!active && unsupportedIfNoActiveDeployment) {
      throw new WorkflowInstanceError("unsupported_capability");
    }
    const script = active?.outputs.scriptName;
    if (
      active?.state !== "active" ||
      active.tenantId !== scope.tenantId ||
      active.resourceUid !== resolved.worker.uid ||
      active.providerPackRef !== options.providerPackRef ||
      active.providerInstallationRef !== options.providerInstallationRef ||
      typeof script !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script) ||
      !new RegExp(`^selfhost-worker:${script}:[^:]+$`, "u").test(active.nativeId)
    )
      return null;
    return {
      graph: resolved,
      deployment: active,
      target: {
        tenantId: scope.tenantId,
        workflowResourceUid: scope.workflowResourceUid,
        workerResourceUid: resolved.worker.uid,
        script,
        className: resolved.workflow.className,
        runtimeClassRef: resolved.runtimeClassRef,
      },
    };
  };
  type TrustedTarget = NonNullable<Awaited<ReturnType<typeof readTrustedTarget>>>;
  const initialSelections = new WeakMap<WorkflowRunIdentity, TrustedTarget>();
  const verifySelectedVersion = async (
    scope: WorkflowScope,
    initial: TrustedTarget,
    selected: {
      readonly workerResourceUid: string;
      readonly workerVersionUid: string;
      readonly versionId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      selected.workerResourceUid !== initial.graph.worker.uid ||
      typeof selected.workerVersionUid !== "string" ||
      selected.workerVersionUid.length === 0 ||
      typeof selected.versionId !== "string" ||
      selected.versionId.length === 0
    )
      throw new WorkflowRuntimeError("host_unavailable");
    const current = await readTrustedTarget(scope, signal);
    if (
      !current ||
      canonicalJson(current.graph) !== canonicalJson(initial.graph) ||
      canonicalJson(current.deployment) !== canonicalJson(initial.deployment)
    )
      throw new WorkflowRuntimeError("host_unavailable");
    const version = await store.resourceWithRelationTargetByUid(
      scope.tenantId,
      selected.workerVersionUid,
      "/worker",
    );
    signal.throwIfAborted();
    if (
      !version ||
      version.source.uid !== selected.workerVersionUid ||
      !sameFormRef(version.source.resource.form.formRef, versionForm.identity.formRef) ||
      version.source.resource.form.packageDigest !== versionForm.identity.packageDigest ||
      version.source.space !== initial.graph.workflow.address.space ||
      version.target.uid !== initial.graph.worker.uid ||
      !sameFormRef(version.target.resource.form.formRef, workerForm.identity.formRef) ||
      version.target.resource.form.packageDigest !== workerForm.identity.packageDigest
    )
      throw new WorkflowRuntimeError("host_unavailable");
  };
  const prepare = createSelfhostWorkflowPreparation({
    runtimeRoot: options.runtimeRoot,
    ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
    ...(options.serviceRuntime === undefined ? {} : { serviceRuntime: options.serviceRuntime }),
    ...(options.dataPlaneAddress === undefined
      ? {}
      : { dataPlaneAddress: options.dataPlaneAddress }),
    resolveTarget: async (identity, signal) => {
      const trusted = await readTrustedTarget(identity.scope, signal);
      if (!trusted) return null;
      initialSelections.set(identity, trusted);
      return trusted.target;
    },
    verifySelected: async (identity, target, selected, signal) => {
      const initial = initialSelections.get(identity);
      initialSelections.delete(identity);
      if (!initial || canonicalJson(target) !== canonicalJson(initial.target)) {
        throw new WorkflowRuntimeError("host_unavailable");
      }
      await verifySelectedVersion(identity.scope, initial, selected, signal);
    },
    ...(options.basisPoint === undefined ? {} : { basisPoint: options.basisPoint }),
  });
  const host = createWorkerdWorkflowExecutionHost({
    guardBinary: options.guardBinary,
    workerdBinary: options.workerdBinary,
    maximumRegistrations: options.maximumRegistrations,
    prepare,
    clock: () => options.clock().getTime(),
  });
  const runtime = createWorkflowRuntime({
    sql: options.sql,
    clock: options.clock,
    randomId: options.randomId,
    waitUntil: (epochMs, signal) => abortAwareWaitUntil(options.waitUntil, epochMs, signal),
    host,
    workflowInterfaceRef,
    workflowResourceDeletion: contribution,
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  const polls = new Set<Promise<WorkflowDuePollResult>>();
  const operations = new Set<Promise<unknown>>();
  const admissions = new Set<AbortController>();
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    // Register before invoking any caller/Sql port: a synchronous reentrant
    // close must see this operation in the drain set.
    const operation = Promise.resolve().then(work);
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  const selectedLive = async (scope: WorkflowScope): Promise<boolean> => {
    if (closed) return false;
    const rows = await options.sql.query(
      `SELECT 1 AS live WHERE ${workflowResourceLiveSql("?", "?")}`,
      [scope.tenantId, scope.workflowResourceUid],
    );
    return !closed && rows.length === 1;
  };
  const runOne = (scope: WorkflowScope, id: string): Promise<WorkflowRunOutcome> =>
    track(async () => {
      if (!(await selectedLive(scope))) return { kind: "stale" };
      return runtime.runOne(scope, id);
    });
  const scheduler = createWorkflowDueScheduler({
    sql: options.sql,
    clock: options.clock,
    runtime: { runOne },
  });
  return {
    contribution,
    instances: {
      create(scope, input) {
        const controller = new AbortController();
        admissions.add(controller);
        return track(async () => {
          try {
            if (closed) throw new WorkflowRuntimeError("host_unavailable");
            // These reads share the caller's Sql. Abort may prevent later
            // work, but close must JOIN the actual query before Sql handoff.
            const trusted = await readTrustedTarget(scope, controller.signal, true);
            if (closed || !trusted) throw new WorkflowRuntimeError("host_unavailable");
            let selected: Awaited<ReturnType<typeof readWorkerdSelectedActiveVersion>>;
            try {
              selected = await readWorkerdSelectedActiveVersion(
                options.runtimeRoot,
                trusted.target.script,
                {
                  expectedWorkerResourceUid: trusted.graph.worker.uid,
                  basisPoint: (options.basisPoint ?? (() => randomInt(10_000)))(),
                },
              );
            } catch {
              throw new WorkflowRuntimeError("host_unavailable");
            }
            if (closed) throw new WorkflowRuntimeError("host_unavailable");
            if (!selected) throw new WorkflowRuntimeError("host_unavailable");
            if (
              ((selected.site.serviceBindings?.length ?? 0) > 0 &&
                options.serviceRuntime === undefined) ||
              (selected.site.dataPlane && options.dataPlaneAddress === undefined)
            )
              throw new WorkflowRuntimeError("host_unavailable");
            await verifySelectedVersion(scope, trusted, selected, controller.signal);
            if (closed) throw new WorkflowRuntimeError("host_unavailable");
            return runtime.instances.create(scope, input);
          } finally {
            admissions.delete(controller);
          }
        });
      },
      get(scope, id) {
        return track(async () => {
          if (!(await selectedLive(scope))) throw new WorkflowRuntimeError("host_unavailable");
          return runtime.instances.get(scope, id);
        });
      },
      status(scope, id) {
        return track(async () => {
          if (!(await selectedLive(scope))) throw new WorkflowRuntimeError("host_unavailable");
          return runtime.instances.status(scope, id);
        });
      },
      sendEvent(scope, id, input) {
        return track(async () => {
          if (!(await selectedLive(scope))) throw new WorkflowRuntimeError("host_unavailable");
          return runtime.instances.sendEvent(scope, id, input);
        });
      },
      terminate(scope, id) {
        return track(async () => {
          if (!(await selectedLive(scope))) throw new WorkflowRuntimeError("host_unavailable");
          return runtime.instances.terminate(scope, id);
        });
      },
    },
    runOne,
    pollDue() {
      if (closed) throw new WorkflowRuntimeError("host_unavailable");
      const poll = Promise.resolve().then(() => scheduler.pollDue());
      polls.add(poll);
      void poll.finally(() => polls.delete(poll)).catch(() => {});
      return poll;
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const controller of admissions) controller.abort();
      closing = (async () => {
        try {
          await host.close();
        } finally {
          await Promise.allSettled([...polls]);
          await Promise.allSettled([...operations]);
        }
      })();
      void closing.catch(() => {
        // A failed physical stop retains the Host tombstones and must be
        // retryable; the admission latch stays closed throughout.
        closing = undefined;
      });
      return closing;
    },
  };
}
