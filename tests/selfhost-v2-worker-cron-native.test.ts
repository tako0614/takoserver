import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { v2ServiceTargetName } from "../src/takoform-v2/worker-service-resolution.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { internalHostname } from "../src/workerd-runtime.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");

async function runNativeCronJourney(closeWithInFlightHandler: boolean): Promise<void> {
  if (!binary) throw new Error("pinned Workerd binary missing");
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-cron-native-"));
  const db = new Database(join(root, "state.sqlite"));
  let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    const selected = await selectClosedGraphWorkerd({
      binary,
      privateRoot: join(root, "binary"),
    });
    if (!selected.binary) throw new Error(selected.diagnostic ?? "native binary unavailable");
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const objects = createMemoryObjectStore();
    let hostNow = Date.now();
    const clock = () => new Date(hostNow);
    const identity = {
      async verify({ assertion }: { assertion: string }) {
        return {
          providerSubject: assertion,
          email: `${assertion}@example.test`,
          displayName: assertion,
        };
      },
    };
    const accounts = createAccounts({ sql, identity, clock });
    const signedIn = await accounts.signIn({ provider: "google", assertion: "cron-owner" });
    const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("fixture actor missing");
    const organization = await accounts.createOrganization({ actor, name: "Cron Native" });
    const key = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "Cron writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });
    const targetKey = "normal-v2-cron-native";
    const moduleUrl = "https://artifacts.example.test/native-cron/app.mjs";
    const manifestUrl = "https://artifacts.example.test/native-cron/manifest.json";
    const moduleBytes = new TextEncoder().encode(`let fired = [];
let delayNext = false;
let releaseDelayed = null;
export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/delay") {
      delayNext = true;
      return Response.json({ delayNext });
    }
    if (path === "/release") {
      if (releaseDelayed) releaseDelayed();
      releaseDelayed = null;
      return Response.json({ released: true });
    }
    return Response.json(fired);
  },
  async scheduled(controller, env, context) {
    fired.push({ cron: controller.cron, scheduledTime: controller.scheduledTime,
      envKeys: Object.keys(env), waitUntil: typeof context.waitUntil });
    if (delayNext) {
      delayNext = false;
      await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 2000);
        releaseDelayed = () => { clearTimeout(fallback); resolve(); };
      });
    }
  },
};`);
    const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "app.mjs",
        files: [
          {
            path: "app.mjs",
            url: moduleUrl,
            sha256: sha(moduleBytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    await objects.create("native-cron/manifest", manifestBytes);
    await objects.create("native-cron/app.mjs", moduleBytes);
    const config = {
      cursorSigningKey: new Uint8Array(32).fill(0x52),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
      workerBundle: {
        targetKey,
        heldArtifacts: [
          {
            url: manifestUrl,
            sha256: sha(manifestBytes),
            objectKey: "native-cron/manifest",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
          {
            url: moduleUrl,
            sha256: sha(moduleBytes),
            objectKey: "native-cron/app.mjs",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
        ],
      },
    };
    workers = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "owners"),
      targetKey,
      workerdBinary: selected.binary,
    });
    expect(await workers.restoreOwners()).toEqual([]);
    const forms = workers.internalFormFactory({ sql, objects, clock });
    expect(forms[WORKER_CRON_TRIGGER_FORM_URL]).toBeDefined();
    const app = buildApp({
      sql,
      objects,
      clock,
      identity,
      settlement: {
        async verify() {
          throw new Error("not configured");
        },
      },
      publicOrigin: "https://api.example.test",
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      v2: config,
      v2FormFactory: workers.internalFormFactory,
    });
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      replayKey?: string,
      generation?: number,
    ) =>
      app.fetch(
        new Request(`https://api.example.test/apis/forms.takoform.com/v2${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key.secret}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(replayKey ? { "idempotency-key": replayKey } : {}),
            ...(generation === undefined
              ? {}
              : { "takoform-expected-generation": String(generation) }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const settle = async (id: string) => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const progress = await app.tickTakoformV2();
        if (progress?.id === id && progress.status === "succeeded") return;
        if (progress?.id === id && progress.status === "failed")
          throw new Error(`Operation failed: ${JSON.stringify(progress)}`);
        if (progress === null) await Bun.sleep(30);
      }
      const row = await sql.query(
        "SELECT status, error_code, next_attempt_at_ms, result_observed_json FROM tf_v2_operations WHERE id = ?",
        [id],
      );
      throw new Error(`Operation ${id} did not settle: ${JSON.stringify(row)}`);
    };
    const create = async (form: string, name: string, spec: Record<string, unknown>) => {
      const response = await request(
        "/resources",
        "POST",
        { form, space: organization.id, name, spec },
        `normal-cron-create-${name}`,
      );
      if (response.status !== 202)
        throw new Error(`Create ${name}: ${response.status} ${await response.text()}`);
      const accepted = (await response.json()) as { id: string; resourceUid: string };
      await settle(accepted.id);
      return accepted.resourceUid;
    };
    const remove = async (uid: string, name: string, generation = 1) => {
      const response = await request(
        `/resources/${uid}`,
        "DELETE",
        undefined,
        `normal-cron-delete-${name}`,
        generation,
      );
      if (response.status !== 202)
        throw new Error(`Delete ${name}: ${response.status} ${await response.text()}`);
      await settle(((await response.json()) as { id: string }).id);
    };
    const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: manifestUrl, sha256: sha(manifestBytes) },
    });
    const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: workerUid },
      bundle: { resourceUid: bundleUid },
      handlers: ["fetch", "scheduled"],
    });
    const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: workerUid },
      versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
    });
    const workerUpdate = await request(
      `/resources/${workerUid}`,
      "PUT",
      { spec: {} },
      "normal-cron-observe-deployment",
      1,
    );
    expect(workerUpdate.status).toBe(202);
    await settle(((await workerUpdate.json()) as { id: string }).id);
    const observedOwner = await workers.ownerForWorkerUid(workerUid);
    const preflight = await observedOwner.observeScheduledCapability({
      workerUid,
      principal: `org:${organization.id}`,
      space: organization.id,
      targetKey,
    });
    expect(preflight.kind).toBe("confirmed");
    const cronUid = await create(WORKER_CRON_TRIGGER_FORM_URL, "cron", {
      worker: { resourceUid: workerUid },
      cron: "* * * * *",
    });
    const replay = await request(
      "/resources",
      "POST",
      {
        form: WORKER_CRON_TRIGGER_FORM_URL,
        space: organization.id,
        name: "cron",
        spec: { worker: { resourceUid: workerUid }, cron: "* * * * *" },
      },
      "normal-cron-create-cron",
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { resourceUid: string }).toMatchObject({
      resourceUid: cronUid,
    });
    const owner = await workers.ownerForWorkerUid(workerUid);
    const origin = `https://${internalHostname(await v2ServiceTargetName(workerUid))}`;
    expect(await (await owner.fetch(new Request(origin))).json()).toEqual([]);
    hostNow = Math.floor(Date.now() / 60_000) * 60_000 + 60_000 + 1_000;
    expect(await workers.pollScheduledDue()).toMatchObject({
      recorded: 1,
      claimed: 1,
      resolved: 1,
    });
    expect(
      await sql.query(
        "SELECT trigger_uid, state, attempts, result_version_uid FROM tf_v2_worker_cron_matches",
      ),
    ).toEqual([
      { trigger_uid: cronUid, state: "resolved", attempts: 1, result_version_uid: versionUid },
    ]);
    expect(await (await owner.fetch(new Request(origin))).json()).toEqual([
      { cron: "* * * * *", scheduledTime: hostNow - 1_000, envKeys: [], waitUntil: "function" },
    ]);
    expect(await workers.pollScheduledDue()).toMatchObject({
      recorded: 0,
      claimed: 0,
      resolved: 0,
    });
    expect(await (await owner.fetch(new Request(origin))).json()).toHaveLength(1);

    const cronUpdate = await request(
      `/resources/${cronUid}`,
      "PUT",
      { spec: { worker: { resourceUid: workerUid }, cron: "*/2 * * * *" } },
      "normal-cron-change-expression",
      1,
    );
    expect(cronUpdate.status).toBe(202);
    await settle(((await cronUpdate.json()) as { id: string }).id);
    const firstMinute = Math.floor(hostNow / 60_000) * 60_000;
    hostNow =
      firstMinute + (new Date(firstMinute).getUTCMinutes() % 2 === 0 ? 120_000 : 60_000) + 1_000;
    if (closeWithInFlightHandler) {
      expect(await (await owner.fetch(new Request(`${origin}/delay`))).json()).toEqual({
        delayNext: true,
      });
      const late = workers.pollScheduledDue();
      let sawSecond = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const observed = (await (await owner.fetch(new Request(origin))).json()) as unknown[];
        if (observed.length === 2) {
          sawSecond = true;
          break;
        }
        await Bun.sleep(5);
      }
      expect(sawSecond).toBe(true);
      const closing = workers.closeScheduledHost();
      expect(await (await owner.fetch(new Request(`${origin}/release`))).json()).toEqual({
        released: true,
      });
      expect(await late).toMatchObject({ recorded: 1, claimed: 1, unknown: 1 });
      await closing;
      expect(
        await sql.query(
          "SELECT state, attempts FROM tf_v2_worker_cron_matches ORDER BY scheduled_time_ms",
        ),
      ).toEqual([
        { state: "resolved", attempts: 1 },
        { state: "pending", attempts: 1 },
      ]);
      await expect(workers.pollScheduledDue()).rejects.toThrow();
    } else {
      expect(await workers.pollScheduledDue()).toMatchObject({
        recorded: 1,
        claimed: 1,
        resolved: 1,
      });
      expect(await (await owner.fetch(new Request(origin))).json()).toEqual([
        { cron: "* * * * *", scheduledTime: firstMinute, envKeys: [], waitUntil: "function" },
        {
          cron: "*/2 * * * *",
          scheduledTime: hostNow - 1_000,
          envKeys: [],
          waitUntil: "function",
        },
      ]);
      expect(await workers.pollScheduledDue()).toMatchObject({
        recorded: 0,
        claimed: 0,
        resolved: 0,
      });
      await remove(cronUid, "cron", 2);
      await remove(deploymentUid, "deployment");
      await remove(versionUid, "version");
      await remove(bundleUid, "bundle");
      await remove(workerUid, "worker", 2);
      expect(
        await sql.query(
          "SELECT state, attempts FROM tf_v2_worker_cron_matches ORDER BY scheduled_time_ms",
        ),
      ).toEqual([
        { state: "resolved", attempts: 1 },
        { state: "resolved", attempts: 1 },
      ]);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    let ownersStopped = workers === undefined;
    try {
      await workers?.closeScheduledHost();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await workers?.suspendOwnersRetainingCustody();
      ownersStopped = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (ownersStopped) {
      try {
        await workers?.closePrivateBindingServices();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    // Never unlink a possibly live owner lock or its custody after a failed
    // stop/close. Retain the exact local fixture for diagnosis instead.
    if (ownersStopped && cleanupFailures.length === 0) {
      try {
        db.close();
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0)
      cleanupError = new AggregateError(
        cleanupFailures,
        `Cron ownership-safe teardown failed; fixture retained at ${root}`,
      );
  }
  if (primaryError && cleanupError)
    throw new AggregateError([primaryError, cleanupError], "Cron journey and teardown failed");
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
}

test.skipIf(binary === undefined)(
  "normal authenticated Cron CRUD dispatches the pinned native scheduled ABI once per due minute",
  () => runNativeCronJourney(false),
  30_000,
);

test.skipIf(binary === undefined)(
  "closing the normal Cron scheduler makes a delayed native ACK unknown",
  () => runNativeCronJourney(true),
  30_000,
);
