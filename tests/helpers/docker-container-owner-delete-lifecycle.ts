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
 * - the owner port the custody calls (read, claim, withAuthority, bindNative, confirmRemoved)
 *   is wrapped; the real held authority is handed on untouched, errors are rethrown as they
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
  function engine(
    source: NonNullable<DockerHttpRevisionOptions["engine"]>,
  ): NonNullable<DockerHttpRevisionOptions["engine"]> {
    return async (method, path, body, signal) => {
      const response = await source(method, path, body, signal);
      add({
        phase: `engine.${method}`,
        ok: response.status < 400 || response.status === 404,
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
   * CONTROL. The owner has no API that moves a start attempt from running to exited, and the
   * owner schema refuses to mark a claim removed while any of its start attempts is pending or
   * running. For the listed generations the test writes the schema-legal running -> exited
   * transition itself (an equivalent of the exited() helper of the owner-schema tests, without
   * their resource/attempt filter because there is one Resource) BEFORE the native removal.
   * The resulting exited state is therefore temporally false and unreachable by product code;
   * it only separates "the owner cannot record an exit" from probe wiring. Absent, nothing is
   * written: the original flow.
   */
  readonly exitConfirmedFor?: readonly number[];
}) {
  const ctx = await dockerOwnerFixture();
  const seam = observer();
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
    if (options?.exitConfirmedFor?.includes(policy.generation)) {
      const changed = ctx.fx.database
        .query(
          `UPDATE tf_v2_container_start_attempts SET state = 'exited', confirmed_exited_at_ms = MAX(confirmed_running_at_ms, ?)
               WHERE generation = ? AND state = 'running'`,
        )
        .run(Date.now(), policy.generation).changes;
      seam.add({
        phase: "control.exitConfirmedByTest",
        ok: changed === 1,
        generation: policy.generation,
        state: startAttempts().join(","),
      });
    }
    const names = item.record.intent.requiredSecretNames;
    const preparation = createDockerContainerRuntimePreparation({
      policy,
      createCustody: createDockerContainerCreateCustody({
        policy,
        requiredSecretNames: names,
        owner: seam.port(ctx.fx.owner.owner),
      }),
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
      engine: seam.engine(ctx.docker.engine),
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
