import type { JsonObject } from "../../src/ports.ts";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateOwnerPort,
  type DockerContainerCreateRecord,
} from "../../src/providers/docker-container-create-custody.ts";
import { createDockerContainerRuntimePreparation } from "../../src/providers/docker-container-runtime-preparation.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevisionOptions,
} from "../../src/providers/docker-http-revision.ts";
import {
  type LinuxDockerPhysicalOwnerPort,
  LinuxDockerRuntimePreparation,
} from "../../src/providers/linux-docker-runtime-preparation.ts";
import type { V2BackendResult, V2Execution } from "../../src/takoform-v2/types.ts";
import { dockerOwnerFixture } from "./docker-container-configured-owner-snapshot.ts";
import { SOURCE_SELECTION } from "./docker-container-configured-source-selection.ts";

/**
 * A DELETE lifecycle fixture on top of dockerOwnerFixture (unchanged): the same real Core
 * engine, real Docker Core owner, production create-custody and DockerHTTP revision runtime,
 * and the same Docker Engine / health / physical-readback doubles. Substrate: see the header
 * of docker-container-configured-owner-snapshot.ts.
 *
 * Observation only. Two pass-through seams record fixed-field phases and reasons and never
 * change a result, an error or an object identity:
 * - the owner port the custody calls (read, claim, withAuthority, bindNative, confirmStopped,
 *   confirmRemoved) is wrapped; the real held authority is handed on untouched, errors are rethrown as they
 *   are, and a failure records the error name, its message and the function names of its
 *   first frames;
 * - the Docker Engine double is wrapped to record method, path (without query or body, so no
 *   map is ever recorded) and status.
 * Identities are shown as short prefixes of the claim id and native id; no secret value is
 * recorded.
 */

export interface Observation {
  readonly seq: number;
  readonly atMs: number;
  readonly phase: string;
  readonly ok: boolean;
  readonly generation?: number;
  readonly claim?: string;
  readonly native?: string | null;
  readonly state?: string;
  readonly authorityPhase?: string;
  readonly status?: number;
  readonly path?: string;
  /** Short prefixes only: no map, no token. */
  readonly identity?: {
    readonly form: string;
    readonly action: string;
    readonly operation: string | null;
    readonly resource: string | null;
    readonly birth: string | null;
    readonly leaseMsRemaining: number | null;
  };
  readonly thrown?: {
    readonly name: string;
    readonly message: string;
    readonly frames: readonly string[];
  };
}

const short = (value: string | null | undefined) =>
  typeof value === "string" ? value.slice(0, 8) : (value ?? null);
/** Native ids of the Docker double are zero-padded on the left, so their tail tells them apart. */
const tail = (value: string | null | undefined) =>
  typeof value === "string" ? value.slice(-8) : (value ?? null);

function frames(stack: string | undefined): readonly string[] {
  return [...(stack ?? "").matchAll(/^\s+at (?:async )?([\w$.]+) \(/gmu)]
    .slice(0, 5)
    .map((match) => match[1] ?? "");
}

function thrown(error: unknown): NonNullable<Observation["thrown"]> {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    frames: frames(error instanceof Error ? error.stack : undefined),
  };
}

export function observer() {
  const log: Observation[] = [];
  const start = Date.now();
  const add = (entry: Omit<Observation, "seq" | "atMs">) => {
    log.push({ seq: log.length + 1, atMs: Date.now() - start, ...entry });
  };
  const recordFields = (record: DockerContainerCreateRecord) => ({
    generation: record.intent.policy.generation,
    claim: short(record.claimId) as string,
    native: tail(record.nativeId),
    state: record.state,
  });
  /** Wraps the owner port; behaviour is identical, only phases and failures are recorded. */
  function port(source: DockerContainerCreateOwnerPort): DockerContainerCreateOwnerPort {
    return {
      read: async (intent) => {
        try {
          const record = await source.read(intent);
          add({
            phase: "owner.read",
            ok: true,
            ...(record
              ? recordFields(record)
              : { generation: intent.policy.generation, state: "none" }),
          });
          return record;
        } catch (error) {
          add({
            phase: "owner.read",
            ok: false,
            generation: intent.policy.generation,
            thrown: thrown(error),
          });
          throw error;
        }
      },
      claim: async (intent) => {
        try {
          const claimed = await source.claim(intent);
          add({
            phase: `owner.claim:${claimed.status}`,
            ok: true,
            ...recordFields(claimed.record),
          });
          return claimed;
        } catch (error) {
          add({
            phase: "owner.claim",
            ok: false,
            generation: intent.policy.generation,
            thrown: thrown(error),
          });
          throw error;
        }
      },
      withAuthority: async (record, authorityPhase, use) => {
        let granted = false;
        let usedAndThrew = false;
        try {
          const result = await source.withAuthority(record, authorityPhase, async (held) => {
            granted = true;
            add({
              phase: "owner.withAuthority:granted",
              ok: true,
              authorityPhase,
              ...recordFields(record),
            });
            try {
              return await use(held);
            } catch (error) {
              usedAndThrew = true;
              add({
                phase: "custody.use",
                ok: false,
                authorityPhase,
                ...recordFields(record),
                thrown: thrown(error),
              });
              throw error;
            }
          });
          add({
            phase: "owner.withAuthority:released",
            ok: true,
            authorityPhase,
            ...recordFields(record),
          });
          return result;
        } catch (error) {
          if (!granted)
            add({
              phase: "owner.withAuthority:refused",
              ok: false,
              authorityPhase,
              ...recordFields(record),
              thrown: thrown(error),
            });
          else if (!usedAndThrew)
            add({
              phase: "owner.withAuthority:failed-after-use",
              ok: false,
              authorityPhase,
              ...recordFields(record),
              thrown: thrown(error),
            });
          throw error;
        }
      },
      bindNative: async (record, nativeId) => {
        try {
          await source.bindNative(record, nativeId);
          add({ phase: "owner.bindNative", ok: true, ...recordFields(record) });
        } catch (error) {
          add({
            phase: "owner.bindNative",
            ok: false,
            ...recordFields(record),
            thrown: thrown(error),
          });
          throw error;
        }
      },
      confirmRunning: async (record, observation) => {
        try {
          await source.confirmRunning(record, observation);
          add({ phase: "owner.confirmRunning", ok: true, ...recordFields(record) });
        } catch (error) {
          add({
            phase: "owner.confirmRunning",
            ok: false,
            ...recordFields(record),
            thrown: thrown(error),
          });
          throw error;
        }
      },
      confirmStopped: async (record, observation) => {
        try {
          await source.confirmStopped(record, observation);
          add({ phase: "owner.confirmStopped", ok: true, ...recordFields(record) });
        } catch (error) {
          add({
            phase: "owner.confirmStopped",
            ok: false,
            ...recordFields(record),
            thrown: thrown(error),
          });
          throw error;
        }
      },
      confirmRemoved: async (record, nativeId) => {
        try {
          await source.confirmRemoved(record, nativeId);
          add({ phase: "owner.confirmRemoved", ok: true, ...recordFields(record) });
        } catch (error) {
          add({
            phase: "owner.confirmRemoved",
            ok: false,
            ...recordFields(record),
            thrown: thrown(error),
          });
          throw error;
        }
      },
    };
  }
  /** attempts, when given, is read at each native DELETE: the durable start-attempt state at that moment. */
  function engine(
    source: NonNullable<DockerHttpRevisionOptions["engine"]>,
    attempts?: () => string,
  ): NonNullable<DockerHttpRevisionOptions["engine"]> {
    return async (method, path, body, signal) => {
      const response = await source(method, path, body, signal);
      add({
        phase: `engine.${method}`,
        ok: response.status < 400 || response.status === 404,
        ...(method === "DELETE" && attempts ? { state: attempts() } : {}),
        path: (path.split("?")[0] ?? "").replace(/[a-f0-9]{64}/gu, (id) => id.slice(-8)),
        status: response.status,
      });
      return response;
    };
  }
  return { log, add, port, engine };
}

/** Everything the DELETE backend needs, built over the unchanged dockerOwnerFixture. */
export async function deleteLifecycleFixture(options?: {
  /**
   * CONTROL, test-side only. Replaces the owner's confirmStopped by a no-op for the listed
   * generations, so the custody still observes the stopped object and deletes it but the exit
   * is never recorded. It separates "the exit record is what lets the removal complete" from
   * the independent confirmRemoved fence. No success case uses it.
   */
  readonly skipExitRecordingFor?: readonly number[];
  /**
   * NEGATIVE, test-side only. The caller lies: the observation the custody made is replaced
   * by this value before it reaches the REAL owner, under the real held remove authority.
   */
  readonly forgeObservation?: (observation: { native: unknown; state: unknown }) => unknown;
  /** Calls the real owner's confirmStopped twice with the same observation (idempotency). */
  readonly repeatConfirmStopped?: boolean;
  /**
   * CONTROL, test-side only. The Docker double acknowledges the stop (204) but leaves the object
   * running. The custody must then neither record an exit nor delete. No success case uses it.
   */
  readonly stopLeavesRunning?: boolean;
  /**
   * FAULT, test-side only, once per fixture. "ack-lost": the daemon performs the first DELETE but
   * the caller never sees the ACK. "refused": the first DELETE never reaches the daemon.
   */
  readonly deleteFault?: "ack-lost" | "refused";
  /** FAULT, test-side only. The removal's cancellation signal is aborted right after the stop. */
  readonly abortAfterStop?: boolean;
  /**
   * FAULT, test-side only. The stop of the first generation does not give a positive stopped
   * observation: "not-found" (404, the object is gone), "timeout" (the request throws) or
   * "vanishes" (the daemon stops it, then it is removed outside this system).
   */
  readonly stopFault?: "not-found" | "timeout" | "vanishes";
  /** FAULT, test-side only, once per fixture. The removal's cancellation signal is aborted right after the owner recorded the exit. */
  readonly abortAfterExit?: boolean;
  /**
   * Takes the custody from a LinuxDockerRuntimePreparation built over the (observed) real owner
   * instead of building it directly, so the Linux wrapper's own owner forwarding is exercised.
   * Only its constructor and custody are used; no native helper process is opened.
   */
  readonly custody?: "linux";
}) {
  const ctx = await dockerOwnerFixture();
  const seam = observer();
  let deleteFaulted = false;
  let exitAborted = false;
  const outcome: { removed: number[]; failure?: Observation["thrown"] & { generation: number } } = {
    removed: [],
  };
  /** The intents of the retained records seen by the DELETE (used by the evidence probe readRetained). */
  const retainedIntents: DockerContainerCreateRecord["intent"][] = [];
  const leaseMsRemaining = (operationId: string): number | null => {
    const row = ctx.fx.database
      .query("SELECT lease_until_ms AS until FROM tf_v2_operations WHERE id = ?")
      .get(operationId) as { until: number | null } | null;
    return row?.until == null ? null : row.until - Date.now();
  };
  const startAttempts = () =>
    (
      ctx.fx.database
        .query(
          "SELECT generation, attempt, state, confirmed_running_at_ms AS running, confirmed_exited_at_ms AS exited FROM tf_v2_container_start_attempts ORDER BY generation, attempt",
        )
        .all() as {
        generation: number;
        attempt: number;
        state: string;
        running: number | null;
        exited: number | null;
      }[]
    ).map((row) => `${row.generation}.${row.attempt}:${row.state}`);
  /**
   * Removes one retained generation's native object through the production runtime and custody.
   * Returns false when the removal stopped (the failure is recorded on the seam).
   */
  async function removeGeneration(
    accepted: Awaited<ReturnType<typeof ctx.fx.owner.readAcceptedExecution>>,
    item: Awaited<ReturnType<typeof ctx.fx.owner.readAcceptedExecution>>["retained"][number],
  ): Promise<boolean> {
    retainedIntents.push(item.record.intent);
    const policy = item.record.intent.policy;
    const real = ctx.fx.owner.owner;
    let source: DockerContainerCreateOwnerPort = real;
    if (options?.skipExitRecordingFor?.includes(policy.generation)) {
      source = { ...real, confirmStopped: async () => undefined };
      seam.add({
        phase: "control.exitRecordingSkippedByTest",
        ok: true,
        generation: policy.generation,
      });
    } else if (options?.abortAfterExit) {
      source = {
        ...real,
        confirmStopped: async (record, observation) => {
          await real.confirmStopped(record, observation);
          if (!exitAborted) {
            exitAborted = true;
            abort.abort();
          }
        },
      };
    } else if (options?.forgeObservation || options?.repeatConfirmStopped) {
      const forge = options.forgeObservation;
      source = {
        ...real,
        confirmStopped: async (record, observation) => {
          const sent = (
            forge ? forge(structuredClone(observation)) : observation
          ) as typeof observation;
          await real.confirmStopped(record, sent);
          if (options.repeatConfirmStopped) await real.confirmStopped(record, sent);
        },
      };
    }
    const abort = new AbortController();
    const names = item.record.intent.requiredSecretNames;
    const createCustody =
      options?.custody === "linux"
        ? new LinuxDockerRuntimePreparation({
            policy,
            requiredSecretNames: names,
            owner: { ...real, ...seam.port(source) } as LinuxDockerPhysicalOwnerPort,
            process: {
              helper: "/synthetic/helper",
              socketPath: "/synthetic/helper.sock",
              peerPid: 1,
              peerUid: 0,
              ipBinary: "/synthetic/ip",
              nftBinary: "/synthetic/nft",
              guestNamespaceRoot: "/synthetic/ns",
            },
            host: { tcpPorts: [8080], conntrackMark: 1, deniedDestinations: [] },
            dnsServers: policy.outboundInternet ? ["192.0.2.53"] : [],
            maxConnections: 1,
            packetLimitBytes: 1,
          }).createCustody
        : createDockerContainerCreateCustody({
            policy,
            requiredSecretNames: names,
            owner: seam.port(source),
          });
    const preparation = createDockerContainerRuntimePreparation({
      policy,
      createCustody,
      requiredSecretNames: names,
      readStartClaim: (native, claimPolicy) =>
        ctx.fx.owner.owner.readStartClaim(native, claimPolicy),
      // Remove never prepares or recovers enforcement; a call here would be a wiring error.
      prepare: async () => null,
      recover: async () => null,
    });
    const runtime = createDockerHttpRevisionRuntime({
      socketPath: "/var/run/docker.sock",
      installationId: SOURCE_SELECTION.providerInstallationId,
      network: "synthetic-docker-network",
      maxMemoryBytes: 1024 * 1024 * 1024,
      maxNanoCpus: 2_000_000_000,
      pidsLimit: 128,
      engine: seam.engine(
        async (method, path, body, signal) => {
          const stop = method === "POST" && /\/stop(?:\?|$)/u.test(path);
          if (stop && options?.stopLeavesRunning) return { status: 204, body: "" };
          if (stop && options?.stopFault) {
            const id = /\/containers\/([a-f0-9]{64})\/stop/u.exec(path)?.[1];
            const drop = () => {
              for (const [name, container] of ctx.docker.containers)
                if (container.Id === id) ctx.docker.containers.delete(name);
            };
            seam.add({ phase: `control.stopFault:${options.stopFault}`, ok: true });
            if (options.stopFault === "timeout") throw new Error("synthetic stop timeout");
            if (options.stopFault === "not-found") {
              drop();
              return { status: 404, body: "" };
            }
            const stopped = await ctx.docker.engine(method, path, body, signal);
            drop();
            return stopped;
          }
          if (method === "DELETE" && options?.deleteFault && !deleteFaulted) {
            deleteFaulted = true;
            seam.add({ phase: `control.deleteFault:${options.deleteFault}`, ok: true });
            if (options.deleteFault === "ack-lost")
              await ctx.docker.engine(method, path, body, signal);
            throw new Error("synthetic DELETE fault");
          }
          const response = await ctx.docker.engine(method, path, body, signal);
          if (stop && options?.abortAfterStop) abort.abort();
          return response;
        },
        () => startAttempts().join(","),
      ),
      healthFetch: async () => new Response("ok"),
      runtimePreparation: preparation,
    });
    try {
      await runtime.remove(
        {
          resourceUid: accepted.resourceUid,
          incarnationId: accepted.incarnationId,
          revision: item.record.intent.revision,
          image: String(item.spec.image),
          port: Number(item.spec.httpPort),
          healthPath: String(item.spec.healthPath),
          memoryBytes: 256 * 1024 * 1024,
          nanoCpus: 500_000_000,
          environment: item.spec.environment as JsonObject as Record<string, string>,
        },
        item.record.nativeId ?? undefined,
        options?.abortAfterStop || options?.abortAfterExit ? abort.signal : undefined,
      );
      outcome.removed.push(policy.generation);
      seam.add({ phase: "runtime.remove", ok: true, generation: policy.generation });
    } catch (error) {
      outcome.failure = { ...thrown(error), generation: policy.generation };
      seam.add({
        phase: "runtime.remove",
        ok: false,
        generation: policy.generation,
        thrown: thrown(error),
      });
      return false;
    }
    return true;
  }
  /** DELETE backend: removes every retained generation's native object through the production runtime. */
  const dispatch = async (input: V2Execution): Promise<V2BackendResult> => {
    if (input.action !== "delete") return ctx.dispatch(input);
    return ctx.fx.owner.withExecution(input, async () => {
      const accepted = await ctx.fx.owner.readAcceptedExecution(input);
      seam.add({
        phase: "owner.readAcceptedExecution:delete",
        ok: true,
        generation: accepted.generation,
        state: accepted.retained
          .map((item) => `${item.record.intent.policy.generation}:${item.record.state}`)
          .join(","),
        identity: {
          form: accepted.form,
          action: accepted.action,
          operation: short(accepted.operationId),
          resource: short(accepted.resourceUid),
          birth: short(accepted.incarnationId),
          leaseMsRemaining: leaseMsRemaining(input.operationId),
        },
      });
      seam.add({ phase: "test.startAttempts:before", ok: true, state: startAttempts().join(",") });
      for (const item of [...accepted.retained].sort(
        (a, b) => a.record.intent.policy.generation - b.record.intent.policy.generation,
      )) {
        if (!(await removeGeneration(accepted, item))) return { kind: "unknown" };
      }
      return { kind: "complete", observed: {}, output: {} };
    });
  };
  /**
   * Reads each retained generation through the owner (owner.read -> load -> validate and the
   * configured snapshot) and reports ok or the refusal with the function names of its frames.
   * Meant to run after the DELETE completed, i.e. after the Resource was soft-deleted.
   */
  const readRetained = async () => {
    const results: {
      generation: number;
      ok: boolean;
      state?: string;
      thrown?: NonNullable<Observation["thrown"]>;
    }[] = [];
    for (const intent of retainedIntents) {
      try {
        const record = await ctx.fx.owner.owner.read(intent);
        results.push({
          generation: intent.policy.generation,
          ok: true,
          state: record?.state ?? "none",
        });
      } catch (error) {
        results.push({ generation: intent.policy.generation, ok: false, thrown: thrown(error) });
      }
    }
    return results;
  };
  return {
    ...ctx,
    seam,
    outcome,
    dispatch,
    removeGeneration,
    retainedIntents,
    startAttempts,
    readRetained,
  };
}
