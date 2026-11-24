import type { AppPorts } from "./app.ts";
import { V2_CONTAINER_F2_FORM } from "./container-contract.ts";
import type { Clock, Sql } from "./ports.ts";
import { containerRecord } from "./providers/container-secret-codec.ts";
import {
  createLinuxOciContainerBindingSource,
  type LinuxOciContainerBindingSource,
} from "./providers/linux-oci-container-binding-broker.ts";
import {
  type SelfhostLinuxContainerNodeSelection,
  type SelfhostLinuxContainerNodeSelectionSource,
  validateSelfhostLinuxOciNodeConfiguration,
} from "./selfhost-linux-container-node-selection.ts";
import { createSelfhostLinuxDockerContainerBackend } from "./selfhost-linux-docker-container-backend.ts";
import { createSelfhostLinuxOciContainerBackend } from "./selfhost-linux-oci-container-backend.ts";
import type { V2OperatorFormSelectionFactory } from "./takoform-v2/application.ts";
import { inspectV2ContainerOwnerShutdownIoSchema } from "./takoform-v2/container-owner-schema.ts";
import { isV2FormUrl } from "./takoform-v2/identity.ts";
import {
  type V2PrivateInputCustody,
  validatePrivateInputCustody,
} from "./takoform-v2/private-inputs.ts";
import type {
  V2Action,
  V2BackendResult,
  V2Execution,
  V2Form,
  V2RetainedExecutionActions,
} from "./takoform-v2/types.ts";
import { WORKER_VERSION_UNIFIED_BACKEND_ID } from "./takoform-v2/worker-lifecycle-backend.ts";

export async function assertSelfhostLinuxContainerNodeSchema(
  sql: Sql,
  selected: SelfhostLinuxContainerNodeSelection | undefined,
): Promise<void> {
  if (
    selected?.kind === "oci" &&
    selected.selection.ociParentControl === "sealed-peer-runtime-application-owner@1" &&
    !(await inspectV2ContainerOwnerShutdownIoSchema(sql))
  )
    throw new Error("selfhost_linux_oci_shutdown_io_schema_required");
}

/** Capture the existing code-only action selection, without widening it. The
 * engine still performs its original pre-claim retained-adapter binding. */
function captureActions(input: V2RetainedExecutionActions | undefined) {
  const captured: Record<string, readonly V2Action[]> = Object.create(null);
  if (input !== undefined) {
    if (
      input === null ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    )
      throw new TypeError("invalid retained execution selection");
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== "string" ||
        !isV2FormUrl(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      )
        throw new TypeError("invalid retained execution selection");
      const value: unknown = descriptor.value;
      if (
        !Array.isArray(value) ||
        value.length > 3 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new TypeError("invalid retained execution actions");
      const actions: V2Action[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (
          !item ||
          !("value" in item) ||
          !["create", "update", "delete"].includes(item.value) ||
          actions.includes(item.value)
        )
          throw new TypeError("invalid retained execution actions");
        actions.push(item.value);
      }
      captured[key] = Object.freeze(actions);
    }
  }
  return captured;
}

export type SelfhostLinuxContainerRetainedExecutionActions = Pick<
  V2RetainedExecutionActions,
  typeof V2_CONTAINER_F2_FORM
>;

/** Snapshot only the one retained Form owned by the selected Linux backend. */
export function captureSelfhostLinuxContainerRetainedExecutionActions(
  selection: SelfhostLinuxContainerNodeSelectionSource | undefined,
  input: SelfhostLinuxContainerRetainedExecutionActions | undefined,
): SelfhostLinuxContainerRetainedExecutionActions | undefined {
  if (input === undefined) return undefined;
  if (selection === undefined) {
    throw new TypeError("retained execution actions require a Linux Container selection");
  }
  const captured = captureActions(input);
  const actions = captured[V2_CONTAINER_F2_FORM];
  if (Object.keys(captured).length !== 1 || actions === undefined) {
    throw new TypeError("retained execution actions require the selected Linux Container F2 Form");
  }
  return Object.freeze({ [V2_CONTAINER_F2_FORM]: actions });
}

/** Wire one genuine backend into the existing Node application options. This
 * neither registers public F2 support nor supplies a realized operator choice.
 * The existing entry must drain whole requests/passes (including engine settle)
 * before calling close and then closing its database.
 */
export function createSelfhostLinuxContainerNodeComposition(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxContainerNodeSelection | undefined;
  readonly formSelectionFactory: V2OperatorFormSelectionFactory | undefined;
  readonly privateInputCustody: V2PrivateInputCustody | undefined;
  readonly retainedExecutionActions?: Readonly<Record<string, readonly V2Action[]>> | undefined;
}): {
  readonly appPorts: Pick<
    AppPorts,
    "v2FormSelectionFactory" | "v2ContainerHostAcceptance" | "v2PrivateInputCustody"
  > & {
    readonly v2RetainedExecutionActions?: Readonly<Record<string, readonly V2Action[]>>;
  };
  readonly containerBindingSource?: LinuxOciContainerBindingSource;
  close(): Promise<void>;
} {
  const baseFactory = input.formSelectionFactory;
  const custody = input.privateInputCustody;
  if (input.selection === undefined) {
    return Object.freeze({
      appPorts: Object.freeze({
        ...(baseFactory ? { v2FormSelectionFactory: baseFactory } : {}),
        ...(baseFactory && custody ? { v2PrivateInputCustody: custody } : {}),
        ...(input.retainedExecutionActions === undefined
          ? {}
          : { v2RetainedExecutionActions: input.retainedExecutionActions }),
      }),
      close: () => Promise.resolve(),
    });
  }
  const selected = input.selection;
  const choice = containerRecord(selected);
  if (
    Object.keys(choice).sort().join() !== "kind,selection" ||
    (selected.kind !== "docker" && selected.kind !== "oci")
  )
    throw new TypeError("invalid Linux Container code selection");
  if (selected.kind === "oci") validateSelfhostLinuxOciNodeConfiguration(selected.selection);
  const prefix = selected.kind === "oci" ? "selfhost_linux_oci" : "selfhost_linux_docker";
  if (!custody) throw new TypeError(`${prefix}_private_input_custody_required`);
  validatePrivateInputCustody(custody);
  const retainedExecutionActions = captureActions(input.retainedExecutionActions);
  // Retirement is the default. Operator code can select other already accepted actions.
  if (!Object.hasOwn(retainedExecutionActions, V2_CONTAINER_F2_FORM))
    retainedExecutionActions[V2_CONTAINER_F2_FORM] = Object.freeze<V2Action[]>(["delete"]);
  Object.freeze(retainedExecutionActions);
  const allowed: readonly V2Action[] = retainedExecutionActions[V2_CONTAINER_F2_FORM] ?? [];
  const oci =
    selected.kind === "oci"
      ? createSelfhostLinuxOciContainerBackend({
          sql: input.sql,
          clock: input.clock,
          selection: selected.selection,
        })
      : undefined;
  const native =
    oci ??
    (selected.kind === "docker"
      ? createSelfhostLinuxDockerContainerBackend({
          sql: input.sql,
          clock: input.clock,
          selection: selected.selection,
        })
      : undefined);
  if (!native) throw new TypeError(`${prefix}_missing_original_creator`);
  const containerBindingSource =
    oci && selected.kind === "oci"
      ? createLinuxOciContainerBindingSource({
          sql: input.sql,
          targetKey: selected.selection.targetKey,
          workerBackendId: WORKER_VERSION_UNIFIED_BACKEND_ID,
          containerBackendId: selected.selection.backendId,
          original: oci,
        })
      : undefined;
  let closed = false;
  const guardAction = (execution: V2Execution): boolean => {
    const action = Object.getOwnPropertyDescriptor(execution, "action");
    return !closed && !!action && Object.hasOwn(action, "value") && allowed.includes(action.value);
  };
  const guarded =
    (reconcile: boolean) =>
    async (execution: V2Execution): Promise<V2BackendResult> => {
      try {
        if (!guardAction(execution)) return { kind: "unknown" };
        return await (reconcile
          ? native.retainedForm.backend.reconcile(execution)
          : native.retainedForm.backend.execute(execution));
      } catch {
        return { kind: "unknown" };
      }
    };
  const retainedForm = Object.freeze({
    ...native.retainedForm,
    backend: Object.freeze({
      ...native.retainedForm.backend,
      execute: guarded(false),
      reconcile: guarded(true),
    }),
  });
  const factory: V2OperatorFormSelectionFactory = (context) => {
    if (closed) throw new TypeError(`${prefix}_node_closed`);
    native.acceptance.assertSql(context.sql);
    const existing =
      baseFactory === undefined
        ? { forms: Object.freeze({}), retainedForms: Object.freeze({}) }
        : baseFactory(context);
    if (
      !existing ||
      typeof existing !== "object" ||
      (Object.getPrototypeOf(existing) !== Object.prototype &&
        Object.getPrototypeOf(existing) !== null)
    )
      throw new TypeError("v2 Form selection must contain exact Form maps");
    const forms = Object.getOwnPropertyDescriptor(existing, "forms");
    const retained = Object.getOwnPropertyDescriptor(existing, "retainedForms");
    if (
      Reflect.ownKeys(existing).length !== 2 ||
      !forms?.enumerable ||
      !("value" in forms) ||
      !retained?.enumerable ||
      !("value" in retained) ||
      !retained.value ||
      (Object.getPrototypeOf(retained.value) !== Object.prototype &&
        Object.getPrototypeOf(retained.value) !== null)
    )
      throw new TypeError("v2 Form selection must contain exact Form maps");
    if (Object.hasOwn(forms.value, native.formUrl) || Object.hasOwn(retained.value, native.formUrl))
      throw new TypeError(`${prefix}_form_already_composed`);
    // Preserve every original descriptor so application validation still refuses
    // malformed hidden/accessor entries instead of normalizing them by spread.
    const retainedForms: Record<string, V2Form> = Object.create(
      Object.getPrototypeOf(retained.value),
      Object.getOwnPropertyDescriptors(retained.value),
    );
    Object.defineProperty(retainedForms, native.formUrl, { value: retainedForm, enumerable: true });
    return Object.freeze({
      forms: forms.value,
      retainedForms: Object.freeze(retainedForms),
    });
  };
  return Object.freeze({
    ...(containerBindingSource ? { containerBindingSource } : {}),
    appPorts: Object.freeze({
      v2FormSelectionFactory: factory,
      v2ContainerHostAcceptance: native.acceptance,
      v2PrivateInputCustody: custody,
      v2RetainedExecutionActions: retainedExecutionActions,
    }),
    close() {
      closed = true;
      return native.close();
    },
  });
}
