import { canonicalJson } from "../json.ts";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateIntent,
  type DockerContainerCreateOwnerPort,
  type DockerContainerCreateRecord,
} from "./docker-container-create-custody.ts";
import {
  createDockerContainerRuntimePreparation,
  type DockerContainerNativeIdentity,
  type DockerContainerRuntimeLease,
  type DockerContainerRuntimePolicy,
} from "./docker-container-runtime-preparation.ts";
import {
  applyLinuxContainerEgress,
  compileLinuxContainerEgress,
  normalizeLinuxContainerEgressInterfaceReadback,
  readLinuxContainerEgress,
} from "./linux-container-egress.ts";
import {
  type DockerPhysicalProcessOptions,
  openDockerPhysicalProcess,
  readDockerPhysicalBridgeBinding,
} from "./linux-docker-physical-session.ts";

/** Same actual Host owner/ledger as CREATE. These are Host-internal existing
 * START claim/allocation operations, not another serving coordinator or store.
 * A production owner must resolve the original accepted scope/ref by claimId.
 */
export interface DockerPhysicalOwnerPort extends DockerContainerCreateOwnerPort {
  readStartClaim(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"unclaimed" | "claimed" | "unknown">;
  claimStart(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"claimed" | "already-claimed" | "unknown">;
  /** Actual accepted allocation ownership/serialization, never echoed labels or
   * an `exclusive:true` flag. Must reject unresolved native installation effects.
   */
  assertNetworkAllocation(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<void>;
}

function fail(): never {
  throw new Error("docker_physical_preparation_unavailable");
}

/** Native producer wired directly to actual CREATE owner custody. There is no
 * old prepare()/recover() bootstrap and no way to upgrade partial flags to full.
 * Final support still requires actual owner coupling and native qualification.
 */
export function createDockerPhysicalRuntimePreparation(options: {
  readonly policy: DockerContainerRuntimePolicy;
  readonly requiredSecretNames: readonly string[];
  readonly owner: DockerPhysicalOwnerPort;
  readonly process: Omit<DockerPhysicalProcessOptions, "networkId" | "signal">;
  readonly host: { readonly tcpPorts: readonly number[]; readonly conntrackMark: number };
  readonly maxConnections: number;
  readonly packetLimitBytes: number;
}) {
  const policy = Object.freeze(structuredClone(options.policy));
  const selectedNames = options.requiredSecretNames;
  if (!Array.isArray(selectedNames)) return fail();
  const names = Object.freeze([...selectedNames]);
  // Explicit empty names still pass through original custody/owner validation.
  const selected = Object.freeze(structuredClone(options.process));
  const host = Object.freeze(structuredClone(options.host));
  const maxConnections = options.maxConnections,
    packetLimitBytes = options.packetLimitBytes;
  const source = options.owner;
  const owner = Object.freeze({
    read: source.read.bind(source),
    claim: source.claim.bind(source),
    withAuthority: source.withAuthority.bind(source),
    bindNative: source.bindNative.bind(source),
    confirmStopped: source.confirmStopped.bind(source),
    confirmRemoved: source.confirmRemoved.bind(source),
    readStartClaim: source.readStartClaim.bind(source),
    claimStart: source.claimStart.bind(source),
    assertNetworkAllocation: source.assertNetworkAllocation.bind(source),
  });
  const custody = createDockerContainerCreateCustody({ policy, requiredSecretNames: names, owner });
  const leases = new Map<string, Promise<DockerContainerRuntimeLease>>();

  async function open(native: DockerContainerNativeIdentity, mode: "prepare" | "recover") {
    const captured = Object.freeze(structuredClone(native));
    const intent: DockerContainerCreateIntent = Object.freeze({
      installationId: captured.installationId,
      resourceUid: captured.resourceUid,
      incarnationId: captured.incarnationId,
      revision: captured.revision,
      // This is DockerHTTP's existing identity label/name, not a new selector.
      nativeName: `takoserver-${captured.identityLabel.slice(7)}`,
      identityLabel: captured.identityLabel,
      revisionLabel: captured.revisionLabel,
      policy,
      requiredSecretNames: names,
    });
    const value = await owner.read(intent);
    if (value === null) return fail();
    const record = structuredClone(value);
    if (
      Object.keys(record).sort().join() !==
        ["claimId", "intent", "nativeId", "state"].sort().join() ||
      !/^[a-f0-9]{64}$/u.test(record.claimId) ||
      record.state !== "bound" ||
      record.nativeId !== captured.nativeId ||
      canonicalJson(record.intent) !== canonicalJson(intent)
    )
      return fail();
    // Canonical source identity, including the original CREATE claim anchor.
    // Object property order can never create a second local install attempt.
    const key = canonicalJson({ claimId: record.claimId, native: captured, policy });
    let pending = leases.get(key);
    if (pending === undefined) {
      // Register before entering any awaited owner/native work, including a
      // synchronously invoking producer. This Map is not the durable ledger.
      pending = Promise.resolve().then(() => capture(record, captured, mode));
      leases.set(key, pending);
    }
    return pending;
  }

  function capture(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    mode: "prepare" | "recover",
  ): Promise<DockerContainerRuntimeLease> {
    return new Promise<DockerContainerRuntimeLease>((resolve, reject) => {
      const cancellation = new AbortController();
      let active = false,
        finished = false,
        called = false,
        ready = false;
      let finish: () => void = () => undefined;
      const done = new Promise<void>((release) => {
        finish = release;
      });
      const terminate = () => {
        cancellation.abort();
        finish();
      };
      const failed = () => {
        terminate();
        if (!ready) reject(new Error("docker_physical_preparation_unavailable"));
      };
      const completion: Promise<void> = owner
        .withAuthority(record, mode === "prepare" ? "reconcile" : "observe", async (held) => {
          if (finished || called) return fail();
          called = true;
          active = true;
          const revoked = held.revocation;
          const current = held.stillCurrent.bind(held);
          const guard = async () => {
            if (
              !active ||
              finished ||
              cancellation.signal.aborted ||
              revoked.aborted ||
              (await current()) !== true ||
              !active ||
              finished ||
              revoked.aborted
            )
              return fail();
            const saved = await owner.read(record.intent);
            if (canonicalJson(saved) !== canonicalJson(record)) return fail();
            await owner.assertNetworkAllocation(record, native, policy);
            const stillHeld = await current();
            if (!active || finished || cancellation.signal.aborted || revoked.aborted || !stillHeld)
              return fail();
          };
          revoked.addEventListener("abort", terminate, { once: true });
          if (revoked.aborted) terminate();
          let process: Awaited<ReturnType<typeof openDockerPhysicalProcess>> | undefined;
          try {
            await guard();
            process = await openDockerPhysicalProcess({
              ...selected,
              networkId: native.networkId,
              signal: cancellation.signal,
            });
            void process.closed.then(terminate);
            await guard();
            const metadata = process.metadata;
            if (
              metadata.namespaceInode === metadata.parentInode &&
              metadata.namespaceDevice === metadata.parentDevice
            )
              return fail();
            const original = await readDockerPhysicalBridgeBinding(process, native, policy, host);
            const bridge = original.bridge;
            const binding = canonicalJson(original);
            const plan = compileLinuxContainerEgress({
              namespace: {
                parent: `net:[${String(metadata.parentInode)}]`,
                selected: `net:[${String(metadata.namespaceInode)}]`,
              },
              table: selected.table,
              killSwitch: true,
              hostHttp: [bridge],
              tenants: [
                {
                  authority: policy,
                  interfaces: [bridge.bridge],
                  maxConnections,
                  packetLimitBytes,
                },
              ],
            });
            const physical = process;
            const nativePort = process.port(plan);
            const port = {
              async namespace() {
                await guard();
                const selectedNamespace = await nativePort.namespace();
                await guard();
                return selectedNamespace;
              },
              async execute(command: Parameters<typeof nativePort.execute>[0]) {
                const tableRead =
                  command.argv.length === 6 &&
                  command.argv[0] === "nft" &&
                  command.argv[1] === "-j" &&
                  command.argv[2] === "list" &&
                  command.argv[3] === "table" &&
                  ((command.argv[4] === "inet" && command.argv[5] === plan.table) ||
                    (command.argv[4] === "bridge" && command.argv[5] === plan.bridgeRules?.table));
                if (tableRead) await physicalGuard();
                else await guard();
                const output = await nativePort.execute(command);
                if (tableRead) {
                  await physicalGuard();
                  return JSON.stringify(
                    normalizeLinuxContainerEgressInterfaceReadback(JSON.parse(output), [
                      original.bridge,
                    ]),
                  );
                }
                await guard();
                return output;
              },
            };
            const physicalGuard = async () => {
              await guard();
              if (
                canonicalJson(
                  await readDockerPhysicalBridgeBinding(physical, native, policy, host),
                ) !== binding
              )
                return fail();
              await guard();
            };
            await physicalGuard();
            const initial =
              mode === "prepare"
                ? await applyLinuxContainerEgress(plan, port)
                : await readLinuxContainerEgress(plan, port);
            await physicalGuard();
            const readback = async () => {
              await physicalGuard();
              const observed = await readLinuxContainerEgress(plan, port, initial.structuralDigest);
              await physicalGuard();
              return {
                native,
                policy,
                installed: true,
                topology: {
                  networkId: native.networkId,
                  rulesetDigest: observed.structuralDigest,
                  meterId: "linux-packet-counter-unqualified",
                },
                coverage: {
                  ipv4: false,
                  ipv6: false,
                  tcp: false,
                  udp: false,
                  hostInput: false,
                  forwardedTraffic: false,
                  tenantIsolation: false,
                  privateAddressDeny: false,
                  metadataDeny: false,
                  tcp25Deny: false,
                  connectionLimit: false,
                  bandwidthLimit: false,
                  rawEgressMeter: false,
                  killSwitch: false,
                  denyAllOutbound: true,
                  publicInternet: false,
                },
              };
            };
            ready = true;
            resolve(
              Object.freeze({
                revocation: cancellation.signal,
                async stillCurrent() {
                  try {
                    await physicalGuard();
                    return true;
                  } catch {
                    terminate();
                    await completion;
                    return false;
                  }
                },
                async readback() {
                  try {
                    const partial = await readback();
                    // This producer is still quarantine-only. Join its actual
                    // callback/helper before the generic matcher refuses the
                    // unchanged fourteen-false receipt; retain the attempt key.
                    terminate();
                    await completion;
                    return partial;
                  } catch {
                    terminate();
                    await completion;
                    return fail();
                  }
                },
                async claimStart(
                  identity: DockerContainerNativeIdentity,
                  actualPolicy: DockerContainerRuntimePolicy,
                ) {
                  try {
                    if (
                      canonicalJson(identity) !== canonicalJson(native) ||
                      canonicalJson(actualPolicy) !== canonicalJson(policy)
                    )
                      return fail();
                    await physicalGuard();
                    const claimed = await owner.claimStart(native, policy);
                    await physicalGuard();
                    return claimed;
                  } catch {
                    terminate();
                    await completion;
                    return fail();
                  }
                },
              }),
            );
            // The actual owner callback remains OPEN for the native session. Its
            // completion/revocation invalidates all captured uses, never a loan
            // returned after callback completion. No secret map is borrowed.
            await done;
          } finally {
            active = false;
            terminate();
            await process?.close();
            revoked.removeEventListener("abort", terminate);
          }
        })
        .then(failed, failed)
        .finally(() => {
          finished = true;
          terminate();
        });
    });
  }
  return createDockerContainerRuntimePreparation({
    policy,
    requiredSecretNames: names,
    createCustody: custody,
    readStartClaim: owner.readStartClaim,
    prepare: (native) => open(native, "prepare"),
    recover: (native) => open(native, "recover"),
  });
}
