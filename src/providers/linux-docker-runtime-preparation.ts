import { isIP } from "node:net";
import { canonicalJson, isJsonObject } from "../json.ts";
import type { DockerContainerCreateHeldAuthority } from "./docker-container-create-custody.ts";
import {
  createDockerContainerCreateCustody,
  DockerContainerCreateCustody,
  type DockerContainerCreateRecord,
} from "./docker-container-create-custody.ts";
import type { DockerPhysicalOwnerPort } from "./docker-container-physical-preparation.ts";
import type {
  DockerContainerNativeIdentity,
  DockerContainerRuntimePolicy,
} from "./docker-container-runtime-preparation.ts";
import {
  applyLinuxContainerSharedBridgeGuard,
  compileLinuxContainerSharedBridgeGuard,
  type LinuxContainerHostHttpBridge,
  readLinuxContainerSharedBridgeGuard,
} from "./linux-container-egress.ts";
import {
  compileLinuxDockerGuestEgress,
  installLinuxDockerGuestEgress,
  readLinuxDockerGuestEgress,
  readLinuxDockerGuestEgressLifetime,
} from "./linux-docker-guest-egress.ts";
import {
  type DockerPhysicalContainerInspection,
  type DockerPhysicalProcessOptions,
  openDockerPhysicalProcess,
} from "./linux-docker-physical-session.ts";

export interface LinuxDockerPhysicalOwnerPort extends DockerPhysicalOwnerPort {
  readNetworkMemberRecords(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ): Promise<readonly DockerContainerCreateRecord[]>;
  /** Concrete original runtime class/private brand is checked by the original
   * same-Sql owner implementation. No ready DTO or verification callback. */
  publishServing(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    runtime: LinuxDockerRuntimePreparation,
  ): Promise<void>;
}
export interface LinuxDockerRuntimePreparationOptions {
  readonly policy: DockerContainerRuntimePolicy;
  readonly requiredSecretNames: readonly string[];
  readonly owner: LinuxDockerPhysicalOwnerPort;
  /** Same original Core factory custody, when composed by the actual entry.
   * This is the existing genuine constructor type, not a new grant port. */
  readonly createCustody?: DockerContainerCreateCustody;
  readonly process: Pick<
    DockerPhysicalProcessOptions,
    "helper" | "socketPath" | "peerPid" | "peerUid"
  > & {
    readonly ipBinary: string;
    readonly nftBinary: string;
    readonly guestNamespaceRoot: string;
  };
  readonly host: {
    readonly tcpPorts: readonly number[];
    readonly conntrackMark: number;
    /** Additional Host operator restrictions. Mandatory local Host/bridge
     * inventory comes from the actual pinned native helper, not this list. */
    readonly deniedDestinations: readonly string[];
  };
  readonly dnsServers: readonly string[];
  readonly maxConnections: number;
  readonly packetLimitBytes: number;
}
type Physical = Awaited<ReturnType<typeof openDockerPhysicalProcess>>;
interface HeldRuntime {
  readonly guard: () => Promise<void>;
  readonly close: () => Promise<void>;
}
const fail = (): never => {
  throw new Error("linux_docker_runtime_preparation_unavailable");
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const table = (id: string) => `takos_cx_${id.slice(0, 32)}`;
const id = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const digest = (x: unknown): x is string =>
  typeof x === "string" && /^sha256:[a-f0-9]{64}$/u.test(x);
function nativeSnapshot(input: DockerContainerNativeIdentity) {
  const value = structuredClone(input);
  if (
    !value ||
    Object.keys(value).sort().join() !==
      [
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
      ]
        .sort()
        .join() ||
    value.backend !== "docker" ||
    !id(value.nativeId) ||
    !id(value.networkId) ||
    !digest(value.imageId) ||
    !digest(value.identityLabel) ||
    !digest(value.revisionLabel) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(value.image) ||
    ["host", "bridge", "none"].includes(value.network) ||
    Object.values(value).some(
      (x) => typeof x !== "string" || x.length < 1 || x.length > 512 || /[\0\r\n]/u.test(x),
    )
  )
    return fail();
  return Object.freeze(value);
}

/** Opted-in Host implementation. It cannot manufacture a full-coverage receipt.
 * START is spent once in the original ledger, then the image boots with none
 * networking. Actual guest filtering precedes disconnect-none/connect-owned.
 * Unknown START/connect is never replayed. A complete attached owned-deny
 * ruleset may resume only through fresh original reconciliation authority. */
export class LinuxDockerRuntimePreparation {
  readonly policy: DockerContainerRuntimePolicy;
  readonly createCustody: ReturnType<typeof createDockerContainerCreateCustody>;
  readonly dnsServers: readonly string[];
  #options: LinuxDockerRuntimePreparationOptions;
  #owner: LinuxDockerPhysicalOwnerPort;
  #pending = new Map<string, Promise<HeldRuntime>>();
  #closed = false;
  constructor(options: LinuxDockerRuntimePreparationOptions) {
    if (
      !options ||
      !options.policy ||
      !options.owner ||
      !Array.isArray(options.requiredSecretNames) ||
      !options.process ||
      !options.host ||
      !Array.isArray(options.host.deniedDestinations) ||
      !Array.isArray(options.dnsServers) ||
      (options.policy.outboundInternet && options.dnsServers.length === 0) ||
      options.dnsServers.length > 3 ||
      options.dnsServers.some((x) => typeof x !== "string" || x.includes("%") || !isIP(x)) ||
      new Set(options.dnsServers).size !== options.dnsServers.length ||
      !Number.isSafeInteger(options.maxConnections) ||
      options.maxConnections < 0 ||
      options.maxConnections > 65535 ||
      !Number.isSafeInteger(options.packetLimitBytes) ||
      options.packetLimitBytes < 0 ||
      !Array.isArray(options.host.tcpPorts) ||
      options.host.tcpPorts.length < 1 ||
      options.host.tcpPorts.length > 64 ||
      options.host.tcpPorts.some((x) => !Number.isSafeInteger(x) || x < 1 || x > 65535) ||
      new Set(options.host.tcpPorts).size !== options.host.tcpPorts.length ||
      !Number.isSafeInteger(options.host.conntrackMark) ||
      options.host.conntrackMark < 1 ||
      options.host.conntrackMark > 0xffffffff ||
      options.host.deniedDestinations.length > 1024 ||
      options.host.deniedDestinations.some(
        (x) => typeof x !== "string" || x.includes("%") || !isIP(x),
      ) ||
      new Set(options.host.deniedDestinations).size !== options.host.deniedDestinations.length ||
      options.process.guestNamespaceRoot.length < 2 ||
      options.process.guestNamespaceRoot.length > 384 ||
      options.process.guestNamespaceRoot.endsWith("/") ||
      options.process.guestNamespaceRoot.includes("..") ||
      options.process.guestNamespaceRoot.includes("//") ||
      /[^\x21-\x7e]|\\/u.test(options.process.guestNamespaceRoot) ||
      ![
        options.process.helper,
        options.process.socketPath,
        options.process.ipBinary,
        options.process.nftBinary,
        options.process.guestNamespaceRoot,
      ].every((x) => typeof x === "string" && x.startsWith("/") && !/[\0\r\n]/u.test(x)) ||
      ![
        "read",
        "claim",
        "withAuthority",
        "bindNative",
        "confirmRemoved",
        "readStartClaim",
        "claimStart",
        "assertNetworkAllocation",
        "readNetworkMemberRecords",
        "publishServing",
      ].every((key) => typeof Reflect.get(options.owner, key) === "function")
    )
      fail();
    this.policy = Object.freeze(structuredClone(options.policy));
    const names = Object.freeze([...options.requiredSecretNames]);
    const source = options.owner;
    this.#owner = Object.freeze({
      read: source.read.bind(source),
      claim: source.claim.bind(source),
      withAuthority: source.withAuthority.bind(source),
      bindNative: source.bindNative.bind(source),
      confirmRemoved: source.confirmRemoved.bind(source),
      readStartClaim: source.readStartClaim.bind(source),
      claimStart: source.claimStart.bind(source),
      assertNetworkAllocation: source.assertNetworkAllocation.bind(source),
      readNetworkMemberRecords: source.readNetworkMemberRecords.bind(source),
      publishServing: source.publishServing.bind(source),
    });
    const localCustody = createDockerContainerCreateCustody({
      policy: this.policy,
      requiredSecretNames: names,
      owner: this.#owner,
    });
    if (
      options.createCustody !== undefined &&
      (!(options.createCustody instanceof DockerContainerCreateCustody) ||
        !same(options.createCustody.policy, this.policy) ||
        !same(options.createCustody.requiredSecretNames, names))
    )
      fail();
    this.createCustody = options.createCustody ?? localCustody;
    this.dnsServers = Object.freeze([...options.dnsServers]);
    this.#options = Object.freeze({
      ...options,
      policy: this.policy,
      requiredSecretNames: names,
      owner: this.#owner,
      process: Object.freeze(structuredClone(options.process)),
      host: Object.freeze({
        ...structuredClone(options.host),
        tcpPorts: Object.freeze([...options.host.tcpPorts]),
        deniedDestinations: Object.freeze([...options.host.deniedDestinations]),
      }),
      dnsServers: this.dnsServers,
    });
    Object.freeze(this);
  }
  async #record(native: DockerContainerNativeIdentity) {
    const intent = Object.freeze({
      installationId: native.installationId,
      resourceUid: native.resourceUid,
      incarnationId: native.incarnationId,
      revision: native.revision,
      nativeName: `takoserver-${native.identityLabel.slice(7)}`,
      identityLabel: native.identityLabel,
      revisionLabel: native.revisionLabel,
      policy: this.policy,
      requiredSecretNames: this.#options.requiredSecretNames,
    });
    const value = await this.#owner.read(intent);
    if (
      !value ||
      value.state !== "bound" ||
      value.nativeId !== native.nativeId ||
      !id(value.claimId) ||
      !same(value.intent, intent)
    )
      return fail();
    return Object.freeze(structuredClone(value));
  }
  async #open(
    native: DockerContainerNativeIdentity,
    kind: "control" | "guest" | "bridge",
    signal: AbortSignal,
  ): Promise<Physical> {
    const p = this.#options.process;
    return openDockerPhysicalProcess({
      helper: p.helper,
      socketPath: p.socketPath,
      peerPid: p.peerPid,
      peerUid: p.peerUid,
      networkId: native.networkId,
      table: table(kind === "bridge" ? native.networkId : native.nativeId),
      signal,
      ...(kind === "bridge" ? {} : { nativeId: native.nativeId }),
      native: {
        ipBinary: p.ipBinary,
        nftBinary: p.nftBinary,
        ...(kind === "control"
          ? { quarantineControl: true }
          : kind === "bridge"
            ? { hostBridge: true }
            : { guestNamespaceRoot: p.guestNamespaceRoot, guestFailClosed: true }),
      },
    });
  }
  #inspect(
    value: DockerPhysicalContainerInspection,
    record: DockerContainerCreateRecord,
    native?: DockerContainerNativeIdentity,
  ) {
    if (
      value.id !== record.nativeId ||
      value.claimId !== record.claimId ||
      value.identityLabel !== record.intent.identityLabel ||
      value.revisionLabel !== record.intent.revisionLabel ||
      (native && value.imageId !== native.imageId) ||
      value.networkMode !== "none" ||
      !Object.values(value.security).every((x) => x === true) ||
      value.paused ||
      value.restarting ||
      value.dead ||
      !same(value.dns, this.dnsServers)
    )
      fail();
  }
  async #lease(input: DockerContainerNativeIdentity, prepare: boolean): Promise<HeldRuntime> {
    if (this.#closed) return fail();
    const native = nativeSnapshot(input),
      record = await this.#record(native),
      key = canonicalJson({ native, record });
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => this.#capture(record, native, prepare));
      this.#pending.set(key, pending);
    }
    return pending;
  }
  #capture(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    prepare: boolean,
  ): Promise<HeldRuntime> {
    return new Promise<HeldRuntime>((resolve, reject) => {
      let release: () => void = () => {},
        settled = false,
        active = false,
        closed = false;
      const done = new Promise<void>((finish) => {
        release = finish;
      });
      const cancellation = new AbortController();
      const processes = new Set<Physical>();
      const closing = new Set<Physical>();
      let monitor: Promise<void> | undefined;
      const terminated = new Error("linux_docker_held_lifetime_terminated");
      const stop = () => {
        closed = true;
        cancellation.abort();
        release();
      };
      const openings = new Set<Promise<Physical>>();
      // Cancellation ends SQL observation without waiting for that SQL promise.
      // Abandoned reads hold no native write capability: all native opens and
      // requests remain tied to this same closed cancellation signal.
      const withinLifetime = async <T>(work: () => Promise<T>): Promise<T> => {
        if (closed || cancellation.signal.aborted) throw terminated;
        let abort: () => void = () => {};
        try {
          const cancelled = new Promise<never>((_, rejectCancelled) => {
            abort = () => rejectCancelled(terminated);
            cancellation.signal.addEventListener("abort", abort, { once: true });
            if (cancellation.signal.aborted) abort();
          });
          return await Promise.race([
            Promise.resolve().then(() => {
              if (closed || cancellation.signal.aborted) throw terminated;
              return work();
            }),
            cancelled,
          ]);
        } finally {
          cancellation.signal.removeEventListener("abort", abort);
        }
      };
      const acquire = async (open: () => Promise<Physical>): Promise<Physical> => {
        if (closed || cancellation.signal.aborted) throw terminated;
        const pending = open();
        openings.add(pending);
        try {
          const process = await pending;
          processes.add(process);
          if (closed || cancellation.signal.aborted) throw terminated;
          return process;
        } finally {
          openings.delete(pending);
        }
      };
      const closeScoped = async (process: Physical): Promise<void> => {
        closing.add(process);
        try {
          await process.close();
          // Keep failed closures registered for the final all-settled join.
          processes.delete(process);
        } finally {
          closing.delete(process);
        }
      };
      const owner = this.#owner,
        options = this.#options;
      // Expired authority still makes every original guard fail. Closing a
      // previously ready lifetime reports physical cleanup failure separately.
      let completion: Promise<void>,
        cleanupFailed = false;
      completion = owner
        .withAuthority(record, prepare ? "reconcile" : "observe", async (held) => {
          if (active || closed || held.revocation.aborted) return fail();
          active = true;
          held.revocation.addEventListener("abort", stop, { once: true });
          let control: Physical | undefined,
            guest: Physical | undefined,
            bridge: Physical | undefined;
          let attached = false;
          const authority = async () => {
            if (
              !active ||
              closed ||
              this.#closed ||
              held.revocation.aborted ||
              cancellation.signal.aborted ||
              (await held.stillCurrent()) !== true
            )
              return fail();
            if (!same(await owner.read(record.intent), record)) return fail();
            await owner.assertNetworkAllocation(record, native, this.policy);
            if (
              !active ||
              closed ||
              held.revocation.aborted ||
              (await held.stillCurrent()) !== true
            )
              return fail();
          };
          const boundedAuthority = async () => {
            const until = performance.now() + 1000;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                authority(),
                new Promise<never>((_, rejectDeadline) => {
                  timer = setTimeout(
                    () => rejectDeadline(new Error("linux_docker_authority_deadline")),
                    1000,
                  );
                }),
              ]);
              if (performance.now() >= until || closed || cancellation.signal.aborted)
                return fail();
            } finally {
              clearTimeout(timer);
            }
          };
          const monitorPause = () =>
            new Promise<void>((finishPause) => {
              let ended = false;
              const finish = () => {
                if (ended) return;
                ended = true;
                clearTimeout(timer);
                cancellation.signal.removeEventListener("abort", finish);
                finishPause();
              };
              const timer = setTimeout(finish, 250);
              cancellation.signal.addEventListener("abort", finish, { once: true });
              if (cancellation.signal.aborted) finish();
            });
          const startMonitor = async () => {
            if (monitor) return;
            const physical = guest;
            if (!physical) return fail();
            await boundedAuthority();
            await physical.keepGuestLifetime();
            if (closed || cancellation.signal.aborted) return fail();
            monitor = (async () => {
              try {
                while (!closed && !cancellation.signal.aborted) {
                  await monitorPause();
                  if (closed || cancellation.signal.aborted) break;
                  await boundedAuthority();
                  await physical.keepGuestLifetime();
                  if (closed || cancellation.signal.aborted) return fail();
                }
              } catch {
                stop();
              }
            })();
          };
          const opening = async (kind: "control" | "guest" | "bridge") => {
            await authority();
            const process = await acquire(() => this.#open(native, kind, cancellation.signal));
            void process.closed.then(() => {
              if (processes.has(process) && !closing.has(process)) stop();
            });
            await authority();
            return process;
          };
          try {
            await withinLifetime(async () => {
              await authority();
              const prior = await owner.readStartClaim(native, this.policy);
              if (prior !== "unclaimed" && prior !== "claimed" && prior !== "unknown")
                return fail();
              if (prepare && prior === "unclaimed") {
                control = await opening("control");
                const before = await control.inspect();
                this.#inspect(before, record, native);
                if (
                  before.running ||
                  before.networks.length !== 1 ||
                  before.networks[0]?.name !== "none"
                )
                  return fail();
                await authority();
                const claim = await owner.claimStart(native, this.policy);
                await authority();
                if (claim !== "claimed") return fail();
                await control.current();
                await authority();
                await control.quarantineStart();
                await authority();
              } else if (prior === "unclaimed") return fail();
              guest = await opening("guest");
              const initial = await guest.inspect();
              this.#inspect(initial, record, native);
              if (!initial.running) return fail();
              attached =
                initial.networks.length === 1 &&
                initial.networks[0]?.networkId === native.networkId;
              const installing = prepare && prior === "unclaimed";
              if (
                !attached &&
                (!installing ||
                  !control ||
                  initial.networks.length !== 1 ||
                  initial.networks[0]?.name !== "none")
              )
                return fail();
              bridge = await opening("bridge");
              const original = await bridge.bridgeBinding();
              const inventory = await guest.hostInventory();
              const deniedDestinations = Object.freeze(
                [...new Set([...inventory.addresses, ...options.host.deniedDestinations])].sort(),
              );
              if (deniedDestinations.length > 1024) return fail();
              const deniedNetworks = inventory.networks;
              const hostBridge: LinuxContainerHostHttpBridge = Object.freeze({
                tenantRef: this.policy.tenantRef,
                generation: this.policy.generation,
                networkId: native.networkId,
                bridge: original.name,
                ifindex: original.ifindex,
                hostMac: original.mac,
                hostAddresses: original.addresses,
                tcpPorts: options.host.tcpPorts,
                conntrackMark: options.host.conntrackMark,
              });
              const networkFact = async () => {
                if (!bridge) return fail();
                const network = await bridge.network();
                if (
                  !isJsonObject(network) ||
                  network.Id !== native.networkId ||
                  network.Name !== native.network ||
                  network.Driver !== "bridge" ||
                  network.Scope !== "local" ||
                  typeof network.Internal !== "boolean" ||
                  (this.policy.outboundInternet && network.Internal) ||
                  network.Ingress !== false ||
                  network.Attachable !== false ||
                  !isJsonObject(network.Labels) ||
                  network.Labels["takoserver.installation"] !== native.installationId ||
                  !isJsonObject(network.Options) ||
                  network.Options["com.docker.network.bridge.name"] !== original.name ||
                  !isJsonObject(network.IPAM) ||
                  !Array.isArray(network.IPAM.Config) ||
                  network.IPAM.Config.length < 1 ||
                  network.IPAM.Config.length > 8 ||
                  !isJsonObject(network.Containers)
                )
                  return fail();
                for (const item of network.IPAM.Config) {
                  if (
                    !isJsonObject(item) ||
                    typeof item.Gateway !== "string" ||
                    !isIP(item.Gateway) ||
                    !original.addresses.includes(item.Gateway) ||
                    typeof item.Subnet !== "string" ||
                    !/^.+\/[0-9]{1,3}$/u.test(item.Subnet)
                  )
                    return fail();
                  const [subnet, bits] = item.Subnet.split("/");
                  if (
                    !subnet ||
                    isIP(subnet) !== isIP(item.Gateway) ||
                    Number(bits) > (isIP(subnet) === 4 ? 32 : 128)
                  )
                    return fail();
                }
                const observed = Object.keys(network.Containers).sort();
                if (observed.length > 64 || !observed.every(id)) return fail();
                return {
                  observed,
                  configuration: canonicalJson({
                    id: network.Id,
                    name: network.Name,
                    internal: network.Internal,
                    options: network.Options,
                    ipam: network.IPAM,
                  }),
                };
              };
              const originalNetwork = await networkFact();
              await owner.readNetworkMemberRecords(
                record,
                native,
                this.policy,
                originalNetwork.observed,
              );
              await authority();
              const bridgePlan = compileLinuxContainerSharedBridgeGuard({
                namespace: `net:[${String(bridge.metadata.namespaceInode)}]`,
                table: table(native.networkId),
                bridge: hostBridge,
                policy: this.policy,
              });
              try {
                await readLinuxContainerSharedBridgeGuard(
                  bridgePlan,
                  bridge.bridgePort(bridgePlan),
                );
              } catch {
                if (!installing) return fail();
                // Missing/invalid read closes that helper. New exclusive creation
                // cannot overwrite a pre-existing malformed table. No install retry.
                await closeScoped(bridge);
                bridge = await opening("bridge");
                if (!same(await bridge.bridgeBinding(), original)) return fail();
                await authority();
                await applyLinuxContainerSharedBridgeGuard(
                  bridgePlan,
                  bridge.bridgePort(bridgePlan),
                );
                await authority();
              }
              const guestPlan = compileLinuxDockerGuestEgress({
                namespace: {
                  parent: `net:[${String(guest.metadata.parentInode)}]`,
                  selected: `net:[${String(guest.metadata.namespaceInode)}]`,
                },
                table: table(native.nativeId),
                policy: this.policy,
                killSwitch: false,
                maxConnections: options.maxConnections,
                packetLimitBytes: options.packetLimitBytes,
                host: {
                  addresses: original.addresses,
                  mac: original.mac,
                  tcpPorts: options.host.tcpPorts,
                  conntrackMark: options.host.conntrackMark,
                  deniedDestinations,
                  deniedNetworks,
                },
              });
              await authority();
              if (installing) {
                await installLinuxDockerGuestEgress(guestPlan, guest.port(guestPlan));
                await startMonitor();
              } else await readLinuxDockerGuestEgressLifetime(guestPlan, guest.port(guestPlan));
              await authority();
              const physical = guest,
                hostPhysical = bridge;
              const physicalRead = async () => {
                await authority();
                await physical.current();
                await hostPhysical.current();
                if (!same(await physical.hostInventory(), inventory)) return fail();
                const value = await physical.inspect();
                this.#inspect(value, record, native);
                const endpoint = value.networks[0];
                if (
                  !value.running ||
                  (attached
                    ? value.networks.length !== 1 ||
                      endpoint?.name !== native.network ||
                      endpoint?.networkId !== native.networkId ||
                      !id(endpoint?.endpointId)
                    : value.networks.length > 1 ||
                      (value.networks.length === 1 && endpoint?.name !== "none")) ||
                  value.pid !== initial.pid ||
                  value.sandboxId !== initial.sandboxId ||
                  !same(await hostPhysical.bridgeBinding(), original)
                )
                  return fail();
                const currentNetwork = await networkFact(),
                  observed = currentNetwork.observed;
                if (
                  currentNetwork.configuration !== originalNetwork.configuration ||
                  (attached && !observed.includes(native.nativeId))
                )
                  return fail();
                const members = await owner.readNetworkMemberRecords(
                  record,
                  native,
                  this.policy,
                  observed,
                );
                if (
                  members.length !== observed.length ||
                  !same(members.map((x) => x.nativeId).sort(), observed)
                )
                  return fail();
                for (const member of members)
                  if (member.nativeId !== native.nativeId) {
                    const memberId = member.nativeId;
                    if (!id(memberId) || member.state !== "bound") return fail();
                    const observed = new Error("linux_docker_member_observation_complete");
                    let entered = false;
                    const inspectMember = async (
                      otherHeld: DockerContainerCreateHeldAuthority,
                    ): Promise<never> => {
                      entered = true;
                      await withinLifetime(async () => {
                        if (
                          otherHeld.revocation.aborted ||
                          (await otherHeld.stillCurrent()) !== true ||
                          member.nativeId !== memberId
                        )
                          return fail();
                        const p = options.process;
                        const other = await acquire(() =>
                          openDockerPhysicalProcess({
                            helper: p.helper,
                            socketPath: p.socketPath,
                            peerPid: p.peerPid,
                            peerUid: p.peerUid,
                            networkId: native.networkId,
                            nativeId: memberId,
                            table: table(memberId),
                            signal: cancellation.signal,
                            native: {
                              ipBinary: p.ipBinary,
                              nftBinary: p.nftBinary,
                              guestNamespaceRoot: p.guestNamespaceRoot,
                            },
                          }),
                        );
                        try {
                          const snapshot = await other.inspect();
                          if (
                            snapshot.id !== memberId ||
                            snapshot.claimId !== member.claimId ||
                            snapshot.identityLabel !== member.intent.identityLabel ||
                            snapshot.revisionLabel !== member.intent.revisionLabel ||
                            !snapshot.running ||
                            snapshot.networks.length !== 1 ||
                            snapshot.networks[0]?.networkId !== native.networkId ||
                            !same(snapshot.dns, this.dnsServers) ||
                            !Object.values(snapshot.security).every((x) => x)
                          )
                            return fail();
                          const plan = compileLinuxDockerGuestEgress({
                            namespace: {
                              parent: `net:[${String(other.metadata.parentInode)}]`,
                              selected: `net:[${String(other.metadata.namespaceInode)}]`,
                            },
                            table: table(memberId),
                            policy: member.intent.policy,
                            killSwitch: false,
                            maxConnections: options.maxConnections,
                            packetLimitBytes: options.packetLimitBytes,
                            host: {
                              addresses: original.addresses,
                              mac: original.mac,
                              tcpPorts: options.host.tcpPorts,
                              conntrackMark: options.host.conntrackMark,
                              deniedDestinations,
                              deniedNetworks,
                            },
                          });
                          // Closed members are safe occupants, not healthy serving
                          // instances. This caller never reactivates another member.
                          await readLinuxDockerGuestEgressLifetime(plan, other.port(plan));
                          await other.current();
                          if (
                            otherHeld.revocation.aborted ||
                            (await otherHeld.stillCurrent()) !== true
                          )
                            return fail();
                        } finally {
                          await closeScoped(other);
                        }
                      });
                      // The original guard was checked after observation. Throw a
                      // private completion sentinel so the owner's extra post-use DB
                      // read cannot strand an already-completed physical observation.
                      throw observed;
                    };
                    try {
                      try {
                        await owner.withAuthority(member, "observe", inspectMember);
                      } catch (error: unknown) {
                        if (error === observed || entered) throw error;
                        // Superseded accepted occupants are cleanup subjects, not
                        // healthy serving members. Only original remove authority
                        // may permit this same strictly read-only native inspection.
                        await owner.withAuthority(member, "remove", inspectMember);
                      }
                      return fail();
                    } catch (error: unknown) {
                      if (error !== observed) throw error;
                    }
                  }
                const lifetime = await readLinuxDockerGuestEgressLifetime(
                  guestPlan,
                  physical.port(guestPlan),
                );
                await readLinuxContainerSharedBridgeGuard(
                  bridgePlan,
                  hostPhysical.bridgePort(bridgePlan),
                );
                const afterNetwork = await networkFact();
                if (
                  afterNetwork.configuration !== originalNetwork.configuration ||
                  !same(afterNetwork.observed, observed)
                )
                  return fail();
                await physical.current();
                await authority();
                return lifetime;
              };
              const guard = async () =>
                withinLifetime(async () => {
                  if ((await physicalRead()).denyHandles.length !== 0) return fail();
                });
              if (!attached) {
                if (!control) return fail();
                await guard();
                await authority();
                await control.disconnectNone();
                await guest.current();
                await guard();
                await authority();
                await readLinuxDockerGuestEgress(guestPlan, guest.port(guestPlan));
                await readLinuxContainerSharedBridgeGuard(
                  bridgePlan,
                  bridge.bridgePort(bridgePlan),
                );
                await authority();
                await control.connectOwned();
                await guest.current();
                await authority();
                attached = true;
              }
              const closedLifetime = await physicalRead();
              if (closedLifetime.denyHandles.length > 0) {
                if (!attached || installing) return fail();
                // This is kernel reactivation under a NEW genuine reconcile hold,
                // not a START/connect retry or a caller-provided ready/grant flag.
                const resumed = new Error("linux_docker_guest_resume_complete");
                try {
                  await owner.withAuthority(record, "reconcile", async (fresh) => {
                    await withinLifetime(async () => {
                      const freshGuard = async () => {
                        if (
                          fresh.revocation.aborted ||
                          (await fresh.stillCurrent()) !== true ||
                          !same(await owner.read(record.intent), record)
                        )
                          return fail();
                        await owner.assertNetworkAllocation(record, native, this.policy);
                        await authority();
                        if (fresh.revocation.aborted || (await fresh.stillCurrent()) !== true)
                          return fail();
                      };
                      await freshGuard();
                      const latest = await physicalRead();
                      if (!same(latest.denyHandles, closedLifetime.denyHandles)) return fail();
                      await freshGuard();
                      await physical.resumeGuestLifetime();
                      await freshGuard();
                      await startMonitor();
                      await guard();
                      await freshGuard();
                    });
                    throw resumed;
                  });
                  return fail();
                } catch (error: unknown) {
                  if (error !== resumed) throw error;
                }
              }
              await guard();
              await guest.armGuestLifetime();
              await startMonitor();
              await guard();
              if (closed || cancellation.signal.aborted) throw terminated;
              settled = true;
              resolve(
                Object.freeze({
                  guard,
                  close: async () => {
                    stop();
                    await completion;
                    if (cleanupFailed) return fail();
                  },
                }),
              );
              await done;
              // Never normally return a released lifetime into the original owner's
              // post-use DB guard. DB failure must not make completed native cleanup
              // wait forever on that same database. The per-lifetime sentinel is
              // classified only after all owned cleanup is joined in finally.
              throw terminated;
            });
          } finally {
            active = false;
            held.revocation.removeEventListener("abort", stop);
            stop();
            if (monitor) await monitor;
            // All opens were registered before awaiting them. Abort closes even
            // an in-flight helper hello; join those opens before taking the final
            // native process set, including helpers from cancelled member reads.
            await Promise.allSettled([...openings]);
            const closure = await Promise.allSettled(
              [...processes].map((process) => process.close()),
            );
            if (closure.some((result) => result.status === "rejected")) {
              cleanupFailed = true;
              fail();
            }
          }
        })
        .then(
          () => {
            if (!settled) reject(new Error("linux_docker_runtime_preparation_unavailable"));
          },
          () => {
            stop();
            if (!settled) reject(new Error("linux_docker_runtime_preparation_unavailable"));
          },
        );
    });
  }
  async ensureRunning(identity: DockerContainerNativeIdentity): Promise<void> {
    await (await this.#lease(identity, true)).guard();
  }
  async verifyExisting(identity: DockerContainerNativeIdentity): Promise<() => Promise<void>> {
    const held = await this.#lease(identity, false);
    await held.guard();
    return held.guard;
  }
  /** Called only by the driver after real health, with its original bound
   * custody session guard still active. Original owner checks this class brand. */
  async publishServing(identity: DockerContainerNativeIdentity): Promise<void> {
    const native = nativeSnapshot(identity),
      record = await this.#record(native);
    const guard = await this.verifyExisting(native);
    await guard();
    await this.#owner.publishServing(record, native, this.policy, this);
    await guard();
  }
  async close(): Promise<void> {
    this.#closed = true;
    let failed = false;
    for (const pending of this.#pending.values()) {
      try {
        await (await pending).close();
      } catch {
        failed = true;
      }
    }
    if (failed) return fail();
  }
}
