import type { JsonObject } from "../../src/ports.ts";
import { createDockerContainerCreateCustody } from "../../src/providers/docker-container-create-custody.ts";
import { createDockerContainerRuntimePreparation } from "../../src/providers/docker-container-runtime-preparation.ts";
import { createDockerHttpRevisionRuntime } from "../../src/providers/docker-http-revision.ts";
import { V2_CONTAINER_F2_FORM } from "../../src/takoform-v2/container-owner-schema.ts";
import {
  containerSpec,
  PRINCIPAL,
  revision,
  SPACE,
} from "./docker-container-configured-source-selection.ts";
import { deleteLifecycleFixture } from "./docker-container-owner-delete-lifecycle.ts";

/**
 * Fixture for the remove-phase observation of a start attempt that was never confirmed.
 *
 * A start attempt stays pending when the object was started but never reported ready (serving
 * is never published) or when the START outcome stayed unknown. At removal the custody inspects
 * the exact bound native ID under the held remove authority; a fresh positive Running=true is a
 * fact of its own, recorded by the owner as the schema's pending -> running (never serving)
 * before the stop, so that the observed-stop exit has a confirmed run to end.
 *
 * It sits on top of deleteLifecycleFixture (unchanged): the same real Core engine, real Docker
 * Core owner, production create-custody and DockerHTTP revision runtime over the same explicit
 * Docker Engine double. There is NO product-side shortcut here: no SQL write to owner state, no
 * currentness override and no minted authority (waitForRetry only reschedules the Core
 * Operation, it changes no owner row). This file adds only:
 * - an observation seam BELOW the helper's engine wrapper: every exact-native-ID inspect (GET
 *   /containers/<64 hex>/json, never a name lookup) is recorded with its State.Running, and the
 *   rows around the owner's confirmRunning are compared at the moment the custody sends the stop;
 * - test-side faults of the daemon double: a refused START (the object is created and the START
 *   is claimed, but it never runs), a refused first readback (the START is never claimed), a stop
 *   that ends in 404 or a timeout;
 * - inDeleteExecution: runs a callback inside a REAL execution of the accepted DELETE, so that
 *   the owner's own API can be called under a lawful held remove authority (or deliberately
 *   without one);
 * - the original diagnostic control of the contract probe (a SQL write standing in for the
 *   missing owner method) is NOT here; it is kept, immutable, in the operator package of that
 *   probe.
 */

export const NAMES = ["OTHER", "SECRET"];

type Base = Awaited<ReturnType<typeof deleteLifecycleFixture>>;
type Lifecycle = NonNullable<Parameters<typeof deleteLifecycleFixture>[0]>;

/** The retained claim of generation 1 as the owner itself reports it, in a real execution. */
export interface OwnerScope {
  readonly owner: Base["fx"]["owner"]["owner"];
  readonly record: Awaited<
    ReturnType<Base["fx"]["owner"]["readAcceptedExecution"]>
  >["retained"][number]["record"];
  readonly claimedAtMs: number | null;
  /**
   * A well-formed 12-key native identity built from the owner's own stored intent and claim. The
   * owner compares the native ID and the intent's identity; network, networkId, image and imageId
   * are invented here and only format-checked by the owner (it cannot see Docker).
   */
  native(overrides?: Record<string, unknown>): Record<string, unknown>;
  /**
   * Removes this claim's object through the production runtime and custody over the real owner,
   * with the removal's cancellation signal aborted just after the owner call that recorded the
   * running returned (before the stop). Returns the removal's failure.
   */
  removeCancelledAfterConfirmRunning(): Promise<unknown>;
  /** Runs work under the owner's own held REMOVE authority for this claim. */
  held<T>(work: () => Promise<T>): Promise<T>;
}

export async function pendingStartFixture(options?: {
  /** The daemon refuses every START: the object is created and claimed but never runs. */
  readonly startRefused?: boolean;
  /** The daemon refuses the first readback by exact ID after the CREATE: no START is claimed. */
  readonly neverStarted?: boolean;
  /** Passed to the delete lifecycle fixture (fault injection of its own). */
  readonly lifecycle?: Lifecycle;
}) {
  const ctx = await deleteLifecycleFixture(options?.lifecycle);
  const { fx, seam } = ctx;
  const upstream = ctx.docker.engine;
  /** Every exact-native-ID inspect, in order, with the State.Running the daemon reported. */
  const observed: { id: string; running: boolean }[] = [];
  const evidence: {
    /** At the moment the custody sent the stop of an exact ID, compared with its first Running=true inspect. */
    atStop?: {
      attemptBefore: string | null;
      attemptAtStop: string | null;
      othersUnchanged: boolean;
    };
    grants?: Record<string, string>;
  } = {};
  let stopFault: "not-found" | "timeout" | undefined;
  let created = false;
  let readbackRefused = false;
  const firstRunning = new Map<string, { attempt: string | null; others: string }>();

  const othersSnapshot = () =>
    JSON.stringify(
      [
        "tf_v2_container_instances",
        "tf_v2_container_revisions",
        "tf_v2_container_acceptances",
        "tf_v2_container_create_claims",
      ].map((table) => fx.database.query(`SELECT * FROM ${table}`).all()),
    );
  const attemptStateOf = (id: string) =>
    (
      fx.database
        .query("SELECT state FROM tf_v2_container_start_attempts WHERE native_id = ?")
        .get(id) as { state: string } | null
    )?.state ?? null;

  const drop = (id: string) => {
    for (const [name, container] of ctx.docker.containers)
      if (container.Id === id) ctx.docker.containers.delete(name);
  };

  ctx.docker.engine = async (method, path, body, signal) => {
    const route = path.split("?")[0] ?? "";
    const id = /^\/containers\/([a-f0-9]{64})\//u.exec(route)?.[1];
    if (options?.startRefused && method === "POST" && route.endsWith("/start")) {
      seam.add({ phase: "control.startRefusedByTest", ok: true, native: id?.slice(-8) ?? null });
      return { status: 500, body: "" };
    }
    if (
      options?.neverStarted &&
      created &&
      !readbackRefused &&
      method === "GET" &&
      route.endsWith("/json") &&
      id
    ) {
      readbackRefused = true;
      seam.add({ phase: "control.readbackRefusedByTest", ok: true, native: id.slice(-8) });
      return { status: 500, body: "" };
    }
    if (method === "POST" && route.endsWith("/stop") && id) {
      const first = firstRunning.get(id);
      evidence.atStop = {
        attemptBefore: first?.attempt ?? null,
        attemptAtStop: attemptStateOf(id),
        othersUnchanged: first !== undefined && first.others === othersSnapshot(),
      };
      if (stopFault === "timeout") throw new Error("synthetic stop timeout");
      if (stopFault === "not-found") {
        drop(id);
        return { status: 404, body: "" };
      }
    }
    const response = await upstream(method, path, body, signal);
    if (method === "POST" && route.startsWith("/containers/create")) created = true;
    if (method === "GET" && route.endsWith("/json") && id && response.status === 200) {
      const state = (JSON.parse(response.body) as { State?: { Running?: unknown } }).State;
      const running = state?.Running === true;
      observed.push({ id, running });
      if (running && !firstRunning.has(id))
        firstRunning.set(id, { attempt: attemptStateOf(id), others: othersSnapshot() });
      seam.add({
        phase: "observation.exactID",
        ok: true,
        native: id.slice(-8),
        state: running ? "Running=true" : "Running=false",
      });
    }
    return response;
  };

  /** The next stop of an exact native ID ends in 404 (the object is gone) or a timeout. */
  const armStopFault = (kind: "not-found" | "timeout") => {
    stopFault = kind;
  };

  const scopeOf = (
    item: Awaited<ReturnType<Base["fx"]["owner"]["readAcceptedExecution"]>>["retained"][number],
    accepted?: Awaited<ReturnType<Base["fx"]["owner"]["readAcceptedExecution"]>>,
  ): OwnerScope => {
    const { record } = item;
    const intent = record.intent;
    return {
      owner: fx.owner.owner,
      record,
      claimedAtMs:
        (
          fx.database
            .query("SELECT claimed_at_ms AS claimed FROM tf_v2_container_start_attempts")
            .get() as { claimed: number } | null
        )?.claimed ?? null,
      native: (overrides = {}) => ({
        backend: "docker",
        installationId: intent.installationId,
        resourceUid: intent.resourceUid,
        incarnationId: intent.incarnationId,
        revision: intent.revision,
        nativeId: record.nativeId as string,
        network: "synthetic-docker-network",
        networkId: "b".repeat(64),
        image: `registry.example/app@sha256:${"1".repeat(64)}`,
        imageId: `sha256:${"1".repeat(64)}`,
        identityLabel: intent.identityLabel,
        revisionLabel: intent.revisionLabel,
        ...overrides,
      }),
      held: (work) => fx.owner.owner.withAuthority(record, "remove", async () => work()),
      removeCancelledAfterConfirmRunning: async () => {
        if (!accepted) throw new Error("only available inside a DELETE execution");
        const real = fx.owner.owner;
        const abort = new AbortController();
        const policy = intent.policy;
        const names = intent.requiredSecretNames;
        const custody = createDockerContainerCreateCustody({
          policy,
          requiredSecretNames: names,
          // Not wrapped by the observed port: its extra promise hops would let the cancellation
          // win the race inside the custody's own abortable() instead of reaching its guard.
          owner: {
            ...real,
            confirmRunning: async (target, observation) => {
              await real.confirmRunning(target, observation);
              seam.add({
                phase: "owner.confirmRunning",
                ok: true,
                generation: target.intent.policy.generation,
              });
              // The cancellation reaches the removal just AFTER the owner call returned (a
              // microtask later), so it can only be caught by the guard that follows the call.
              queueMicrotask(() => abort.abort());
            },
          },
        });
        const runtime = createDockerHttpRevisionRuntime({
          socketPath: "/var/run/docker.sock",
          installationId: intent.installationId,
          network: "synthetic-docker-network",
          maxMemoryBytes: 1024 * 1024 * 1024,
          maxNanoCpus: 2_000_000_000,
          pidsLimit: 128,
          engine: seam.engine(ctx.docker.engine),
          healthFetch: async () => new Response("ok"),
          runtimePreparation: createDockerContainerRuntimePreparation({
            policy,
            createCustody: custody,
            requiredSecretNames: names,
            readStartClaim: (native, claimPolicy) => real.readStartClaim(native, claimPolicy),
            // Remove never prepares or recovers enforcement.
            prepare: async () => null,
            recover: async () => null,
          }),
        });
        const spec = item.spec;
        try {
          await runtime.remove(
            {
              resourceUid: accepted.resourceUid,
              incarnationId: accepted.incarnationId,
              revision: intent.revision,
              image: String(spec.image),
              port: Number(spec.httpPort),
              healthPath: String(spec.healthPath),
              memoryBytes: 256 * 1024 * 1024,
              nanoCpus: 500_000_000,
              environment: spec.environment as JsonObject as Record<string, string>,
            },
            record.nativeId ?? undefined,
            abort.signal,
          );
          return undefined;
        } catch (error) {
          return error;
        }
      },
    };
  };

  /**
   * A CREATE that the backend settles as failed. With the default spec the container is started
   * and its health path never answers, so the object is physically running while its start
   * attempt stays pending and serving is never published. With startRefused it never runs; with
   * neverStarted no START is ever claimed.
   * After the failed run, inside a real execution of the same Operation, the owner is asked for
   * an observe and a remove authority on the failed (not deleted) generation, and duringCreate
   * may run more calls under a lawful observe authority.
   */
  async function createFailedResource(
    name: string,
    duringCreate?: (scope: OwnerScope) => Promise<void>,
  ) {
    fx.dispatch(async (input) => {
      const result = await ctx.dispatch(input);
      if (input.action !== "create" || result.kind !== "unknown") return result;
      await fx.owner.withExecution(input, async () => {
        const accepted = await fx.owner.readAcceptedExecution(input);
        const item = accepted.retained.find((entry) => entry.record.intent.policy.generation === 1);
        const grants: Record<string, string> = {};
        for (const phase of ["observe", "remove"] as const) {
          try {
            if (!item) throw new Error("no retained claim");
            await fx.owner.owner.withAuthority(item.record, phase, async () => undefined);
            grants[phase] = "granted";
          } catch (error) {
            grants[phase] = `refused:${error instanceof Error ? error.message : String(error)}`;
          }
        }
        evidence.grants = grants;
        if (duringCreate && item) await duringCreate(scopeOf(item));
      });
      return {
        kind: "no_effect" as const,
        code: "health_never_passed",
        message: "the CREATE did not become ready",
      };
    });
    const accepted = await fx.engine.acceptCreate({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: SPACE,
        name,
        spec: { ...containerSpec(revision("1"), NAMES), healthPath: "/unhealthy" },
        privateInputs: { OTHER: "o-A", SECRET: "s-A" },
      },
    });
    await fx.engine.runNext();
    return accepted;
  }

  /** A CREATE that becomes ready and is served: its start attempt is `running` (publishServing). */
  async function createServedResource(name: string) {
    fx.dispatch(ctx.dispatch);
    const accepted = await fx.create(name, { OTHER: "o-A", SECRET: "s-A" }, NAMES);
    await fx.engine.runNext();
    return accepted;
  }

  async function acceptDelete(uid: string, expectedGeneration = 1) {
    seam.log.length = 0;
    // The rows are compared from the first Running=true inspect of the REMOVE phase on.
    firstRunning.clear();
    return fx.engine.acceptDelete({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      uid,
      expectedGeneration,
    });
  }

  async function runDeleteOnce() {
    const result = await fx.engine.runNext();
    seam.add({
      phase: "engine.completion",
      ok: result?.status === "succeeded",
      state: `${result?.status}/${result?.effect}${result?.error ? `/${result.error.code}` : ""}`,
    });
    // DL_LOG=1 prints the raw fixed-field log, timestamps included, for evidence runs.
    if (process.env.DL_LOG)
      for (const entry of seam.log) console.error("OBS", JSON.stringify(entry));
    return result;
  }

  /**
   * Accepts the DELETE and, inside a REAL execution of it (owner.withExecution over the engine's
   * own execution object), runs work with the owner's own retained claim of generation 1. The
   * backend then reports an unknown outcome, so nothing is completed by this call.
   */
  async function inDeleteExecution<T>(
    uid: string,
    work: (scope: OwnerScope) => Promise<T>,
    expectedGeneration = 1,
  ): Promise<T> {
    let outcome: { value: T } | { error: unknown } | undefined;
    fx.dispatch(async (input) => {
      if (input.action !== "delete") return ctx.dispatch(input);
      return fx.owner.withExecution(input, async () => {
        const accepted = await fx.owner.readAcceptedExecution(input);
        const item = accepted.retained.find((entry) => entry.record.intent.policy.generation === 1);
        try {
          if (!item) throw new Error("no retained claim");
          outcome = { value: await work(scopeOf(item, accepted)) };
        } catch (error) {
          outcome = { error };
        }
        return { kind: "unknown" as const };
      });
    });
    await acceptDelete(uid, expectedGeneration);
    await runDeleteOnce();
    if (!outcome) throw new Error("the DELETE execution never ran the callback");
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  /** Time passes (test-side): the engine re-dispatches a reconciling Operation at its retry time. */
  const waitForRetry = (operationId: string) =>
    fx.database
      .query("UPDATE tf_v2_operations SET next_attempt_at_ms = 0 WHERE id = ?")
      .run(operationId);

  const attemptRows = () =>
    fx.database
      .query(
        "SELECT generation, state, claimed_at_ms AS claimed, confirmed_running_at_ms AS running, confirmed_exited_at_ms AS exited FROM tf_v2_container_start_attempts ORDER BY generation, attempt",
      )
      .all() as {
      generation: number;
      state: string;
      claimed: number;
      running: number | null;
      exited: number | null;
    }[];

  const instance = () =>
    fx.database
      .query(
        "SELECT desired_generation AS desired, serving_generation AS serving, retired_at_ms IS NOT NULL AS retired FROM tf_v2_container_instances",
      )
      .get() as { desired: number; serving: number | null; retired: number } | null;

  const retention = () =>
    (
      fx.database
        .query("SELECT retention FROM tf_v2_container_revisions ORDER BY generation")
        .all() as { retention: string }[]
    ).map((row) => row.retention);

  const claims = () =>
    fx.database
      .query("SELECT generation, state FROM tf_v2_container_create_claims ORDER BY generation")
      .all();

  const resource = () =>
    fx.database
      .query(
        "SELECT phase, deleted_at IS NOT NULL AS deleted, busy_operation IS NOT NULL AS busy FROM tf_v2_resources",
      )
      .all();

  /** State.Running of every object the daemon double holds. */
  const containerStates = () =>
    [...ctx.docker.containers.values()].map(
      (container) => (container.State as { Running?: boolean } | undefined)?.Running,
    );

  /** Test-side: the daemon double reports Running=true again (an external restart; no START is sent). */
  const restartExternally = () => {
    for (const [name, container] of ctx.docker.containers)
      ctx.docker.containers.set(name, { ...container, State: { Running: true } });
  };

  /** Test-side: the process exits on its own (Running=false). */
  const exitExternally = () => {
    for (const [name, container] of ctx.docker.containers)
      ctx.docker.containers.set(name, { ...container, State: { Running: false } });
  };

  return {
    ...(ctx as Base),
    observed,
    evidence,
    armStopFault,
    createFailedResource,
    createServedResource,
    acceptDelete,
    runDeleteOnce,
    inDeleteExecution,
    waitForRetry,
    attemptRows,
    instance,
    retention,
    claims,
    resource,
    containerStates,
    restartExternally,
    exitExternally,
    dropContainer: (id: string) => drop(id),
    nativeEffects: () => ({
      creates: ctx.docker.creates().length,
      starts: ctx.docker.starts().length,
    }),
  };
}
