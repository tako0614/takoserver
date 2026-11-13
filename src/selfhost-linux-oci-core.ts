import type { Clock, Sql } from "./ports.ts";
import {
  createLinuxOciOwnedBundle,
  type LinuxOciOwnedBundleOptions,
} from "./providers/linux-oci-owned-bundle.ts";

/** Host code selection only. Sql/clock come from the actual Host composition;
 * owner, acceptance, custody, executions and readiness are never configurable.
 */
export type SelfhostLinuxOciCoreSelection = Pick<
  LinuxOciOwnedBundleOptions,
  | "installationId"
  | "backendId"
  | "targetKey"
  | "artifactRoot"
  | "umociBinary"
  | "physicalBinary"
  | "images"
  | "memoryBytes"
  | "nanoCpus"
  | "pidsLimit"
  | "egressLimits"
> & {
  readonly configuredInputs: NonNullable<LinuxOciOwnedBundleOptions["configuredInputs"]>;
};

function invalid(): never {
  throw new TypeError("selfhost_linux_oci_core_invalid_selection");
}

function dataKeys(input: object, allowed: readonly string[], required = allowed): void {
  if (
    !input ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    required.some((name) => !Object.hasOwn(input, name)) ||
    !Reflect.ownKeys(input).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return (
        typeof key === "string" &&
        allowed.includes(key) &&
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value")
      );
    })
  )
    invalid();
}

/** Construct after the real Host Sql. Return the ORIGINAL creator object;
 * this adds no backend registration, runtime adapter, OPEN/health or terminal
 * result. The disabled branch reads neither Sql nor clock and performs no IO.
 */
export function createSelfhostLinuxOciCore(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxOciCoreSelection | undefined;
}): ReturnType<typeof createLinuxOciOwnedBundle> | undefined {
  if (!input || typeof input !== "object") invalid();
  const selected = Object.getOwnPropertyDescriptor(input, "selection");
  if (!selected?.enumerable || !Object.hasOwn(selected, "value")) invalid();
  const selection = input.selection;
  if (selection === undefined) return undefined;
  dataKeys(input, ["sql", "clock", "selection"]);
  const required = [
    "installationId",
    "backendId",
    "targetKey",
    "configuredInputs",
    "artifactRoot",
    "umociBinary",
    "images",
    "memoryBytes",
    "nanoCpus",
    "pidsLimit",
  ];
  dataKeys(selection, [...required, "physicalBinary", "egressLimits"], required);
  dataKeys(selection.configuredInputs, ["keyring", "maxSecretBytes"]);
  dataKeys(selection.configuredInputs.keyring, ["current", "keyForDecryption"]);
  dataKeys(selection.configuredInputs.keyring.current, ["id", "key"]);
  dataKeys(selection.images, ["source", "limits"]);
  dataKeys(selection.images.source, ["origin", "read", "expand"]);
  dataKeys(selection.images.limits, [
    "maxManifestBytes",
    "maxConfigBytes",
    "maxLayerCompressedBytes",
    "maxTotalCompressedBytes",
    "maxLayerExpandedBytes",
    "maxTotalExpandedBytes",
    "maxExpansionRatio",
    "maxLayers",
    "maxIndexEntries",
    "maxArchiveBytes",
    "maxRetainedBytes",
    "maxDurationMs",
  ]);
  const { configuredInputs, images } = selection;
  return createLinuxOciOwnedBundle({
    sql: input.sql,
    clock: input.clock,
    installationId: selection.installationId,
    backendId: selection.backendId,
    targetKey: selection.targetKey,
    configuredInputs: {
      keyring: configuredInputs.keyring,
      maxSecretBytes: configuredInputs.maxSecretBytes,
    },
    artifactRoot: selection.artifactRoot,
    umociBinary: selection.umociBinary,
    ...(Object.hasOwn(selection, "physicalBinary") && selection.physicalBinary !== undefined
      ? { physicalBinary: selection.physicalBinary }
      : {}),
    images: {
      source: images.source,
      limits: {
        maxManifestBytes: images.limits.maxManifestBytes,
        maxConfigBytes: images.limits.maxConfigBytes,
        maxLayerCompressedBytes: images.limits.maxLayerCompressedBytes,
        maxTotalCompressedBytes: images.limits.maxTotalCompressedBytes,
        maxLayerExpandedBytes: images.limits.maxLayerExpandedBytes,
        maxTotalExpandedBytes: images.limits.maxTotalExpandedBytes,
        maxExpansionRatio: images.limits.maxExpansionRatio,
        maxLayers: images.limits.maxLayers,
        maxIndexEntries: images.limits.maxIndexEntries,
        maxArchiveBytes: images.limits.maxArchiveBytes,
        maxRetainedBytes: images.limits.maxRetainedBytes,
        maxDurationMs: images.limits.maxDurationMs,
      },
    },
    memoryBytes: selection.memoryBytes,
    nanoCpus: selection.nanoCpus,
    pidsLimit: selection.pidsLimit,
    ...(Object.hasOwn(selection, "egressLimits") && selection.egressLimits !== undefined
      ? { egressLimits: selection.egressLimits }
      : {}),
  });
}
