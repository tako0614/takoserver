import { parseActorAbiRef } from "./actor-abi-ref.ts";
import { canonicalJson } from "./json.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";
import { forwardTakoformCandidates } from "./takoform/forward-candidates.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./takoform/types.ts";
import { supportsClassHolderRuntime } from "./takoform/worker-runtime-contract.ts";
import type {
  WorkerClassBindingSelection,
  WorkerClassRuntimeContract,
} from "./worker-class-runtime-port.ts";

interface ActorClosureInput {
  readonly stableForms: readonly InstalledTakoformForm[];
  readonly stableBindings?: readonly InstalledTakoformBinding[];
  readonly workerClassRuntimeContracts?: readonly WorkerClassRuntimeContract[];
}

/** Exact declaration only; neither inspection, execution, nor a support grant. */
export interface SelfhostActorContractClosure {
  readonly selection: "published-management" | "unpublished-source";
  readonly binding: InstalledTakoformBinding;
  readonly contracts: readonly WorkerClassRuntimeContract[];
  readonly providerBinding: WorkerClassBindingSelection | null;
}

/**
 * Published facts retain their existing management closure. A source-only
 * Actor registration must independently match the full pinned forward graph,
 * not just an Actor kind, ABI version, or caller-supplied Binding descriptor.
 */
export function resolveSelfhostActorContractClosure(
  input: ActorClosureInput,
): SelfhostActorContractClosure | null {
  try {
    const supplied = input.workerClassRuntimeContracts ?? [];
    if (supplied.length > 1) return null;
    const suppliedKind = supplied[0]
      ? parseActorAbiRef(supplied[0].runtimeClassRef)?.kind
      : undefined;
    if (supplied.length !== 0 && suppliedKind === undefined) return null;
    const forward = suppliedKind === "v2";
    const pinned = forward ? forwardTakoformCandidates() : currentTakoformCandidates();
    for (const kind of ["ActorNamespace", "ModuleWorker", "WorkerVersion", "WorkerDeployment"]) {
      const expected = pinned.forms.filter((form) => form.identity.formRef.kind === kind);
      const installed = input.stableForms.filter((form) => form.identity.formRef.kind === kind);
      if (
        expected.length !== 1 ||
        installed.length !== 1 ||
        canonicalJson(expected[0]) !== canonicalJson(installed[0])
      ) {
        return null;
      }
    }

    const actor = pinned.forms.find((form) => form.identity.formRef.kind === "ActorNamespace");
    if (!actor) return null;
    const binding = pinned.bindings.filter(
      (item) =>
        item.bindingRef.name === "module-worker.actor" &&
        (actor.providedInterfaces ?? []).some(
          (ref) => canonicalJson(ref) === canonicalJson(item.targetInterface),
        ),
    );
    if (binding.length !== 1 || !binding[0]) return null;
    const selected = binding[0];
    const installed = (input.stableBindings ?? []).filter(
      (item) => canonicalJson(item.bindingRef) === canonicalJson(selected.bindingRef),
    );
    if (installed.length !== 1 || canonicalJson(installed[0]) !== canonicalJson(selected)) {
      return null;
    }

    if (supplied.length !== 0) {
      const contract = supplied[0];
      const runtimeRef = actor.workerClassRuntime?.runtimeClassRef;
      if (
        !contract ||
        !runtimeRef ||
        parseActorAbiRef(runtimeRef)?.kind !== suppliedKind ||
        canonicalJson(contract) !==
          canonicalJson({
            formRef: actor.identity.formRef,
            packageDigest: actor.identity.packageDigest,
            runtimeClassRef: runtimeRef,
          }) ||
        canonicalJson(selected.targetInterface) !== canonicalJson(runtimeRef) ||
        !supportsClassHolderRuntime(actor, { contracts: supplied })
      ) {
        return null;
      }
    }
    const worker = pinned.forms.find((form) => form.identity.formRef.kind === "ModuleWorker");
    const version = pinned.forms.find((form) => form.identity.formRef.kind === "WorkerVersion");
    const contract = supplied[0];
    const providerBinding: WorkerClassBindingSelection | null =
      forward && contract && worker && version
        ? deepFreeze(
            structuredClone({
              bindingRef: selected.bindingRef,
              contract,
              workerFormRef: worker.identity.formRef,
              versionFormRef: version.identity.formRef,
            }),
          )
        : null;
    return {
      selection: forward ? "unpublished-source" : "published-management",
      binding: structuredClone(selected),
      contracts: forward ? structuredClone(supplied) : [],
      providerBinding,
    };
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function hasExactSelfhostActorClosure(input: ActorClosureInput): boolean {
  return resolveSelfhostActorContractClosure(input) !== null;
}
