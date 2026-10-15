import { isJsonObject } from "../json.ts";
import { DockerContainerCreateCustody } from "./docker-container-create-custody.ts";

/** Host-only inspected object/configured network binding, never a tenant selector.
 * A stopped binding does not establish a kernel endpoint or installed filter.
 */
export interface DockerContainerNativeIdentity {
  readonly backend: "docker";
  readonly installationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly revision: string;
  readonly nativeId: string;
  readonly network: string;
  /** Daemon-recorded immutable network configuration, also checked against owned network readback. */
  readonly networkId: string;
  readonly image: string;
  readonly imageId: string;
  readonly identityLabel: string;
  readonly revisionLabel: string;
}

/** Nonsecret Host authority/policy references, not Container Form fields. */
export interface DockerContainerRuntimePolicy {
  readonly tenantRef: string;
  readonly generation: number;
  readonly policyDigest: string;
  readonly outboundInternet: boolean;
}

export interface DockerContainerRuntimeReceipt {
  readonly native: DockerContainerNativeIdentity;
  readonly policy: DockerContainerRuntimePolicy;
  readonly installed: boolean;
  readonly topology: {
    readonly networkId: string;
    readonly rulesetDigest: string;
    readonly meterId: string;
  };
  readonly coverage: Readonly<Record<(typeof REQUIRED_COVERAGE)[number], boolean>> & {
    readonly denyAllOutbound: boolean;
    readonly publicInternet: boolean;
  };
}

export interface DockerContainerRuntimeLease {
  readonly revocation: AbortSignal;
  stillCurrent(): Promise<boolean>;
  /** Actual trusted external topology/filter/meter readback, never image-side assertions. */
  readback(): Promise<unknown>;
  /** Durable atomic claim keyed by native identity and policy; consumed even on unknown ACK. */
  claimStart(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"claimed" | "already-claimed" | "unknown">;
}

export interface DockerContainerRuntimePreparationOptions {
  readonly policy: DockerContainerRuntimePolicy;
  /** Nonempty declarations require the exact explicit Host creation-custody port. */
  readonly requiredSecretNames?: readonly string[];
  readonly createCustody?: DockerContainerCreateCustody;
  /** Durable read-only lookup before any install/effect; uncertainty cannot authorize preparation. */
  readStartClaim(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"unclaimed" | "claimed" | "unknown">;
  prepare(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<DockerContainerRuntimeLease | null>;
  /** Read-only recovery of installed enforcement/current authority; cannot install or start. */
  recover(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<DockerContainerRuntimeLease | null>;
}

const REQUIRED_COVERAGE = [
  "ipv4",
  "ipv6",
  "tcp",
  "udp",
  "hostInput",
  "forwardedTraffic",
  "tenantIsolation",
  "privateAddressDeny",
  "metadataDeny",
  "tcp25Deny",
  "connectionLimit",
  "bandwidthLimit",
  "rawEgressMeter",
  "killSwitch",
] as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const NATIVE_ID = /^[a-f0-9]{64}$/u;
const NATIVE_KEYS = [
  "backend",
  "installationId",
  "resourceUid",
  "incarnationId",
  "revision",
  "nativeId",
  "network",
  "networkId",
  "image",
  "imageId",
  "identityLabel",
  "revisionLabel",
] as const;
const POLICY_KEYS = ["tenantRef", "generation", "policyDigest", "outboundInternet"] as const;

export class DockerContainerRuntimePreparationError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "unavailable") {
    super(code);
    this.name = "DockerContainerRuntimePreparationError";
  }
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function text(value: unknown, max = 256): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (const char of value) {
    const point = char.charCodeAt(0);
    if (point < 32 || point === 127) return false;
  }
  return true;
}
function nativeSnapshot(value: DockerContainerNativeIdentity): DockerContainerNativeIdentity {
  if (
    !closed(value, NATIVE_KEYS) ||
    value.backend !== "docker" ||
    !NATIVE_KEYS.every((key) => text(value[key], key === "image" ? 512 : 256)) ||
    !NATIVE_ID.test(value.nativeId) ||
    !NATIVE_ID.test(value.networkId) ||
    !SHA256.test(value.imageId) ||
    !SHA256.test(value.identityLabel) ||
    !SHA256.test(value.revisionLabel) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(value.image) ||
    ["host", "bridge", "none"].includes(value.network)
  )
    throw new DockerContainerRuntimePreparationError("conflict");
  return Object.freeze({ ...value });
}

function matchesReceipt(
  receipt: unknown,
  native: DockerContainerNativeIdentity,
  policy: DockerContainerRuntimePolicy,
): boolean {
  try {
    if (!closed(receipt, ["native", "policy", "installed", "topology", "coverage"])) return false;
    const actualNative = receipt.native;
    const actualPolicy = receipt.policy;
    const topology = receipt.topology;
    const coverage = receipt.coverage;
    return (
      receipt.installed === true &&
      closed(actualNative, NATIVE_KEYS) &&
      NATIVE_KEYS.every((key) => actualNative[key] === native[key]) &&
      closed(actualPolicy, POLICY_KEYS) &&
      POLICY_KEYS.every((key) => actualPolicy[key] === policy[key]) &&
      closed(topology, ["networkId", "rulesetDigest", "meterId"]) &&
      topology.networkId === native.networkId &&
      typeof topology.rulesetDigest === "string" &&
      SHA256.test(topology.rulesetDigest) &&
      text(topology.meterId) &&
      closed(coverage, [...REQUIRED_COVERAGE, "denyAllOutbound", "publicInternet"]) &&
      REQUIRED_COVERAGE.every((key) => coverage[key] === true) &&
      coverage.denyAllOutbound === !policy.outboundInternet &&
      coverage.publicInternet === policy.outboundInternet
    );
  } catch {
    return false;
  }
}

/** This guard wires trusted ports; it installs no firewall, quota, meter or billing itself. */
export class DockerContainerRuntimePreparation {
  readonly policy: DockerContainerRuntimePolicy;
  readonly createCustody: DockerContainerCreateCustody | undefined;
  readonly #prepare: DockerContainerRuntimePreparationOptions["prepare"];
  readonly #recover: DockerContainerRuntimePreparationOptions["recover"];
  readonly #readStartClaim: DockerContainerRuntimePreparationOptions["readStartClaim"];

  constructor(options: DockerContainerRuntimePreparationOptions) {
    const policy = options.policy;
    if (
      !closed(policy, POLICY_KEYS) ||
      !text(policy.tenantRef) ||
      !Number.isSafeInteger(policy.generation) ||
      policy.generation < 1 ||
      !SHA256.test(policy.policyDigest) ||
      typeof policy.outboundInternet !== "boolean" ||
      typeof options.prepare !== "function" ||
      typeof options.recover !== "function" ||
      typeof options.readStartClaim !== "function" ||
      (options.requiredSecretNames !== undefined && !Array.isArray(options.requiredSecretNames)) ||
      (options.createCustody !== undefined &&
        !(options.createCustody instanceof DockerContainerCreateCustody))
    )
      throw new DockerContainerRuntimePreparationError("invalid_request");
    if (options.requiredSecretNames?.length && !options.createCustody)
      throw new DockerContainerRuntimePreparationError("unavailable");
    if (options.createCustody) {
      const custody = options.createCustody;
      const names = options.requiredSecretNames ?? [];
      if (
        !POLICY_KEYS.every((key) => policy[key] === custody.policy[key]) ||
        names.length !== custody.requiredSecretNames.length ||
        !names.every(
          (name) => typeof name === "string" && custody.requiredSecretNames.includes(name),
        ) ||
        new Set(names).size !== names.length
      )
        throw new DockerContainerRuntimePreparationError("conflict");
    }
    this.policy = Object.freeze({ ...policy });
    this.createCustody = options.createCustody;
    this.#prepare = options.prepare.bind(options);
    this.#recover = options.recover.bind(options);
    this.#readStartClaim = options.readStartClaim.bind(options);
    Object.freeze(this);
  }

  async #lease(native: DockerContainerNativeIdentity, prepare: boolean) {
    let lease: DockerContainerRuntimeLease | null;
    try {
      lease = await (prepare ? this.#prepare : this.#recover)(native, this.policy);
    } catch {
      throw new DockerContainerRuntimePreparationError("unavailable");
    }
    let revocation: AbortSignal;
    let stillCurrent: DockerContainerRuntimeLease["stillCurrent"];
    let readback: DockerContainerRuntimeLease["readback"];
    let claimStart: DockerContainerRuntimeLease["claimStart"];
    try {
      if (!lease) throw new Error();
      const signal = lease.revocation;
      const current = lease.stillCurrent;
      const read = lease.readback;
      const claim = lease.claimStart;
      if (
        !(signal instanceof AbortSignal) ||
        typeof current !== "function" ||
        typeof read !== "function" ||
        typeof claim !== "function"
      )
        throw new Error();
      revocation = signal;
      stillCurrent = current.bind(lease);
      readback = read.bind(lease);
      claimStart = claim.bind(lease);
    } catch {
      throw new DockerContainerRuntimePreparationError("unavailable");
    }
    const authorityGuard = async () => {
      if (revocation.aborted) throw new DockerContainerRuntimePreparationError("unavailable");
      let current: boolean;
      try {
        current = await stillCurrent();
      } catch {
        throw new DockerContainerRuntimePreparationError("unavailable");
      }
      if (current !== true || revocation.aborted)
        throw new DockerContainerRuntimePreparationError("unavailable");
    };
    let topology: string | undefined;
    const guard = async () => {
      await authorityGuard();
      let receipt: unknown;
      try {
        // Do not retain a producer-owned mutable receipt across awaited checks.
        receipt = structuredClone(await readback());
      } catch {
        throw new DockerContainerRuntimePreparationError("unavailable");
      }
      if (!matchesReceipt(receipt, native, this.policy))
        throw new DockerContainerRuntimePreparationError("conflict");
      const actual = (receipt as DockerContainerRuntimeReceipt).topology;
      const observed = JSON.stringify([actual.networkId, actual.rulesetDigest, actual.meterId]);
      await authorityGuard();
      if (topology !== undefined && topology !== observed)
        throw new DockerContainerRuntimePreparationError("conflict");
      topology = observed;
    };
    await guard();
    return { guard, claimStart };
  }

  /** Keep the captured authority guard through any subsequent awaited health work. */
  async verifyExisting(identity: DockerContainerNativeIdentity): Promise<() => Promise<void>> {
    const native = nativeSnapshot(identity);
    let previous: string;
    try {
      previous = await this.#readStartClaim(native, this.policy);
    } catch {
      throw new DockerContainerRuntimePreparationError("unavailable");
    }
    if (previous !== "claimed" && previous !== "unknown")
      throw new DockerContainerRuntimePreparationError("conflict");
    return (await this.#lease(native, false)).guard;
  }

  async authorizeStart(
    request: { readonly native: DockerContainerNativeIdentity; readonly state: "stopped" },
    start: (guard: () => Promise<void>) => Promise<void>,
  ): Promise<"started" | "unknown" | "readback"> {
    if (request.state !== "stopped") throw new DockerContainerRuntimePreparationError("conflict");
    const native = nativeSnapshot(request.native);
    let previous: string;
    try {
      previous = await this.#readStartClaim(native, this.policy);
    } catch {
      throw new DockerContainerRuntimePreparationError("unavailable");
    }
    if (previous === "claimed" || previous === "unknown") {
      await this.#lease(native, false);
      return "readback";
    }
    if (previous !== "unclaimed") throw new DockerContainerRuntimePreparationError("unavailable");
    const { guard, claimStart } = await this.#lease(native, true);
    let claim: string;
    try {
      claim = await claimStart(native, this.policy);
    } catch {
      throw new DockerContainerRuntimePreparationError("unavailable");
    }
    await guard();
    if (claim === "already-claimed" || claim === "unknown") return "readback";
    if (claim !== "claimed") throw new DockerContainerRuntimePreparationError("unavailable");
    try {
      await start(guard);
      return "started";
    } catch {
      // The durable claim survives unknown native ACK; never replay the effect.
      return "unknown";
    }
  }
}

export function createDockerContainerRuntimePreparation(
  options: DockerContainerRuntimePreparationOptions,
): DockerContainerRuntimePreparation {
  return new DockerContainerRuntimePreparation(options);
}
