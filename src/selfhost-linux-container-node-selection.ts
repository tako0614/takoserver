import type { Sql } from "./ports.ts";
import { containerRecord, isContainerSecretKey } from "./providers/container-secret-codec.ts";
import type { RuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import type { SelfhostLinuxDockerCoreSelection } from "./selfhost-linux-docker-core.ts";
import type { SelfhostLinuxDockerNodeSelectionSource } from "./selfhost-linux-docker-node-selection.ts";
import type { SelfhostLinuxOciCoreSelection } from "./selfhost-linux-oci-core.ts";
import { inspectV2ContainerOwnerShutdownIoSchema } from "./takoform-v2/container-owner-schema.ts";

type RequiredOciNodeConfiguration = Required<
  Pick<SelfhostLinuxOciCoreSelection, "physicalBinary" | "egressLimits" | "hostTopology">
>;

export type SelfhostLinuxOciNodeSelectionSource = Omit<
  SelfhostLinuxOciCoreSelection,
  "configuredInputs"
> &
  RequiredOciNodeConfiguration & {
    readonly configuredInputs: Pick<
      SelfhostLinuxOciCoreSelection["configuredInputs"],
      "maxSecretBytes"
    >;
  };

/** Host code chooses exactly one original creator. No native owner or backend
 * object is accepted here; this is configuration data, never runtime proof. */
export type SelfhostLinuxContainerNodeSelectionSource =
  | { readonly kind: "docker"; readonly selection: SelfhostLinuxDockerNodeSelectionSource }
  | { readonly kind: "oci"; readonly selection: SelfhostLinuxOciNodeSelectionSource };

export type SelfhostLinuxContainerNodeSelection =
  | { readonly kind: "docker"; readonly selection: SelfhostLinuxDockerCoreSelection }
  | {
      readonly kind: "oci";
      readonly selection: SelfhostLinuxOciCoreSelection & RequiredOciNodeConfiguration;
    };

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

/** Required Node configuration only. The original creator still snapshots and
 * validates these data; their presence is no realized network/admission proof. */
export function validateSelfhostLinuxOciNodeConfiguration(
  selection: SelfhostLinuxOciCoreSelection | SelfhostLinuxOciNodeSelectionSource,
): void {
  containerRecord(selection);
  if (
    ["physicalBinary", "egressLimits", "hostTopology"].some(
      (key) => !Object.hasOwn(selection, key),
    ) ||
    selection.physicalBinary === undefined ||
    selection.egressLimits === undefined ||
    selection.hostTopology === undefined
  )
    throw new TypeError("selfhost_linux_oci_node_configuration_required");
}

function configure<S extends { readonly configuredInputs: { readonly maxSecretBytes: number } }>(
  selection: S,
  input: { readonly sealKeys: RuntimeInputSealKeyRing | undefined },
  label: "Docker" | "OCI",
) {
  // Preserve the existing descriptor refusal before copying Host data.
  containerRecord(selection);
  const configured = containerRecord(selection.configuredInputs);
  if (Object.keys(configured).join() !== "maxSecretBytes")
    throw new TypeError(`invalid Linux ${label} configured input selection`);
  const ring = input.sealKeys;
  if (!ring) throw new TypeError(`Linux ${label} operator seal keys unavailable`);
  const imported = [ring.current, ...(ring.previous ?? [])];
  const keys = new Map<string, CryptoKey>();
  for (const key of imported) {
    if (!isContainerSecretKey(key.key) || keys.has(key.keyId))
      throw new TypeError(`invalid Linux ${label} operator seal keys`);
    keys.set(key.keyId, key.key);
  }
  const current = Object.freeze({ id: ring.current.keyId, key: ring.current.key });
  return Object.freeze({
    ...selection,
    configuredInputs: Object.freeze({
      maxSecretBytes: selection.configuredInputs.maxSecretBytes,
      keyring: Object.freeze({
        current,
        keyForDecryption(id: string) {
          return keys.get(id);
        },
      }),
    }),
  });
}

/** Bind the original parser's imported keys. Disabled selection reads no keys
 * and supplies no creator. The original selected factory validates all fields. */
export function createSelfhostLinuxContainerNodeSelection(input: {
  readonly selection: SelfhostLinuxContainerNodeSelectionSource | undefined;
  readonly sealKeys: RuntimeInputSealKeyRing | undefined;
}): SelfhostLinuxContainerNodeSelection | undefined {
  const selection = input.selection;
  if (selection === undefined) return undefined;
  const record = containerRecord(selection);
  if (
    Object.keys(record).sort().join() !== "kind,selection" ||
    (selection.kind !== "docker" && selection.kind !== "oci")
  )
    throw new TypeError("invalid Linux Container code selection");
  if (selection.kind === "oci") validateSelfhostLinuxOciNodeConfiguration(selection.selection);
  return selection.kind === "docker"
    ? Object.freeze({
        kind: "docker",
        selection: configure(selection.selection, input, "Docker"),
      })
    : Object.freeze({
        kind: "oci",
        selection: configure(selection.selection, input, "OCI"),
      });
}
