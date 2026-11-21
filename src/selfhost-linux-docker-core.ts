import { canonicalDigest, canonicalJson, isJsonObject } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";
import {
  createDockerContainerConfiguredInputs,
  type DockerContainerConfiguredInputs,
} from "./providers/docker-container-configured-inputs.ts";
import type { DockerContainerAcceptedExecution } from "./providers/docker-container-core-owner.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevision,
  type DockerHttpRevisionOptions,
} from "./providers/docker-http-revision.ts";
import {
  createLinuxDockerCoreRuntime,
  type LinuxDockerCorePreparationOptions,
  type LinuxDockerCoreRuntimeOptions,
} from "./providers/linux-docker-core-runtime.ts";
import type { DockerPhysicalGuestDrainPrimitives } from "./providers/linux-docker-physical-session.ts";
import type { LinuxDockerRuntimePreparation } from "./providers/linux-docker-runtime-preparation.ts";
import type { V2HostAcceptance } from "./takoform-v2/host-acceptance.ts";
import type { V2Execution } from "./takoform-v2/types.ts";

/** Operator code selection, separate from the legacy Docker environment opt-in.
 * No owner, accepted execution, policy, custody or readiness is configurable.
 */
export interface SelfhostLinuxDockerCoreSelection {
  readonly installationId: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly configuredInputs: NonNullable<LinuxDockerCoreRuntimeOptions["configuredInputs"]>;
  readonly runtime: Omit<LinuxDockerCorePreparationOptions, "policy" | "requiredSecretNames">;
  readonly docker: Pick<
    DockerHttpRevisionOptions,
    "network" | "maxMemoryBytes" | "maxNanoCpus" | "pidsLimit" | "timeoutMs"
  >;
}

export interface SelfhostLinuxDockerAcceptedRevision {
  readonly accepted: DockerContainerAcceptedExecution;
  readonly runtime: LinuxDockerRuntimePreparation;
  readonly docker: ReturnType<typeof createDockerHttpRevisionRuntime>;
}

export interface SelfhostLinuxDockerCore {
  readonly acceptance: V2HostAcceptance;
  readonly configuredInputs: Pick<
    DockerContainerConfiguredInputs,
    "prepareCreate" | "prepareUpdate"
  >;
  withAcceptedRevision<T>(
    execution: V2Execution,
    work: (revision: SelfhostLinuxDockerAcceptedRevision) => Promise<T>,
  ): Promise<T>;
  /** Remove only original retained generations under their accepted UPDATE/DELETE. */
  retireAccepted(execution: V2Execution, signal?: AbortSignal): Promise<void>;
  /** Observe all original retained generations without granting removal. */
  observeRetainedFlowPrimitives(
    execution: V2Execution,
    signal?: AbortSignal,
  ): Promise<readonly DockerPhysicalGuestDrainPrimitives[]>;
  close(): Promise<void>;
}

export class SelfhostLinuxDockerCoreError extends Error {
  constructor(
    readonly code:
      | "invalid_selection"
      | "closed"
      | "retained_delete_not_composed"
      | "retirement_not_accepted"
      | "retirement_cancelled"
      | "retained_scope_unavailable"
      | "retained_policy_unavailable"
      | "retained_native_identity_unknown",
  ) {
    super(`selfhost_linux_docker_core_${code}`);
    this.name = "SelfhostLinuxDockerCoreError";
  }
}

function dataKeys(input: object, allowed: readonly string[]): void {
  if (
    !input ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
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
    throw new SelfhostLinuxDockerCoreError("invalid_selection");
}

/** Construct after the real Sql, before buildApp. This owns the original
 * acceptance, configured-input hooks and per-accepted-generation runtime graph.
 * It supplies no public Form, usage producer, traffic-drain decision or complete result;
 * those unfinished compositions cannot be replaced by a caller's ready DTO.
 * Construction and the disabled branch perform no native IO.
 */
export function createSelfhostLinuxDockerCore(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxDockerCoreSelection | undefined;
}): SelfhostLinuxDockerCore | undefined {
  const selection = input.selection;
  if (selection === undefined) return undefined;
  dataKeys(selection, [
    "installationId",
    "backendId",
    "targetKey",
    "configuredInputs",
    "runtime",
    "docker",
  ]);
  dataKeys(selection.runtime, [
    "process",
    "host",
    "dnsServers",
    "maxConnections",
    "packetLimitBytes",
  ]);
  dataKeys(selection.runtime.process, [
    "helper",
    "socketPath",
    "peerPid",
    "peerUid",
    "ipBinary",
    "nftBinary",
    "guestNamespaceRoot",
  ]);
  dataKeys(selection.runtime.host, ["tcpPorts", "conntrackMark", "deniedDestinations"]);
  dataKeys(selection.docker, [
    "network",
    "maxMemoryBytes",
    "maxNanoCpus",
    "pidsLimit",
    "timeoutMs",
  ]);
  if (!selection.configuredInputs) throw new SelfhostLinuxDockerCoreError("invalid_selection");
  dataKeys(selection.configuredInputs, ["keyring", "maxSecretBytes"]);
  const { installationId, backendId, targetKey } = selection;
  const runtimeOptions = structuredClone(selection.runtime);
  const dockerOptions = structuredClone(selection.docker);
  const core = createLinuxDockerCoreRuntime({
    sql: input.sql,
    clock: input.clock,
    installationId,
    backendId,
    targetKey,
    configuredInputs: selection.configuredInputs,
  });
  const configured = createDockerContainerConfiguredInputs({
    sql: input.sql,
    selection: { providerInstallationId: installationId, backendId, targetKey },
    owner: core.owner,
    keyring: selection.configuredInputs.keyring,
    maxSecretBytes: selection.configuredInputs.maxSecretBytes,
  });
  const revisions = new Map<string, Omit<SelfhostLinuxDockerAcceptedRevision, "accepted">>();
  // Only an actual original close operation supplies this result. A rebuilt
  // runtime or a removed SQL tombstone cannot join historical helper cleanup.
  const cleanup = new Map<
    string,
    { readonly claimId: string; readonly nativeId: string; readonly closing: Promise<void> }
  >();
  const scopes = new Set<Promise<unknown>>();
  const retainedCancellation = new Set<AbortController>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) throw new SelfhostLinuxDockerCoreError("closed");
  };
  function withRetained<T>(
    execution: V2Execution,
    signal: AbortSignal | undefined,
    work: (
      revision: Omit<SelfhostLinuxDockerAcceptedRevision, "accepted">,
      request: DockerHttpRevision,
      nativeId: string,
      key: string,
      record: DockerContainerAcceptedExecution["retained"][number]["record"],
    ) => Promise<T>,
  ): Promise<T[]> {
    assertOpen();
    const assertRemovalOpen = () => {
      assertOpen();
      if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted))
        throw new SelfhostLinuxDockerCoreError("retirement_cancelled");
    };
    assertRemovalOpen();
    const running = Promise.resolve().then(() => {
      assertRemovalOpen();
      return core.owner.withExecution(execution, async () => {
        const accepted = await core.owner.readAcceptedExecution(execution);
        if (accepted.action !== "update" && accepted.action !== "delete")
          throw new SelfhostLinuxDockerCoreError("retirement_not_accepted");
        const policyDigest = await canonicalDigest({
          installationId,
          backendId,
          targetKey,
          runtimeOptions,
          dockerOptions,
        });
        const retained = accepted.retained.filter(
          ({ record }) => record.intent.policy.generation < accepted.generation,
        );
        // Validate every retained projection before any native IO. Current Host
        // settings cannot reconstruct an older, differently configured owner.
        const requests = retained.map(({ record, spec }) => {
          const { intent } = record;
          if (
            intent.installationId !== installationId ||
            intent.installationId !== accepted.installationId ||
            intent.resourceUid !== accepted.resourceUid ||
            intent.incarnationId !== accepted.incarnationId ||
            intent.policy.tenantRef !== accepted.principal
          )
            throw new SelfhostLinuxDockerCoreError("retained_scope_unavailable");
          if (intent.policy.policyDigest !== policyDigest)
            throw new SelfhostLinuxDockerCoreError("retained_policy_unavailable");
          if (record.state === "pending" || record.nativeId === null)
            throw new SelfhostLinuxDockerCoreError("retained_native_identity_unknown");
          const { image, httpPort, healthPath, environment = {} } = spec;
          if (
            typeof image !== "string" ||
            typeof httpPort !== "number" ||
            typeof healthPath !== "string" ||
            !isJsonObject(environment)
          )
            throw new SelfhostLinuxDockerCoreError("retained_scope_unavailable");
          const publicEnvironment: Record<string, string> = {};
          for (const [name, value] of Object.entries(environment)) {
            if (typeof value !== "string")
              throw new SelfhostLinuxDockerCoreError("retained_scope_unavailable");
            publicEnvironment[name] = value;
          }
          return {
            record,
            nativeId: record.nativeId,
            request: {
              resourceUid: intent.resourceUid,
              incarnationId: intent.incarnationId,
              revision: intent.revision,
              image,
              port: httpPort,
              healthPath,
              environment: publicEnvironment,
              memoryBytes: dockerOptions.maxMemoryBytes,
              nanoCpus: dockerOptions.maxNanoCpus,
            },
          };
        });
        const results: T[] = [];
        for (const { record, nativeId, request } of requests) {
          assertRemovalOpen();
          const { intent } = record;
          const key = canonicalJson([
            intent.resourceUid,
            intent.policy.generation,
            intent.revision,
          ]);
          let revision = revisions.get(key);
          if (!revision) {
            const runtime = core.createRuntime({
              ...runtimeOptions,
              policy: intent.policy,
              requiredSecretNames: intent.requiredSecretNames,
            });
            revision = Object.freeze({
              runtime,
              docker: Object.freeze(
                createDockerHttpRevisionRuntime({
                  ...dockerOptions,
                  installationId,
                  socketPath: runtimeOptions.process.socketPath,
                  dnsServers: runtime.dnsServers,
                  runtimePreparation: runtime,
                }),
              ),
            });
            revisions.set(key, revision);
          }
          // Original custody still decides whether this old generation is
          // actually removable; a current execution is no remove grant.
          results.push(await work(revision, request, nativeId, key, record));
          assertRemovalOpen();
        }
        return results;
      });
    });
    scopes.add(running);
    void running.then(
      () => {
        scopes.delete(running);
      },
      () => {
        scopes.delete(running);
      },
    );
    return running;
  }
  return Object.freeze({
    acceptance: core.owner.acceptance,
    configuredInputs: Object.freeze({
      prepareCreate: configured.prepareCreate,
      prepareUpdate: configured.prepareUpdate,
    }),
    async withAcceptedRevision<T>(
      execution: V2Execution,
      work: (revision: SelfhostLinuxDockerAcceptedRevision) => Promise<T>,
    ): Promise<T> {
      assertOpen();
      // Register before starting the original scope, including its first SQL
      // await. Shutdown must retain the database until all accepted work settles.
      const running = Promise.resolve().then(() => {
        assertOpen();
        return core.owner.withExecution(execution, async () => {
          const accepted = await core.owner.readAcceptedExecution(execution);
          if (accepted.action === "delete")
            throw new SelfhostLinuxDockerCoreError("retained_delete_not_composed");
          const policy = {
            tenantRef: accepted.principal,
            generation: accepted.generation,
            outboundInternet: accepted.outboundInternet,
            policyDigest: await canonicalDigest({
              installationId,
              backendId,
              targetKey,
              runtimeOptions,
              dockerOptions,
            }),
          };
          assertOpen();
          const key = canonicalJson([accepted.resourceUid, accepted.generation, accepted.revision]);
          let revision = revisions.get(key);
          if (!revision) {
            const runtime = core.createRuntime({
              ...runtimeOptions,
              policy,
              requiredSecretNames: accepted.requiredSecretNames,
            });
            revision = Object.freeze({
              runtime,
              docker: Object.freeze(
                createDockerHttpRevisionRuntime({
                  ...dockerOptions,
                  installationId,
                  socketPath: runtimeOptions.process.socketPath,
                  dnsServers: runtime.dnsServers,
                  runtimePreparation: runtime,
                }),
              ),
            });
            revisions.set(key, revision);
          }
          return work(Object.freeze({ accepted, ...revision }));
        });
      });
      scopes.add(running);
      void running.then(
        () => {
          scopes.delete(running);
        },
        () => {
          scopes.delete(running);
        },
      );
      return running;
    },
    async retireAccepted(execution: V2Execution, signal?: AbortSignal): Promise<void> {
      await withRetained(execution, signal, async (revision, request, nativeId, key, record) => {
        let original = cleanup.get(key);
        if (original) {
          if (original.claimId !== record.claimId || original.nativeId !== nativeId)
            throw new SelfhostLinuxDockerCoreError("retained_scope_unavailable");
        } else {
          if (record.state === "removed")
            throw new SelfhostLinuxDockerCoreError("retained_scope_unavailable");
          await revision.docker.remove(request, nativeId, signal);
          // Register this exact original cleanup before it starts. Its pending,
          // failed or successful outcome survives same-creator retries; none is
          // reconstructed from an empty runtime, a marker or a caller result.
          original = Object.freeze({
            claimId: record.claimId,
            nativeId,
            closing: Promise.resolve().then(() => revision.runtime.close()),
          });
          cleanup.set(key, original);
        }
        await original.closing;
        revisions.delete(key);
      });
    },
    observeRetainedFlowPrimitives(
      execution: V2Execution,
      signal?: AbortSignal,
    ): Promise<readonly DockerPhysicalGuestDrainPrimitives[]> {
      assertOpen();
      if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted))
        throw new SelfhostLinuxDockerCoreError("retirement_cancelled");
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      signal?.addEventListener("abort", abort, { once: true });
      retainedCancellation.add(cancellation);
      const running = withRetained(execution, cancellation.signal, (revision, request, nativeId) =>
        revision.docker.observeRetainedFlowPrimitives(request, nativeId, cancellation.signal),
      );
      return running
        .then((observed) => Object.freeze(observed))
        .finally(() => {
          retainedCancellation.delete(cancellation);
          signal?.removeEventListener("abort", abort);
        });
    },
    close(): Promise<void> {
      closed = true;
      for (const cancellation of retainedCancellation) cancellation.abort();
      closing ??= (async () => {
        // Caller outcomes remain with their original promises. A failed scope
        // still has to settle before its runtime or backing Sql can be closed.
        await Promise.allSettled([...scopes]);
        const outcomes = await Promise.allSettled(
          [...revisions.values()].map(({ runtime }) => runtime.close()),
        );
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
      return closing;
    },
  });
}
