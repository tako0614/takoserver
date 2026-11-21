import { isV2FormUrl } from "./identity.ts";
import type { V2Action, V2Form, V2RetainedExecutionActions } from "./types.ts";

export type { V2RetainedExecutionActions } from "./types.ts";

const actions: readonly V2Action[] = ["create", "update", "delete"];

/** Capture operator code selection before asynchronous composition can begin. */
export function captureV2RetainedExecutionActions(
  selection: V2RetainedExecutionActions | undefined,
): V2RetainedExecutionActions | undefined {
  if (selection === undefined) return undefined;
  if (
    selection === null ||
    typeof selection !== "object" ||
    (Object.getPrototypeOf(selection) !== Object.prototype &&
      Object.getPrototypeOf(selection) !== null)
  )
    throw new TypeError("retained execution selection must be an exact Form/action map");
  const captured: Record<string, readonly V2Action[]> = Object.create(null);
  for (const key of Reflect.ownKeys(selection)) {
    const descriptor = Object.getOwnPropertyDescriptor(selection, key);
    if (
      typeof key !== "string" ||
      !isV2FormUrl(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw new TypeError("retained execution selection must contain exact Form data properties");
    const value: unknown = descriptor.value;
    if (
      !Array.isArray(value) ||
      value.length > actions.length ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw new TypeError("retained execution actions must be a dense action array");
    const allowed: V2Action[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !item ||
        !("value" in item) ||
        !actions.includes(item.value) ||
        allowed.includes(item.value)
      )
        throw new TypeError("retained execution actions must be distinct known actions");
      allowed.push(item.value);
    }
    captured[key] = Object.freeze(allowed);
  }
  return Object.freeze(captured);
}

/**
 * Bind holds to the retained adapter's exact Form/backend/target at construction.
 * One JSON bind keeps the candidate query below D1's parameter limit regardless
 * of selection size. This only removes runnable candidates; it grants nothing.
 */
export function bindV2RetainedExecution(
  selection: V2RetainedExecutionActions | undefined,
  retainedForms: Readonly<Record<string, V2Form>>,
) {
  const identities = new Map<string, { backendId: string; targetKey: string }>();
  const held: { form: string; backendId: string; targetKey: string; action: V2Action }[] = [];
  for (const [form, allowed] of Object.entries(selection ?? {})) {
    if (!Object.hasOwn(retainedForms, form))
      throw new TypeError("retained execution selection requires an exact retained Form");
    const backend = retainedForms[form]?.backend;
    if (
      !backend ||
      typeof backend.id !== "string" ||
      !backend.id ||
      typeof backend.targetKey !== "string" ||
      !backend.targetKey
    )
      throw new TypeError("retained execution selection requires an exact backend and target");
    identities.set(form, { backendId: backend.id, targetKey: backend.targetKey });
    for (const action of actions) {
      if (!allowed.includes(action))
        held.push({ form, backendId: backend.id, targetKey: backend.targetKey, action });
    }
  }
  return {
    holdsJson: held.length === 0 ? undefined : JSON.stringify(held),
    matchesAdapter(form: string, backendId: string, targetKey: string): boolean {
      const selected = identities.get(form);
      return (
        selected === undefined ||
        (selected.backendId === backendId && selected.targetKey === targetKey)
      );
    },
  };
}
