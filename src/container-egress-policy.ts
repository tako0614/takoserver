/** Host-private policy inputs, not Container Form fields or native enforcement. */
export interface ContainerTenantEgressPolicy {
  readonly outboundInternet?: boolean;
  readonly maxConnections: number;
  readonly bandwidthLimitBytes: number;
}

export interface ContainerEgressPolicy {
  readonly killSwitch: boolean;
  readonly tenants: Readonly<Record<string, ContainerTenantEgressPolicy>>;
}

export interface ContainerTenantEgressUsage {
  readonly activeConnections: number;
  readonly bandwidthUsedBytes: number;
  readonly egressBytes: number;
}

export type ContainerEgressUsage = Readonly<Record<string, ContainerTenantEgressUsage>>;

export interface ContainerEgressRequest {
  readonly tenantId: string;
  readonly operation: "open" | "send";
  /** The adapter must pin this resolved address to the actual native connection. */
  readonly destinationIp: string;
  readonly destinationPort: number;
  readonly transport: "tcp" | "udp";
  readonly bytes: number;
}

export type ContainerEgressVerdictReason =
  | "allowed"
  | "kill_switch"
  | "unknown_tenant"
  | "outbound_disabled"
  | "invalid_input"
  | "invalid_address"
  | "blocked_address"
  | "blocked_tcp_port"
  | "connection_limit"
  | "connection_not_open"
  | "bandwidth_limit"
  | "accounting_overflow";

export interface ContainerEgressEvaluation {
  readonly allowed: boolean;
  readonly reason: ContainerEgressVerdictReason;
  readonly billableEgressBytes: number;
  readonly usage: ContainerEgressUsage;
}

const ZERO_USAGE: ContainerTenantEgressUsage = Object.freeze({
  activeConnections: 0,
  bandwidthUsedBytes: 0,
  egressBytes: 0,
});

function counter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function ipv4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let address = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255) return null;
    address = (address << 8n) | BigInt(part);
  }
  return address;
}

/** Strict address literals only: no DNS, URL coercion, brackets or scope IDs. */
function parseAddress(ip: string): { family: 4 | 6; value: bigint } | null {
  if (typeof ip !== "string" || ip.length === 0 || ip.length > 45) return null;
  if (!ip.includes(":")) {
    const value = ipv4(ip);
    return value === null ? null : { family: 4, value };
  }
  let normalized = ip;
  if (ip.includes(".")) {
    const separator = ip.lastIndexOf(":");
    const embedded = ipv4(ip.slice(separator + 1));
    if (embedded === null) return null;
    normalized = `${ip.slice(0, separator + 1)}${(embedded >> 16n).toString(16)}:${(
      embedded & 0xffffn
    ).toString(16)}`;
  }
  const sides = normalized.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] === "" ? [] : (sides[0]?.split(":") ?? []);
  const right = sides[1] === undefined || sides[1] === "" ? [] : sides[1].split(":");
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/iu.test(word))) return null;
  const supplied = left.length + right.length;
  if (sides.length === 1 ? supplied !== 8 : supplied >= 8) return null;
  const words = [...left, ...Array<string>(8 - supplied).fill("0"), ...right];
  const value = words.reduce((address, word) => (address << 16n) | BigInt(`0x${word}`), 0n);
  // IPv4-mapped IPv6 uses the embedded address's policy, including metadata.
  return value >> 32n === 0xffffn
    ? { family: 4, value: value & 0xffffffffn }
    : { family: 6, value };
}

function blockedAddress({ family, value }: { family: 4 | 6; value: bigint }): boolean {
  if (family === 4)
    return (
      value >> 24n === 10n || // 10.0.0.0/8
      value >> 20n === 0xac1n || // 172.16.0.0/12
      value >> 16n === 0xc0a8n || // 192.168.0.0/16
      value >> 22n === 0x191n || // 100.64.0.0/10
      value >> 24n === 127n || // 127.0.0.0/8
      value >> 16n === 0xa9fen // 169.254.0.0/16, including metadata
    );
  return value >> 121n === 0x7en || value >> 118n === 0x3fan || value === 1n;
}

/**
 * Evaluate one operation against the latest Host policy and a detached tenant
 * accounting snapshot. Every refused operation transmits/meters zero bytes.
 * A send is atomic; bytes are raw billable usage, without rounding or tariffs.
 * The adapter owns serialization, window reset, connection release and native
 * cancellation/enforcement. This pure function does not establish support.
 */
export function evaluateContainerEgress({
  policy,
  usage,
  request,
}: {
  readonly policy: ContainerEgressPolicy;
  readonly usage: ContainerEgressUsage;
  readonly request: ContainerEgressRequest;
}): ContainerEgressEvaluation {
  const reject = (reason: ContainerEgressVerdictReason): ContainerEgressEvaluation => ({
    allowed: false,
    reason,
    billableEgressBytes: 0,
    usage,
  });
  if (policy.killSwitch) return reject("kill_switch");
  const tenant = Object.hasOwn(policy.tenants, request.tenantId)
    ? policy.tenants[request.tenantId]
    : undefined;
  if (!tenant) return reject("unknown_tenant");
  if (tenant.outboundInternet !== true) return reject("outbound_disabled");
  const current = Object.hasOwn(usage, request.tenantId) ? usage[request.tenantId] : ZERO_USAGE;
  if (
    !current ||
    !counter(current.activeConnections) ||
    !counter(current.bandwidthUsedBytes) ||
    !counter(current.egressBytes) ||
    !counter(tenant.maxConnections) ||
    !counter(tenant.bandwidthLimitBytes) ||
    !counter(request.bytes) ||
    !Number.isSafeInteger(request.destinationPort) ||
    request.destinationPort < 1 ||
    request.destinationPort > 65535 ||
    (request.operation !== "open" && request.operation !== "send") ||
    (request.transport !== "tcp" && request.transport !== "udp") ||
    (request.operation === "open" && request.bytes !== 0)
  )
    return reject("invalid_input");
  const address = parseAddress(request.destinationIp);
  if (!address) return reject("invalid_address");
  if (blockedAddress(address)) return reject("blocked_address");
  if (request.transport === "tcp" && request.destinationPort === 25)
    return reject("blocked_tcp_port");
  if (request.operation === "open" && current.activeConnections >= tenant.maxConnections)
    return reject("connection_limit");
  if (request.operation === "send" && current.activeConnections === 0)
    return reject("connection_not_open");
  if (request.bytes > tenant.bandwidthLimitBytes - current.bandwidthUsedBytes)
    return reject("bandwidth_limit");
  if (request.bytes > Number.MAX_SAFE_INTEGER - current.egressBytes)
    return reject("accounting_overflow");
  return {
    allowed: true,
    reason: "allowed",
    billableEgressBytes: request.bytes,
    usage: {
      ...usage,
      [request.tenantId]: {
        activeConnections: current.activeConnections + (request.operation === "open" ? 1 : 0),
        bandwidthUsedBytes: current.bandwidthUsedBytes + request.bytes,
        egressBytes: current.egressBytes + request.bytes,
      },
    },
  };
}
