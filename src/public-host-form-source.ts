import { isSha256Digest } from "./json.ts";
import type { PublicWorkerImplementationIdentity } from "./public-host-identity.ts";
import { selectTakoformCandidates } from "./takoform/forward-candidates.ts";
import { supportsClassHolderRuntime } from "./takoform/worker-runtime-contract.ts";
import type { WorkerClassRuntimeContract } from "./worker-class-runtime-port.ts";

/**
 * Source qualification only. An unpublished Form cannot be paired with the
 * currently published public implementation identity or admitted by the
 * released-Core Form authority closure.
 */
export function selectPublicHostFormSource(
  candidate: string | undefined,
  publicIdentity?: PublicWorkerImplementationIdentity,
) {
  if (candidate !== undefined && candidate !== "actor-forward") {
    throw new TypeError("unknown public Host Form source candidate");
  }
  if (candidate === "actor-forward" && publicIdentity !== undefined) {
    throw new TypeError("unpublished Actor source cannot serve a public Form authority identity");
  }
  const selected = selectTakoformCandidates(candidate);
  const workerClassRuntimeContracts: WorkerClassRuntimeContract[] = [];
  if (candidate === "actor-forward") {
    const actor = selected.forms.find((form) => form.identity.formRef.kind === "ActorNamespace");
    const ref = actor?.workerClassRuntime?.runtimeClassRef;
    if (!actor || !ref || !isSha256Digest(actor.identity.packageDigest)) {
      throw new TypeError("exact forward Actor class contract is unavailable");
    }
    const contract: WorkerClassRuntimeContract = {
      formRef: actor.identity.formRef,
      packageDigest: actor.identity.packageDigest,
      runtimeClassRef: ref,
    };
    if (!supportsClassHolderRuntime(actor, { contracts: [contract] })) {
      throw new TypeError("forward Actor class contract does not match its Form");
    }
    workerClassRuntimeContracts.push(contract);
  }
  return { ...selected, workerClassRuntimeContracts };
}
