import type { AppPorts } from "./app.ts";
import { V2_CONTAINER_F2_FORM } from "./container-contract.ts";
import type { Clock, Sql } from "./ports.ts";
import { createSelfhostLinuxDockerContainerBackend } from "./selfhost-linux-docker-container-backend.ts";
import type { SelfhostLinuxDockerCoreSelection } from "./selfhost-linux-docker-core.ts";
import type { V2OperatorFormSelectionFactory } from "./takoform-v2/application.ts";
import { isV2FormUrl } from "./takoform-v2/identity.ts";
import {
  type V2PrivateInputCustody,
  validatePrivateInputCustody,
} from "./takoform-v2/private-inputs.ts";
import type { V2Action, V2BackendResult, V2Execution, V2Form } from "./takoform-v2/types.ts";

/** Capture the existing code-only action selection, without widening it. The
 * engine still performs its original pre-claim retained-adapter binding. */
function captureActions(input: Readonly<Record<string, readonly V2Action[]>> | undefined) {
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
  // Retained-only Node composition defaults to retirement, not fresh dispatch.
  // Explicit existing operator-code rules may select accepted CREATE/UPDATE.
  if (!Object.hasOwn(captured, V2_CONTAINER_F2_FORM))
    captured[V2_CONTAINER_F2_FORM] = Object.freeze<V2Action[]>(["delete"]);
  return Object.freeze(captured);
}

/** Wire one genuine backend into the existing Node application options. This
 * neither registers public F2 support nor supplies a realized operator choice.
 * The existing entry must drain whole requests/passes (including engine settle)
 * before calling close and then closing its database.
 */
export function createSelfhostLinuxDockerNodeComposition(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxDockerCoreSelection | undefined;
  readonly formSelectionFactory: V2OperatorFormSelectionFactory | undefined;
  readonly privateInputCustody: V2PrivateInputCustody | undefined;
  readonly retainedExecutionActions?: Readonly<Record<string, readonly V2Action[]>>;
}): {
  readonly appPorts: Pick<
    AppPorts,
    "v2FormSelectionFactory" | "v2ContainerHostAcceptance" | "v2PrivateInputCustody"
  > & {
    readonly v2RetainedExecutionActions?: Readonly<Record<string, readonly V2Action[]>>;
  };
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
  if (!custody) throw new TypeError("selfhost_linux_docker_private_input_custody_required");
  validatePrivateInputCustody(custody);
  const retainedExecutionActions = captureActions(input.retainedExecutionActions);
  const allowed: readonly V2Action[] = retainedExecutionActions[V2_CONTAINER_F2_FORM] ?? [];
  const native = createSelfhostLinuxDockerContainerBackend({
    sql: input.sql,
    clock: input.clock,
    selection: input.selection,
  });
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
    if (closed) throw new TypeError("selfhost_linux_docker_node_closed");
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
      throw new TypeError("selfhost_linux_docker_form_already_composed");
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
