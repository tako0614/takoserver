import { isIP } from "node:net";
import type { DockerContainerCreateRecord } from "./docker-container-create-custody.ts";
import type { LinuxOciArtifactReceipt } from "./linux-oci-owned-bundle.ts";

/** Expected Host topology, never a device/route observation or permission.
 * The original native owner must obtain and compare the actual kernel facts. */
export interface LinuxOciHostTopology {
  readonly interfaceName: string;
  readonly interfaceIndex: number;
  readonly interfaceMac: string;
  readonly ipv4Address: string;
  readonly ipv4Gateway: string;
  readonly ipv6Address: string;
  readonly ipv6Gateway: string;
  /** Explicit private point-to-point /31 and ULA /127, Host endpoint first. */
  readonly peerIpv4Host: string;
  readonly peerIpv4Guest: string;
  readonly peerIpv6Host: string;
  readonly peerIpv6Guest: string;
}

export const LINUX_OCI_HOST_TOPOLOGY_FILE = ".tako-oci-topology.json";
const keys = [
  "interfaceName",
  "interfaceIndex",
  "interfaceMac",
  "ipv4Address",
  "ipv4Gateway",
  "ipv6Address",
  "ipv6Gateway",
  "peerIpv4Host",
  "peerIpv4Guest",
  "peerIpv6Host",
  "peerIpv6Guest",
];
const fail = (): never => {
  throw new TypeError("linux_oci_host_topology_invalid");
};
function ipv4(value: string): bigint {
  if (isIP(value) !== 4) return fail();
  let encoded = 0n;
  for (const piece of value.split(".")) encoded = (encoded << 8n) | BigInt(piece);
  if (encoded >> 24n === 0n || encoded >> 24n === 127n || encoded >> 24n >= 224n) return fail();
  return encoded;
}
function ipv6(value: string): bigint {
  if (
    isIP(value) !== 6 ||
    value.includes("%") ||
    value.includes(".") ||
    new URL(`http://[${value}]/`).hostname !== `[${value}]`
  )
    return fail();
  const halves = value.split("::"),
    first = halves[0] ? halves[0].split(":") : [],
    last = halves[1] ? halves[1].split(":") : [];
  const pieces =
    halves.length === 1
      ? first
      : [...first, ...Array<string>(8 - first.length - last.length).fill("0"), ...last];
  let encoded = 0n;
  for (const piece of pieces) encoded = (encoded << 16n) | BigInt(`0x${piece}`);
  if (encoded <= 1n || encoded >> 120n === 255n || encoded >> 32n === 65535n) return fail();
  return encoded;
}
function cidr(value: string, width: number): { address: bigint; prefix: number } {
  const parts = value.split("/"),
    address = parts[0],
    prefix = parts[1];
  if (
    parts.length !== 2 ||
    address === undefined ||
    prefix === undefined ||
    !/^[1-9][0-9]{0,2}$/u.test(prefix) ||
    Number(prefix) > width
  )
    return fail();
  return { address: width === 32 ? ipv4(address) : ipv6(address), prefix: Number(prefix) };
}
const samePrefix = (a: bigint, b: bigint, width: number, prefix: number) =>
  a >> BigInt(width - prefix) === b >> BigInt(width - prefix);

/** Capture plain own data exactly once. Missing topology has no synthesized
 * interface, subnet, route or fallback. No getter is used to obtain a field. */
export function snapshotLinuxOciHostTopology(value: unknown): Readonly<LinuxOciHostTopology> {
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))
  )
    return fail();
  const data = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return fail();
    return descriptor.value;
  };
  const text = (name: string): string => {
    const field = data(name);
    if (typeof field !== "string") return fail();
    return field;
  };
  const interfaceName = text("interfaceName"),
    interfaceIndex = data("interfaceIndex"),
    interfaceMac = text("interfaceMac"),
    ipv4Address = text("ipv4Address"),
    ipv4Gateway = text("ipv4Gateway"),
    ipv6Address = text("ipv6Address"),
    ipv6Gateway = text("ipv6Gateway"),
    peerIpv4Host = text("peerIpv4Host"),
    peerIpv4Guest = text("peerIpv4Guest"),
    peerIpv6Host = text("peerIpv6Host"),
    peerIpv6Guest = text("peerIpv6Guest");
  if (
    !/^[a-zA-Z0-9_.-]{1,15}$/u.test(interfaceName) ||
    [".", "..", "lo"].includes(interfaceName) ||
    typeof interfaceIndex !== "number" ||
    !Number.isSafeInteger(interfaceIndex) ||
    interfaceIndex < 1 ||
    interfaceIndex > 2147483647 ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(interfaceMac) ||
    interfaceMac === "00:00:00:00:00:00" ||
    (Number.parseInt(interfaceMac.slice(0, 2), 16) & 1) !== 0
  )
    return fail();
  const local4 = cidr(ipv4Address, 32),
    gateway4 = ipv4(ipv4Gateway),
    local6 = cidr(ipv6Address, 128),
    gateway6 = ipv6(ipv6Gateway),
    host4 = ipv4(peerIpv4Host),
    guest4 = ipv4(peerIpv4Guest),
    host6 = ipv6(peerIpv6Host),
    guest6 = ipv6(peerIpv6Guest);
  const private4 = host4 >> 24n === 10n || host4 >> 20n === 2753n || host4 >> 16n === 49320n;
  const linkLocalGateway6 = gateway6 >> 118n === 1018n;
  if (
    gateway4 === local4.address ||
    !samePrefix(gateway4, local4.address, 32, local4.prefix) ||
    gateway6 === local6.address ||
    (!linkLocalGateway6 && !samePrefix(gateway6, local6.address, 128, local6.prefix)) ||
    !private4 ||
    host4 % 2n !== 0n ||
    guest4 !== host4 + 1n ||
    host6 >> 120n !== 253n ||
    host6 % 2n !== 0n ||
    guest6 !== host6 + 1n ||
    samePrefix(host4, local4.address, 32, Math.min(local4.prefix, 31)) ||
    samePrefix(host6, local6.address, 128, Math.min(local6.prefix, 127))
  )
    return fail();
  if (local4.prefix < 31) {
    const mask = (1n << BigInt(32 - local4.prefix)) - 1n;
    if (
      (local4.address & mask) === 0n ||
      (local4.address & mask) === mask ||
      (gateway4 & mask) === 0n ||
      (gateway4 & mask) === mask
    )
      return fail();
  }
  return Object.freeze({
    interfaceName,
    interfaceIndex,
    interfaceMac,
    ipv4Address,
    ipv4Gateway,
    ipv6Address,
    ipv6Gateway,
    peerIpv4Host,
    peerIpv4Guest,
    peerIpv6Host,
    peerIpv6Guest,
  });
}

/** Private expected coordinates only. Both address families must have separate
 * peer networks; no observation or permission follows from this comparison. */
export function linuxOciPeerNetworksDisjoint(
  a: LinuxOciHostTopology,
  b: LinuxOciHostTopology,
): boolean {
  return (
    ipv4(a.peerIpv4Host) >> 1n !== ipv4(b.peerIpv4Host) >> 1n &&
    ipv6(a.peerIpv6Host) >> 1n !== ipv6(b.peerIpv6Host) >> 1n
  );
}
export function snapshotLinuxOciTopologyPair(primary: unknown, alternate: unknown) {
  if (primary === undefined) {
    if (alternate !== undefined) return fail();
    return undefined;
  }
  const first = snapshotLinuxOciHostTopology(primary);
  if (alternate === undefined) return Object.freeze({ primary: first, alternate: undefined });
  const second = snapshotLinuxOciHostTopology(alternate);
  if (
    !keys
      .filter((key) => !key.startsWith("peer"))
      .every((key) => Reflect.get(first, key) === Reflect.get(second, key)) ||
    !linuxOciPeerNetworksDisjoint(first, second)
  )
    return fail();
  return Object.freeze({ primary: first, alternate: second });
}
export function linuxOciGenerationTopology(
  pair: NonNullable<ReturnType<typeof snapshotLinuxOciTopologyPair>>,
  generation: number,
) {
  if (!Number.isSafeInteger(generation) || generation < 1) return fail();
  return generation % 2 === 0 && pair.alternate !== undefined ? pair.alternate : pair.primary;
}

/** Private selection bytes from the ORIGINAL pending claim and artifact. The
 * native owner must verify real topology; this file can neither adopt a link
 * nor grant policy, admission, health, serving or terminal authority. */
export function serializeLinuxOciHostTopology(
  artifact: LinuxOciArtifactReceipt,
  record: DockerContainerCreateRecord,
  topology: LinuxOciHostTopology,
): string {
  const { intent } = record;
  if (
    record.state !== "pending" ||
    record.nativeId !== null ||
    artifact.claimId !== record.claimId ||
    artifact.installationId !== intent.installationId ||
    artifact.resourceUid !== intent.resourceUid ||
    artifact.incarnationId !== intent.incarnationId ||
    artifact.revision !== intent.revision ||
    artifact.generation !== intent.policy.generation
  )
    return fail();
  const bytes = JSON.stringify({
    kind: "linux-oci-owned-topology@1",
    artifact,
    topology: snapshotLinuxOciHostTopology(topology),
  });
  if (new TextEncoder().encode(bytes).length > 32768) return fail();
  return bytes;
}
