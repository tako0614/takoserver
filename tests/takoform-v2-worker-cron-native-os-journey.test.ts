import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import {
  linuxProcessLiveness,
  readLinuxProcessIdentity,
  workerPortOwnership,
} from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const API = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/cron/manifest.json";
const MODULE_URL = "https://artifacts.example.test/cron/index.js";
let authorization = "";
let space = "";

type HostEvent = { readonly stage: string; readonly port?: number; readonly error?: string };
type Match = {
  readonly match_id: string;
  readonly trigger_uid: string;
  readonly scheduled_time_ms: number;
  readonly state: string;
  readonly attempts: number;
  readonly result_version_uid: string | null;
};
type OwnerState = {
  readonly incarnations: readonly {
    readonly status: string;
    readonly listenerPort: number;
    readonly processIdentity: Awaited<ReturnType<typeof readLinuxProcessIdentity>> | null;
  }[];
};

function requireGracefulStopProof(
  events: readonly HostEvent[],
  exitCode: number,
  readerError: unknown,
) {
  if (
    exitCode !== 0 ||
    readerError !== undefined ||
    events.filter((event) => event.stage === "stopped").length !== 1 ||
    events.some((event) => event.stage === "shutdown_error")
  )
    throw new Error("native Cron Host exited without one confirmed owner-suspension receipt");
}

test("native Cron Host shutdown proof requires one stopped receipt and a zero exit", () => {
  expect(() => requireGracefulStopProof([], 0, undefined)).toThrow();
  expect(() => requireGracefulStopProof([{ stage: "stopped" }], 1, undefined)).toThrow();
  expect(() =>
    requireGracefulStopProof([{ stage: "stopped" }], 0, new Error("reader lost")),
  ).toThrow();
  expect(() =>
    requireGracefulStopProof([{ stage: "stopped" }, { stage: "shutdown_error" }], 0, undefined),
  ).toThrow();
  expect(() => requireGracefulStopProof([{ stage: "stopped" }], 0, undefined)).not.toThrow();
});

function startHost(
  root: string,
  workerd: string,
  workerUid: string | null,
  manifestSha: string,
  moduleSha: string,
  organizationId: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/takoform-v2-worker-cron-host-server.ts"),
      root,
      workerd,
      workerUid ?? "-",
      manifestSha,
      moduleSha,
      "native",
      organizationId,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const events: HostEvent[] = [];
  const reader = child.stdout.getReader();
  let output = "";
  let readerError: unknown;
  const reading = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      output += decoder.decode(part.value, { stream: true });
      for (let end = output.indexOf("\n"); end >= 0; end = output.indexOf("\n")) {
        events.push(JSON.parse(output.slice(0, end)) as HostEvent);
        output = output.slice(end + 1);
      }
    }
  })().catch((error: unknown) => {
    readerError = error;
  });
  const identityPromise = readLinuxProcessIdentity(child.pid);
  let origin: string | undefined;
  let readerReleased = false;
  async function joinPipes(): Promise<void> {
    await reading;
    await stderr;
    if (!readerReleased) {
      reader.releaseLock();
      readerReleased = true;
    }
  }
  async function requireOwnedLivePid(): Promise<void> {
    const identity = await identityPromise;
    if (
      child.exitCode !== null ||
      (await linuxProcessLiveness(identity)) !== "live" ||
      JSON.stringify(await readLinuxProcessIdentity(child.pid)) !== JSON.stringify(identity)
    )
      throw new Error("Host PID identity is not owned for signaling");
  }
  async function waitExit(): Promise<number> {
    return await Promise.race([
      child.exited,
      Bun.sleep(10_000).then((): never => {
        throw new Error("native Cron Host did not exit");
      }),
    ]);
  }
  return {
    child,
    get origin(): string {
      if (!origin) throw new Error("native Cron Host is not listening");
      return origin;
    },
    get isReady(): boolean {
      return origin !== undefined;
    },
    async ready(): Promise<void> {
      await identityPromise;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const ready = events.find((event) => event.stage === "listening");
        if (ready?.port) {
          origin = `http://127.0.0.1:${ready.port}`;
          return;
        }
        const failed = events.find((event) => event.stage === "startup_error");
        if (failed || readerError || child.exitCode !== null)
          throw new Error(`native Cron Host startup refused: ${JSON.stringify(failed)}`);
        await Bun.sleep(10);
      }
      throw new Error("native Cron Host did not listen");
    },
    async killOwned(): Promise<void> {
      await requireOwnedLivePid();
      child.kill("SIGKILL");
      await waitExit();
      await joinPipes();
    },
    async stopGracefully(): Promise<void> {
      if (!origin) throw new Error("native Cron Host has no confirmed shutdown endpoint");
      const response = await fetch(`${origin}/__fixture/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 202)
        throw new Error(`native Cron Host shutdown refused: ${response.status}`);
      const exitCode = await waitExit();
      await joinPipes();
      requireGracefulStopProof(events, exitCode, readerError);
    },
    async stopFailedStartup(): Promise<void> {
      if (child.exitCode === null) {
        const identity = await identityPromise;
        if ((await linuxProcessLiveness(identity)) === "live" && child.exitCode === null) {
          let owned = false;
          try {
            await requireOwnedLivePid();
            owned = true;
          } catch (error) {
            // A startup failure can exit between the liveness reads. Do not
            // signal a PID that is no longer the captured process.
            if (child.exitCode === null && (await linuxProcessLiveness(identity)) === "live")
              throw error;
          }
          if (owned && child.exitCode === null) child.kill("SIGKILL");
        }
        await waitExit();
      }
      await joinPipes();
      // No owner-suspension receipt exists; the fixture root remains retained.
    },
  };
}

test("native Cron startup failure retains the spawned Host handle for owned cleanup", async () => {
  const host = startHost(
    "/dev/null/cron-os-startup",
    "/unused/workerd",
    null,
    "unused-manifest",
    "unused-module",
    "fixture-organization",
  );
  try {
    await expect(host.ready()).rejects.toThrow("startup refused");
  } finally {
    if (host.isReady) await host.stopGracefully();
    else await host.stopFailedStartup();
  }
  expect(host.child.exitCode).not.toBeNull();
});

async function request(
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  generation?: number,
) {
  return fetch(`${origin}${API}${path}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      ...(generation === undefined ? {} : { "takoform-expected-generation": String(generation) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function operation(origin: string, id: string) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const response = await request(origin, `/operations/${id}`);
    expect(response.status).toBe(200);
    const value = (await response.json()) as { status: string; error?: unknown };
    if (value.status === "succeeded") return;
    if (value.status === "failed")
      throw new Error(`Operation failed: ${JSON.stringify(value.error)}`);
    await Bun.sleep(10);
  }
  throw new Error(`Operation ${id} did not settle`);
}

async function create(origin: string, form: string, name: string, spec: Record<string, unknown>) {
  const response = await request(
    origin,
    "/resources",
    "POST",
    { form, space, name, spec },
    `native-cron-create-${name}`,
  );
  if (response.status !== 202)
    throw new Error(`Create ${name}: ${response.status} ${await response.text()}`);
  const accepted = (await response.json()) as { id: string; resourceUid: string };
  await operation(origin, accepted.id);
  return accepted.resourceUid;
}

async function update(
  origin: string,
  uid: string,
  spec: Record<string, unknown>,
  key: string,
  generation: number,
) {
  const response = await request(origin, `/resources/${uid}`, "PUT", { spec }, key, generation);
  if (response.status !== 202)
    throw new Error(`Update ${uid}: ${response.status} ${await response.text()}`);
  await operation(origin, ((await response.json()) as { id: string }).id);
}

async function remove(origin: string, uid: string, key: string, generation = 1) {
  const response = await request(origin, `/resources/${uid}`, "DELETE", undefined, key, generation);
  if (response.status !== 202)
    throw new Error(`Delete ${uid}: ${response.status} ${await response.text()}`);
  await operation(origin, ((await response.json()) as { id: string }).id);
}

async function tick(origin: string, at: number) {
  const response = await fetch(`${origin}/__fixture/tick?at=${at}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ recorded: number; claimed: number; resolved: number }>;
}

async function matches(origin: string): Promise<Match[]> {
  const response = await fetch(`${origin}/__fixture/matches`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Match[]>;
}

async function effects(origin: string, workerUid: string): Promise<unknown[]> {
  const response = await fetch(`${origin}/__fixture/serve/${workerUid}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<unknown[]>;
}

test.skipIf(binary === undefined)(
  "authenticated Cron match survives Host SIGKILL and retries in a different native Workerd PID",
  async () => {
    if (!binary) throw new Error("pinned Workerd binary missing");
    const root = await mkdtemp(join(tmpdir(), "v2-cron-native-os-"));
    let first: ReturnType<typeof startHost> | undefined;
    let second: ReturnType<typeof startHost> | undefined;
    let retained = true;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      const database = new Database(join(root, "control.sqlite"));
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const accounts = createAccounts({
        sql,
        identity: {
          async verify({ assertion }: { assertion: string }) {
            return {
              providerSubject: assertion,
              email: `${assertion}@example.test`,
              displayName: assertion,
            };
          },
        },
      });
      const signedIn = await accounts.signIn({ provider: "google", assertion: "cron-os-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("native Cron actor missing");
      const organization = await accounts.createOrganization({ actor, name: "Cron Native OS" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Cron native OS writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      authorization = `Bearer ${key.secret}`;
      space = organization.id;
      database.close();
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "native Workerd unavailable");
      const moduleBytes = new TextEncoder().encode(`let fired = [];
export default {
  fetch() { return Response.json(fired); },
  async scheduled(event, env, context) {
    fired.push({ cron: event.cron, scheduledTime: event.scheduledTime,
      envKeys: Object.keys(env), waitUntil: typeof context.waitUntil });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  },
};`);
      const moduleSha = (await bytesDigest(moduleBytes)).slice(7);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.js",
          files: [
            {
              path: "index.js",
              url: MODULE_URL,
              sha256: moduleSha,
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestSha = (await bytesDigest(manifestBytes)).slice(7);
      const objects = createFileObjectStore({ root: join(root, "objects") });
      await objects.create("cron/manifest", manifestBytes);
      await objects.create("cron/index.js", moduleBytes);
      first = startHost(root, selected.binary, null, manifestSha, moduleSha, organization.id);
      await first.ready();
      const workerUid = await create(first.origin, MODULE_WORKER_FORM_URL, "worker", {});
      const bundleUid = await create(first.origin, WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: MANIFEST_URL, sha256: manifestSha },
      });
      const versionUid = await create(first.origin, WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: bundleUid },
        handlers: ["fetch", "scheduled"],
      });
      const deploymentUid = await create(first.origin, WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      await update(first.origin, workerUid, {}, "native-cron-worker-observe-deployment", 1);
      const cronUid = await create(first.origin, WORKER_CRON_TRIGGER_FORM_URL, "cron", {
        worker: { resourceUid: workerUid },
        cron: "* * * * *",
      });
      const firstMinute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
      const firstTick = fetch(`${first.origin}/__fixture/tick?at=${firstMinute + 1_000}`, {
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await effects(first.origin, workerUid)).length === 1) {
          observed = true;
          break;
        }
        await Bun.sleep(5);
      }
      expect(observed).toBe(true);
      const before = await matches(first.origin);
      expect(before).toMatchObject([{ trigger_uid: cronUid, state: "dispatching", attempts: 1 }]);
      const matchId = before[0]?.match_id;
      const ownerPath = join(
        root,
        "native-worker-owners",
        createHash("sha256").update(workerUid).digest("hex"),
        "runtime-owner.json",
      );
      const ownerBefore = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerState;
      const activeBefore = ownerBefore.incarnations.find((item) => item.status === "active");
      if (!activeBefore?.processIdentity) throw new Error("old physical Workerd identity missing");
      expect(await linuxProcessLiveness(activeBefore.processIdentity)).toBe("live");
      expect(
        await workerPortOwnership(activeBefore.listenerPort, activeBefore.processIdentity.pid),
      ).toBe("owned");
      const oldHostPid = first.child.pid;
      await first.killOwned();
      first = undefined;
      await firstTick;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await linuxProcessLiveness(activeBefore.processIdentity)) === "stale") break;
        await Bun.sleep(20);
      }
      expect(await linuxProcessLiveness(activeBefore.processIdentity)).toBe("stale");
      second = startHost(root, selected.binary, workerUid, manifestSha, moduleSha, organization.id);
      await second.ready();
      expect(second.child.pid).not.toBe(oldHostPid);
      const ownerAfter = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerState;
      const activeAfter = ownerAfter.incarnations.find((item) => item.status === "active");
      if (!activeAfter?.processIdentity)
        throw new Error("restored physical Workerd identity missing");
      expect(activeAfter.processIdentity.pid).not.toBe(activeBefore.processIdentity.pid);
      expect(await linuxProcessLiveness(activeAfter.processIdentity)).toBe("live");
      expect(
        await workerPortOwnership(activeAfter.listenerPort, activeAfter.processIdentity.pid),
      ).toBe("owned");
      expect(await matches(second.origin)).toMatchObject([
        { match_id: matchId, state: "dispatching", attempts: 1 },
      ]);
      const replay = await request(
        second.origin,
        "/resources",
        "POST",
        {
          form: WORKER_CRON_TRIGGER_FORM_URL,
          space,
          name: "cron",
          spec: { worker: { resourceUid: workerUid }, cron: "* * * * *" },
        },
        "native-cron-create-cron",
      );
      expect(replay.status).toBe(200);
      expect((await replay.json()) as { resourceUid: string }).toMatchObject({
        resourceUid: cronUid,
      });
      expect(await tick(second.origin, firstMinute + 35_000)).toMatchObject({
        recorded: 0,
        claimed: 1,
        resolved: 1,
      });
      expect(await matches(second.origin)).toMatchObject([
        { match_id: matchId, state: "resolved", attempts: 2, result_version_uid: versionUid },
      ]);
      expect(await effects(second.origin, workerUid)).toEqual([
        { cron: "* * * * *", scheduledTime: firstMinute, envKeys: [], waitUntil: "function" },
      ]);
      await update(
        second.origin,
        cronUid,
        { worker: { resourceUid: workerUid }, cron: "*/2 * * * *" },
        "native-cron-update-expression",
        1,
      );
      const read = await request(second.origin, `/resources/${cronUid}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ uid: cronUid, generation: 2 });
      await remove(second.origin, cronUid, "native-cron-delete-cron", 2);
      await remove(second.origin, deploymentUid, "native-cron-delete-deployment");
      await remove(second.origin, versionUid, "native-cron-delete-version");
      await remove(second.origin, bundleUid, "native-cron-delete-bundle");
      await remove(second.origin, workerUid, "native-cron-delete-worker", 2);
      expect(await matches(second.origin)).toHaveLength(1);
      await second.stopGracefully();
      second = undefined;
      await rm(root, { recursive: true, force: true });
      retained = false;
    } catch (error) {
      primaryError = error;
    } finally {
      for (const host of [first, second]) {
        if (!host) continue;
        try {
          if (host.isReady) {
            if (host.child.exitCode === null) await host.stopGracefully();
          } else {
            await host.stopFailedStartup();
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (retained)
        process.stderr.write(`native Cron OS fixture retained for ownership diagnosis: ${root}\n`);
      // An uncertain native owner is never killed or unlinked in cleanup.
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
        "native Cron OS journey and/or owned fixture shutdown failed",
      );
    if (primaryError !== undefined) throw primaryError;
  },
  60_000,
);
