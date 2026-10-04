import { parseActorAbiRef } from "./actor-abi-ref.ts";
import { bytesDigest, canonicalJson, isSha256Digest } from "./json.ts";
import type { PreparedSelfhostVersionMaterialization } from "./providers/selfhost-version-materialization.ts";
import type {
  WorkerActorClassExpectedGraph,
  WorkerModuleInspectionModule,
} from "./providers/worker-module-semantic-inspection.ts";
import type {
  ProviderWorkerClassRuntime,
  WorkerClassInspectionInput,
  WorkerClassInspectionVerdict,
  WorkerClassRuntimeContract,
} from "./worker-class-runtime-port.ts";

const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Binds a source-selected forward Actor contract to the existing self-host
 * disposable class inspector. This adapter grants no source selection: only
 * exact contracts supplied by composition can reach the Workerd inspector.
 */
export function createSelfhostActorClassRuntime(options: {
  readonly providerInstallationRef: string;
  readonly contracts: readonly WorkerClassRuntimeContract[];
  readonly inspect: ProviderWorkerClassRuntime["inspect"];
}): ProviderWorkerClassRuntime {
  if (
    typeof options.providerInstallationRef !== "string" ||
    options.providerInstallationRef.length === 0 ||
    !Array.isArray(options.contracts) ||
    typeof options.inspect !== "function"
  ) {
    throw new TypeError("self-host Actor class inspector configuration is invalid");
  }
  const contracts = deepFreeze(structuredClone(options.contracts));
  if (
    contracts.length === 0 ||
    contracts.some((contract) => !isForwardActorContract(contract)) ||
    new Set(contracts.map((contract) => canonicalJson(contract))).size !== contracts.length
  ) {
    throw new TypeError("self-host Actor class inspector needs exact forward contracts");
  }

  const exposedContracts = deepFreeze(structuredClone(contracts));
  return Object.freeze({
    contracts: exposedContracts,
    async inspect(
      input: Parameters<ProviderWorkerClassRuntime["inspect"]>[0],
    ): Promise<WorkerClassInspectionVerdict> {
      try {
        if (
          input.providerInstallationRef !== options.providerInstallationRef ||
          !contracts.some(
            (contract) => canonicalJson(contract) === canonicalJson(input.contract),
          ) ||
          !validInspectionIdentity(input) ||
          typeof input.holderNativeId !== "string" ||
          input.holderNativeId !== `selfhost-actor:${input.holder.uid}` ||
          typeof input.versionNativeId !== "string" ||
          !matchesVersionNativeId(input.versionNativeId, input.version.uid)
        ) {
          return "unavailable";
        }
        const verdict: unknown = await options.inspect(structuredClone(input));
        return verdict === "valid" || verdict === "invalid" ? verdict : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Bind a class inspection graph to the exact canonical Bundle manifest digest. */
export async function selfhostActorExpectedGraph(
  prepared: PreparedSelfhostVersionMaterialization,
  canonicalBundleManifestDigest: string,
): Promise<WorkerActorClassExpectedGraph | null> {
  if (
    !isSha256Digest(canonicalBundleManifestDigest) ||
    prepared.meta.manifestDigest !== canonicalBundleManifestDigest
  ) {
    return null;
  }
  const modules: WorkerModuleInspectionModule[] = [];
  for (const entry of prepared.meta.modules) {
    const mediaType = entry.mediaType ?? "application/javascript+module";
    if (mediaType === "application/source-map+json") continue;
    if (
      mediaType !== "application/javascript+module" &&
      mediaType !== "text/plain" &&
      mediaType !== "application/octet-stream" &&
      mediaType !== "application/wasm"
    ) {
      return null;
    }
    if (!isSha256Digest(entry.digest)) return null;
    const bytes = prepared.modules.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.size || (await bytesDigest(bytes)) !== entry.digest) {
      return null;
    }
    modules.push({
      name: entry.path,
      digest: entry.digest,
      mediaType,
      bytes: new Uint8Array(bytes),
    });
  }
  if (modules.length === 0 || !modules.some((entry) => entry.name === prepared.meta.mainModule)) {
    return null;
  }
  return { mainModule: prepared.meta.mainModule, modules };
}

function isForwardActorContract(value: unknown): value is WorkerClassRuntimeContract {
  if (!isRecord(value)) return false;
  const ref = parseActorAbiRef(value.runtimeClassRef);
  return (
    ref?.kind === "v2" &&
    isRecord(value.formRef) &&
    value.formRef.apiVersion === "edge.forms.takoform.com" &&
    value.formRef.kind === "ActorNamespace" &&
    typeof value.formRef.definitionVersion === "string" &&
    isSha256Digest(value.formRef.schemaDigest) &&
    isSha256Digest(value.packageDigest)
  );
}

function validInspectionIdentity(input: WorkerClassInspectionInput): boolean {
  if (
    typeof input.tenantId !== "string" ||
    input.tenantId.length === 0 ||
    input.tenantId.length > 256 ||
    input.tenantId.includes("\0") ||
    typeof input.space !== "string" ||
    input.space.length === 0 ||
    input.space.length > 256 ||
    input.space.includes("\0") ||
    typeof input.className !== "string" ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(input.className) ||
    !Number.isSafeInteger(input.weight) ||
    input.weight < 1 ||
    input.weight > 10_000 ||
    !sameFormRef(input.holder.formRef, input.contract.formRef) ||
    input.holder.formRef.kind !== "ActorNamespace" ||
    input.worker.formRef.kind !== "ModuleWorker" ||
    input.deployment.formRef.kind !== "WorkerDeployment" ||
    input.version.formRef.kind !== "WorkerVersion" ||
    input.bundle.formRef.kind !== "WorkerBundle" ||
    !isSha256Digest(input.bundle.manifestDigest)
  ) {
    return false;
  }
  return [input.holder, input.worker, input.deployment, input.version, input.bundle].every(
    (identity) =>
      RESOURCE_UID.test(identity.uid) &&
      typeof identity.generation === "string" &&
      identity.generation.length > 0 &&
      typeof identity.revision === "string" &&
      identity.revision.length > 0,
  );
}

function sameFormRef(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function matchesVersionNativeId(nativeId: string, resourceUid: string): boolean {
  if (!RESOURCE_UID.test(resourceUid)) return false;
  const parts = nativeId.split(":");
  return (
    parts.length >= 4 &&
    parts[0] === "selfhost-version" &&
    typeof parts[1] === "string" &&
    SAFE_SEGMENT.test(parts[1]) &&
    typeof parts[2] === "string" &&
    SAFE_SEGMENT.test(parts[2]) &&
    parts.slice(3).every((part) => part.length > 0 && !part.includes("\0"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
