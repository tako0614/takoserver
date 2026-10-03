import type { TakoformInterfaceRef } from "../src/interface-ref.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";

/** Host-only metadata projection; this does not assert executable ABI support. */
export function projectPublisherWorkerClassRuntime(
  kind: string,
  definition: Record<string, unknown>,
): Pick<InstalledTakoformForm, "workerClassRuntime"> | Record<string, never> {
  const interfaceName =
    kind === "ActorNamespace"
      ? "worker.actor"
      : kind === "DurableWorkflow"
        ? "worker.workflow"
        : undefined;
  if (!interfaceName) return {};

  const declared = definition.providedInterfaces;
  if (!Array.isArray(declared)) invalid();
  const provided = declared.map(interfaceRef);
  const matches = provided.filter((ref) => ref.name === interfaceName);
  if (matches.length !== 1) invalid();
  const selected = matches[0];
  if (!selected) invalid();

  return {
    workerClassRuntime: {
      providedInterface: interfaceName,
      runtimeClassRef: selected,
      className: "/className",
      workerRelation: "/worker",
      deploymentForm: { apiVersion: "edge.forms.takoform.com", kind: "WorkerDeployment" },
      deploymentWorkerRelation: "/worker",
      deploymentVersionRelation: "/versions/*/workerVersion",
      versionBundleRelation: "/bundle",
    },
  };
}

function interfaceRef(value: unknown): TakoformInterfaceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "apiVersion,name,schemaDigest,version" ||
    candidate.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    typeof candidate.name !== "string" ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(candidate.name) ||
    typeof candidate.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(candidate.version) ||
    typeof candidate.schemaDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.schemaDigest)
  ) {
    invalid();
  }
  return {
    apiVersion: candidate.apiVersion,
    name: candidate.name,
    version: candidate.version,
    schemaDigest: candidate.schemaDigest as `sha256:${string}`,
  };
}

function invalid(): never {
  throw new Error("publisher_set_projection_invalid");
}
