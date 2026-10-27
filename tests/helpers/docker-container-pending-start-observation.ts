import { V2_CONTAINER_F2_FORM } from "../../src/takoform-v2/container-owner-schema.ts";
import {
  containerSpec,
  PRINCIPAL,
  revision,
  SPACE,
} from "./docker-container-configured-source-selection.ts";
import { deleteLifecycleFixture } from "./docker-container-owner-delete-lifecycle.ts";

/**
 * Probe fixture: a pending (never-confirmed) start attempt, and the one question of this probe:
 * can a fresh, exact-native-ID, positive Running=true observation made under the held remove
 * authority be recorded as pending -> running (the schema's own transition) WITHOUT publishing
 * serving, so that the already delivered observed-stop exit (stop -> Running=false ->
 * confirmStopped -> DELETE -> confirmRemoved) can then complete?
 *
 * It sits on top of deleteLifecycleFixture (unchanged): the same real Core engine, real Docker
 * Core owner, production create-custody and DockerHTTP revision runtime over the same explicit
 * Docker Engine double. This file adds only:
 * - an observation seam BELOW the helper's engine wrapper: every exact-native-ID inspect (GET
 *   /containers/<64 hex>/json, never a name lookup) is recorded with its State.Running;
 * - a test-only START refusal (the object is created and the START is claimed, but the daemon
 *   refuses the START, so the object never runs);
 * - ONE private diagnostic CONTROL (armRunningRecordingControl). It is test code, not a product
 *   API, not producer authority and not a source fix: the current product has no API that
 *   records pending -> running outside publishServing. When armed, at the moment the custody
 *   sends the stop of an exact native ID it writes that attempt's pending -> running only if
 *   the immediately preceding exact-ID inspect of the same ID returned Running=true (it refuses
 *   to write otherwise, so it can never invent a running state for a stopped or absent object).
 *   It writes nothing else, never touches the instance, serving generation or retention, and
 *   lacks the owner's accepted-state fence and lease checks, which a real API would carry.
 *   The stop, the second inspect, confirmStopped, the DELETE and confirmRemoved that follow are
 *   the unchanged production flow.
 */

export const NAMES = ["OTHER", "SECRET"];

type Base = Awaited<ReturnType<typeof deleteLifecycleFixture>>;

export interface ControlEvidence {
  /** Rows changed by the control's UPDATE (1 when it recorded pending -> running). */
  readonly changes: number;
  readonly claimedAtMs: number;
  readonly runningAtMs: number;
  /** The instance, revision, acceptance and claim rows are byte-identical before and after. */
  readonly othersUnchanged: boolean;
}

export async function pendingStartFixture(options?: {
  /** The daemon refuses every START: the object is created and claimed but never runs. */
  readonly startRefused?: boolean;
}) {
  const ctx = await deleteLifecycleFixture();
  const { fx, seam } = ctx;
  const upstream = ctx.docker.engine;
  /** Every exact-native-ID inspect, in order, with the State.Running the daemon reported. */
  const observed: { id: string; running: boolean }[] = [];
  const evidence: {
    control?: ControlEvidence;
    controlRefusal?: string;
    grants?: Record<string, string>;
  } = {};
  let armed: { stopOutcome?: "not-found" | "timeout" } | undefined;

  const othersSnapshot = () =>
    JSON.stringify(
      [
        "tf_v2_container_instances",
        "tf_v2_container_revisions",
        "tf_v2_container_acceptances",
        "tf_v2_container_create_claims",
      ].map((table) => fx.database.query(`SELECT * FROM ${table}`).all()),
    );

  function recordRunning(id: string) {
    const last = [...observed].reverse().find((entry) => entry.id === id);
    if (!last?.running) {
      evidence.controlRefusal = "no preceding positive Running=true observation of this exact ID";
      seam.add({ phase: "control.refused", ok: true, native: id.slice(-8) });
      return;
    }
    const row = fx.database
      .query(
        "SELECT resource_uid AS uid, generation, attempt, create_claim_id AS claim, claimed_at_ms AS claimed FROM tf_v2_container_start_attempts WHERE native_id = ? AND state = 'pending'",
      )
      .get(id) as {
      uid: string;
      generation: number;
      attempt: number;
      claim: string;
      claimed: number;
    } | null;
    if (!row) {
      evidence.controlRefusal = "no pending attempt for this exact ID";
      seam.add({ phase: "control.refused", ok: true, native: id.slice(-8) });
      return;
    }
    const before = othersSnapshot();
    const runningAtMs = Math.max(row.claimed, Date.now());
    const changes = fx.database
      .query(
        "UPDATE tf_v2_container_start_attempts SET state = 'running', confirmed_running_at_ms = ? WHERE resource_uid = ? AND generation = ? AND attempt = ? AND create_claim_id = ? AND native_id = ? AND state = 'pending' AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL",
      )
      .run(runningAtMs, row.uid, row.generation, row.attempt, row.claim, id).changes;
    evidence.control = {
      changes,
      claimedAtMs: row.claimed,
      runningAtMs,
      othersUnchanged: before === othersSnapshot(),
    };
    seam.add({
      phase: "control.runningRecordedByTest",
      ok: changes === 1,
      generation: row.generation,
      native: id.slice(-8),
    });
  }

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
    if (armed && method === "POST" && route.endsWith("/stop") && id) {
      recordRunning(id);
      if (armed.stopOutcome === "timeout") throw new Error("synthetic stop timeout");
      if (armed.stopOutcome === "not-found") {
        drop(id);
        return { status: 404, body: "" };
      }
    }
    const response = await upstream(method, path, body, signal);
    if (method === "GET" && route.endsWith("/json") && id && response.status === 200) {
      const state = (JSON.parse(response.body) as { State?: { Running?: unknown } }).State;
      const running = state?.Running === true;
      observed.push({ id, running });
      seam.add({
        phase: "observation.exactID",
        ok: true,
        native: id.slice(-8),
        state: running ? "Running=true" : "Running=false",
      });
    }
    return response;
  };

  /** Arms the private control for the next stop of an exact native ID. */
  const armRunningRecordingControl = (stopOutcome?: "not-found" | "timeout") => {
    armed = stopOutcome === undefined ? {} : { stopOutcome };
  };

  /**
   * A CREATE that the backend settles as failed. With the default spec the container is started
   * and its health path never answers, so the object is physically running while its start
   * attempt stays pending and serving is never published. With startRefused it never runs.
   * After the failed run, inside a real execution of the same Operation, the owner is asked for
   * an observe and a remove authority on the failed (not deleted) generation.
   */
  async function createFailedResource(name: string) {
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
      });
      return {
        kind: "no_effect" as const,
        code: "health_never_passed",
        message: "the CREATE did not become ready",
      };
    });
    const created = await fx.engine.acceptCreate({
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
    return created;
  }

  async function acceptDelete(uid: string) {
    seam.log.length = 0;
    return fx.engine.acceptDelete({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      uid,
      expectedGeneration: 1,
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

  return {
    ...(ctx as Base),
    observed,
    evidence,
    armRunningRecordingControl,
    createFailedResource,
    acceptDelete,
    runDeleteOnce,
    attemptRows,
    instance,
    retention,
    claims,
    resource,
    containerStates,
    dropContainer: (id: string) => drop(id),
  };
}
