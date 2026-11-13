import type { DockerContainerCreateRecord } from "./docker-container-create-custody.ts";
import type { LinuxOciArtifactReceipt } from "./linux-oci-owned-bundle.ts";

/** Explicit Host limits, never Form billing units or enforcement authority. */
export interface LinuxOciEgressLimits {
  readonly maxConnections: number;
  /** Same raw inet-output skb-byte unit as the existing Linux egress compiler. */
  readonly packetLimitBytes: number;
}

export const LINUX_OCI_EGRESS_POLICY_FILE = ".tako-oci-egress.json";
const encoder = new TextEncoder();
const fail = (): never => {
  throw new TypeError("linux_oci_egress_policy_invalid");
};

/** Snapshot only plain own data fields; caller edits cannot change a later
 * accepted claim's policy digest or file. This is data, not an installed grant. */
export function snapshotLinuxOciEgressLimits(value: unknown): Readonly<LinuxOciEgressLimits> {
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Reflect.ownKeys(value).every((key) => key === "maxConnections" || key === "packetLimitBytes")
  )
    return fail();
  const data = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return fail();
    return descriptor.value;
  };
  const maxConnections = data("maxConnections"),
    packetLimitBytes = data("packetLimitBytes");
  if (
    typeof maxConnections !== "number" ||
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 0 ||
    maxConnections > 65535 ||
    typeof packetLimitBytes !== "number" ||
    !Number.isSafeInteger(packetLimitBytes) ||
    packetLimitBytes < 0
  )
    return fail();
  return Object.freeze({ maxConnections, packetLimitBytes });
}

/** Encode only data from the ORIGINAL newly won claim and its artifact.
 * The creator must hold its real authority/secret loan when writing these
 * bytes. A string/file/DTO alone grants no policy, admission or readiness. */
export function serializeLinuxOciEgressPolicy(
  artifact: LinuxOciArtifactReceipt,
  record: DockerContainerCreateRecord,
  limits: LinuxOciEgressLimits,
): string {
  const { intent } = record;
  const { tenantRef, generation, policyDigest, outboundInternet } = intent.policy;
  if (
    record.state !== "pending" ||
    record.nativeId !== null ||
    artifact.claimId !== record.claimId ||
    artifact.installationId !== intent.installationId ||
    artifact.resourceUid !== intent.resourceUid ||
    artifact.incarnationId !== intent.incarnationId ||
    artifact.revision !== intent.revision ||
    artifact.generation !== generation ||
    typeof tenantRef !== "string" ||
    tenantRef.includes("\0") ||
    encoder.encode(tenantRef).length < 1 ||
    encoder.encode(tenantRef).length > 1024 ||
    new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(tenantRef)) !== tenantRef ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(policyDigest) ||
    typeof outboundInternet !== "boolean"
  )
    return fail();
  const bytes = JSON.stringify({
    kind: "linux-oci-owned-egress@1",
    artifact,
    policy: { tenantRef, generation, policyDigest, outboundInternet },
    limits: snapshotLinuxOciEgressLimits(limits),
  });
  if (encoder.encode(bytes).length > 32768) return fail();
  return bytes;
}
