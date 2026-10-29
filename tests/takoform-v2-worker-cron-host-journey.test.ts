import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  type LinuxProcessIdentity,
  linuxProcessLiveness,
  workerPortOwnership,
} from "../src/workerd-linux-process.ts";
import { removeOwnerPrivateSocketDirectories } from "./helpers/owner-private-sockets.ts";

const API = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/cron/manifest.json";
const MODULE_URL = "https://artifacts.example.test/cron/index.js";
type Json = Record<string, unknown>;
type HostEvent = { readonly stage: string; readonly port?: number; readonly error?: string };
type Match = {
  readonly match_id: string;
  readonly trigger_uid: string;
  readonly cron: string;
  readonly scheduled_time_ms: number;
  readonly state: string;
  readonly attempts: number;
  readonly result_version_uid: string | null;
};

type RecordedChild = {
  readonly identity: LinuxProcessIdentity;
  readonly listenerPort: number;
};

function recordedChildren(text: string, workerUid: string): readonly RecordedChild[] {
  const state = JSON.parse(text) as Record<string, unknown>;
  if (
    !state ||
    state.workerResourceUid !== workerUid ||
    typeof state.activeOperationId !== "string" ||
    !Array.isArray(state.incarnations)
  )
    throw new Error("Cron fixture owner record is unavailable");
  const relevant: RecordedChild[] = [];
  const ports = new Set<number>();
  let activeCount = 0;
  for (const value of state.incarnations) {
    if (!value || typeof value !== "object")
      throw new Error("Cron fixture owner incarnation is unavailable");
    const record = value as Record<string, unknown>;
    if (record.status === "retired") continue;
    if (
      (record.status !== "active" &&
        record.status !== "draining" &&
        record.status !== "retiring") ||
      typeof record.operationId !== "string" ||
      !Number.isSafeInteger(record.listenerPort) ||
      (record.listenerPort as number) < 1 ||
      (record.listenerPort as number) > 65_535 ||
      !record.processIdentity ||
      typeof record.processIdentity !== "object"
    )
      throw new Error("Cron fixture owner incarnation is unavailable");
    const identity = record.processIdentity as Record<string, unknown>;
    if (
      !Number.isSafeInteger(identity.pid) ||
      (identity.pid as number) <= 1 ||
      typeof identity.bootId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identity.bootId) ||
      typeof identity.pidNamespace !== "string" ||
      !/^\d{1,32}:\d{1,32}$/u.test(identity.pidNamespace) ||
      typeof identity.startTimeTicks !== "string" ||
      !/^\d{1,32}$/u.test(identity.startTimeTicks)
    )
      throw new Error("Cron fixture child identity is unavailable");
    if (record.status === "active") {
      activeCount += 1;
      if (record.operationId !== state.activeOperationId)
        throw new Error("Cron fixture active incarnation changed");
    }
    if (ports.has(record.listenerPort as number))
      throw new Error("Cron fixture owner listener is ambiguous");
    ports.add(record.listenerPort as number);
    relevant.push({
      identity: identity as unknown as LinuxProcessIdentity,
      listenerPort: record.listenerPort as number,
    });
  }
  if (activeCount !== 1) throw new Error("Cron fixture active incarnation is unavailable");
  return relevant;
}

async function waitForRecordedChildrenToExit(
  root: string,
  workerUid: string,
  observation: {
    readonly liveness: typeof linuxProcessLiveness;
    readonly ownership: typeof workerPortOwnership;
  } = { liveness: linuxProcessLiveness, ownership: workerPortOwnership },
  deadlineMs = 10_000,
): Promise<void> {
  const key = createHash("sha256").update(workerUid).digest("hex");
  const statePath = join(root, "worker-owners", key, "runtime-owner.json");
  const text = await readFile(statePath, "utf8");
  const children = recordedChildren(text, workerUid);
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    let allAbsent = true;
    for (const child of children) {
      const liveness = await observation.liveness(child.identity);
      if (liveness === "unknown") throw new Error("Cron fixture child liveness is unknown");
      const ownership = await observation.ownership(
        child.listenerPort,
        liveness === "live" ? child.identity.pid : undefined,
      );
      if (ownership === "foreign") throw new Error("Cron fixture listener is not vacant");
      if (liveness !== "stale" || ownership !== "vacant") allAbsent = false;
    }
    if (allAbsent) {
      if (performance.now() >= deadline)
        throw new Error("Cron fixture recorded child did not exit");
      if ((await readFile(statePath, "utf8")) !== text)
        throw new Error("Cron fixture owner record changed");
      return;
    }
    if (performance.now() >= deadline) throw new Error("Cron fixture recorded child did not exit");
    await Bun.sleep(10);
  }
}

test("Cron restart observation rejects missing, unknown, foreign and live child state", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-cron-owner-observation-"));
  const workerUid = "cron-fixture-worker";
  const key = createHash("sha256").update(workerUid).digest("hex");
  const statePath = join(root, "worker-owners", key, "runtime-owner.json");
  const identity: LinuxProcessIdentity = {
    pid: 12_345,
    bootId: "11111111-1111-1111-1111-111111111111",
    pidNamespace: "1:2",
    startTimeTicks: "3",
  };
  try {
    await expect(waitForRecordedChildrenToExit(root, workerUid)).rejects.toThrow();
    await mkdir(join(root, "worker-owners", key), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        workerResourceUid: workerUid,
        activeOperationId: "operation-1",
        incarnations: [
          {
            operationId: "operation-1",
            status: "active",
            processIdentity: identity,
            listenerPort: 18_731,
          },
        ],
      }),
    );
    const observer = (
      liveness: "live" | "stale" | "unknown",
      ownership: "owned" | "vacant" | "foreign",
    ) => ({
      liveness: async () => liveness,
      ownership: async () => ownership,
    });
    await expect(
      waitForRecordedChildrenToExit(root, workerUid, observer("unknown", "vacant")),
    ).rejects.toThrow("liveness is unknown");
    await expect(
      waitForRecordedChildrenToExit(root, workerUid, observer("stale", "foreign")),
    ).rejects.toThrow("listener is not vacant");
    await expect(
      waitForRecordedChildrenToExit(root, workerUid, observer("live", "owned"), 0),
    ).rejects.toThrow("did not exit");
    await expect(
      waitForRecordedChildrenToExit(root, workerUid, observer("stale", "vacant")),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function startHost(
  root: string,
  binary: string,
  workerUid: string | null,
  manifestSha: string,
  moduleSha: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/takoform-v2-worker-cron-host-server.ts"),
      root,
      binary,
      workerUid ?? "-",
      manifestSha,
      moduleSha,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const events: HostEvent[] = [];
  const reader = child.stdout.getReader();
  let readError: unknown;
  let text = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      text += decoder.decode(next.value, { stream: true });
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
        events.push(JSON.parse(text.slice(0, newline)) as HostEvent);
        text = text.slice(newline + 1);
      }
    }
  })().catch((error: unknown) => {
    readError = error;
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
    reader.releaseLock();
  }
  try {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const ready = events.find((event) => event.stage === "listening");
      if (ready?.port) return { child, close, origin: `http://127.0.0.1:${ready.port}` };
      const failed = events.find((event) => event.stage === "startup_error");
      if (failed) throw new Error(`Cron Host fixture failed: ${failed.error}`);
      if (readError || child.exitCode !== null)
        throw new Error(`Cron Host fixture exited: ${await errors}`);
      await Bun.sleep(10);
    }
    throw new Error("Cron Host fixture did not listen");
  } catch (error) {
    await close();
    throw error;
  }
}

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
      authorization: "Bearer fixture",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      ...(generation === undefined ? {} : { "takoform-expected-generation": String(generation) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function operation(
  origin: string,
  id: string,
  expected: "succeeded" | "reconciling" = "succeeded",
) {
  let latest: Json | null = null;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const response = await request(origin, `/operations/${id}`);
    expect(response.status).toBe(200);
    const value = (await response.json()) as Json;
    latest = value;
    if (value.status === expected) return value;
    if (value.status === "failed")
      throw new Error(`Operation ${id} failed: ${JSON.stringify(value.error)}`);
    await Bun.sleep(10);
  }
  throw new Error(`Operation ${id} did not become ${expected}: ${JSON.stringify(latest)}`);
}

async function create(origin: string, form: string, name: string, spec: Json) {
  const response = await request(
    origin,
    "/resources",
    "POST",
    { form, space: "production", name, spec },
    `cron-${name}-create`,
  );
  if (response.status !== 202)
    throw new Error(`Create ${name}: ${response.status} ${await response.text()}`);
  const accepted = (await response.json()) as { id: string; resourceUid: string };
  expect(await operation(origin, accepted.id)).toMatchObject({
    status: "succeeded",
    effect: "complete",
  });
  return accepted;
}

async function update(origin: string, uid: string, spec: Json, generation: number, key: string) {
  const response = await request(origin, `/resources/${uid}`, "PUT", { spec }, key, generation);
  if (response.status !== 202)
    throw new Error(`Update ${uid}: ${response.status} ${await response.text()}`);
  const accepted = (await response.json()) as { id: string };
  expect(await operation(origin, accepted.id)).toMatchObject({
    status: "succeeded",
    effect: "complete",
  });
  return accepted;
}

async function matches(origin: string): Promise<Match[]> {
  const response = await fetch(`${origin}/__fixture/matches`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Match[]>;
}

async function tick(origin: string, at: number) {
  const response = await fetch(`${origin}/__fixture/tick?at=${at}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    recorded: number;
    claimed: number;
    resolved: number;
    unknown: number;
  }>;
}

async function effects(
  root: string,
): Promise<{ pid: number; cron: string; scheduledTime: number; moduleMarker: string }[]> {
  try {
    return (await readFile(join(root, "scheduled-effects.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// The executable is a Bun stand-in for native workerd. It uses the rendered
// config's runtime root and the existing exact active-Version byte reader,
// imports the digest-verified application module, and calls its scheduled
// export behind the owner's private event gate. It does not qualify native ABI.
const CHILD = String.raw`
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readWorkerdSelectedActiveVersion } from ${JSON.stringify(new URL("../src/workerd-runtime.ts", import.meta.url).pathname)};
const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) throw new Error("bad child command");
function identity() {
  const config = readFileSync(configPath, "utf8");
  const port = /address = "\*:(\d+)"/u.exec(config)?.[1];
  const generation = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
  const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
  const eventToken = /name = "__TAKOSERVER_SELFHOST_EVENT_TOKEN", text = "([0-9a-f]{64})"/u.exec(config)?.[1];
  if (!port || !generation || !token) throw new Error("invalid owner config");
  return { port: Number(port), generation, token, eventToken };
}
const root = dirname(process.argv[1]);
const runtimeRoot = dirname(dirname(configPath));
async function selectedHandler(event) {
  const workerUid = readFileSync(join(root, "worker-resource-uid"), "utf8").trim();
  const expectedScript = "v2-worker-" + createHash("sha256").update(workerUid).digest("hex");
  if (event.logicalWorkerId !== expectedScript) return null;
  const selected = await readWorkerdSelectedActiveVersion(runtimeRoot, event.logicalWorkerId, {
    expectedWorkerResourceUid: workerUid,
    basisPoint: 0,
  });
  if (!selected || selected.versionId !== event.deploymentId) return null;
  const moduleBytes = selected.modules.get(selected.site.mainModule);
  if (!moduleBytes) return null;
  const digest = createHash("sha256").update(moduleBytes).digest("hex");
  if (digest !== readFileSync(join(root, "module-sha256"), "utf8").trim()) return null;
  const loaded = await import("data:text/javascript;base64," + Buffer.from(moduleBytes).toString("base64"));
  return typeof loaded.default?.scheduled === "function" ? loaded.default.scheduled : null;
}
const env = Object.freeze({
  async record(effect) {
    appendFileSync(join(root, "scheduled-effects.jsonl"), JSON.stringify({ pid: process.pid, ...effect }) + "\n");
  },
  async consumeMode(mode) {
    if (!new Set(["hang", "reject", "unknown"]).has(mode)) throw new Error("invalid fixture mode");
    const path = join(root, mode + "-next-event");
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  },
});
const server = Bun.serve({ hostname: "127.0.0.1", port: identity().port, async fetch(request) {
  const current = identity();
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
    url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
    request.headers.get("x-takoserver-selfhost-runtime-config") === current.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": current.generation } });
  }
  if (request.method === "POST" && request.headers.get("host")?.endsWith(".selfhost-events.invalid") &&
    url.pathname === "/.well-known/takoserver/managed-worker-events/v1") {
    if (!current.eventToken || request.headers.get("x-takoserver-selfhost-event-token") !== current.eventToken) return new Response(null, { status: 404 });
    const event = await request.json();
    let handler;
    try { handler = await selectedHandler(event); }
    catch { return new Response(null, { status: 503 }); }
    if (!handler) return new Response(null, { status: 503 });
    let result;
    try { result = await handler(event, env, { waitUntil() { throw new Error("waitUntil not qualified by Bun stand-in"); } }); }
    catch { return Response.json({ protocol: "takoserver.managed-worker-event@v1", kind: "schedule", outcome: "rejected" }, { status: 500 }); }
    if (result === "unknown_ack") return Response.json({ ok: true });
    return Response.json({ protocol: "takoserver.managed-worker-event@v1", kind: "schedule", outcome: "ack" });
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
`;

test(
  "test-only v2 Host retains one Cron match across SIGKILL and drains recorded work after DELETE",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-cron-host-"));
    const binary = join(root, "bun-workerd-stand-in.js");
    const moduleBytes = new TextEncoder().encode(`export default {
  async scheduled(event, env) {
    await env.record({ cron: event.cron, scheduledTime: event.scheduledTime, moduleMarker: "held-module-scheduled-v1" });
    if (await env.consumeMode("hang")) await new Promise(() => {});
    if (await env.consumeMode("reject")) throw new Error("fixture scheduled handler rejected");
    if (await env.consumeMode("unknown")) return "unknown_ack";
    return "ack";
  },
};\n`);
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
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      await writeFile(binary, `#!${process.execPath}\n${CHILD}`, { mode: 0o700 });
      await chmod(binary, 0o700);
      await writeFile(join(root, "module-sha256"), moduleSha);
      await objects.put("cron/manifest", manifestBytes);
      await objects.put("cron/index.js", moduleBytes);
      first = await startHost(root, binary, null, manifestSha, moduleSha);
      const worker = await create(first.origin, MODULE_WORKER_FORM_URL, "cron-worker", {});
      await writeFile(join(root, "worker-resource-uid"), worker.resourceUid);
      const bundle = await create(first.origin, WORKER_BUNDLE_FORM_URL, "cron-bundle", {
        artifact: { url: MANIFEST_URL, sha256: manifestSha },
      });
      const version = await create(first.origin, WORKER_VERSION_FORM_URL, "cron-version", {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["scheduled"],
      });
      const deployment = await create(first.origin, WORKER_DEPLOYMENT_FORM_URL, "cron-deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      await update(first.origin, worker.resourceUid, {}, 1, "cron-worker-observe-deployment");
      const cron = await create(first.origin, WORKER_CRON_TRIGGER_FORM_URL, "cron-trigger", {
        worker: { resourceUid: worker.resourceUid },
        cron: "* * * * *",
      });
      const cronResource = await request(first.origin, `/resources/${cron.resourceUid}`);
      expect(await cronResource.json()).toMatchObject({ observed: { scheduleReady: true } });

      // Only a future minute may be newly recorded after the accepted operation.
      const minute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
      await writeFile(join(root, "hang-next-event"), "1");
      const pendingTick = fetch(`${first.origin}/__fixture/tick?at=${minute + 2_000}`).catch(
        () => null,
      );
      for (let attempt = 0; attempt < 1_000 && (await effects(root)).length === 0; attempt += 1)
        await Bun.sleep(10);
      expect(await effects(root)).toHaveLength(1);
      const [inflight] = await matches(first.origin);
      expect(inflight).toMatchObject({
        trigger_uid: cron.resourceUid,
        state: "dispatching",
        attempts: 1,
        scheduled_time_ms: minute,
      });
      const originalMatchId = inflight?.match_id;
      const firstPid = first.child.pid;
      await first.close();
      first = undefined;
      await pendingTick;

      // Source is no longer available to this Host: Version/Bundle and serving
      // child must recover solely from exact held custody and accepted SQL state.
      expect(await objects.delete("cron/manifest")).toBe(true);
      expect(await objects.delete("cron/index.js")).toBe(true);
      await waitForRecordedChildrenToExit(root, worker.resourceUid);
      second = await startHost(root, binary, worker.resourceUid, manifestSha, moduleSha);
      expect(second.child.pid).not.toBe(firstPid);
      const cronReplay = await request(
        second.origin,
        "/resources",
        "POST",
        {
          form: WORKER_CRON_TRIGGER_FORM_URL,
          space: "production",
          name: "cron-trigger",
          spec: { worker: { resourceUid: worker.resourceUid }, cron: "* * * * *" },
        },
        "cron-cron-trigger-create",
      );
      expect(cronReplay.status).toBe(200);
      expect(await cronReplay.json()).toMatchObject({
        id: cron.id,
        resourceUid: cron.resourceUid,
      });
      expect(await matches(second.origin)).toMatchObject([
        { match_id: originalMatchId, state: "dispatching", attempts: 1 },
      ]);
      expect(await tick(second.origin, minute + 4_000)).toMatchObject({
        recorded: 0,
        claimed: 1,
        resolved: 1,
      });
      // The stale lease expires before retry. The same stable match ID survives.
      const afterRetry = await matches(second.origin);
      expect(afterRetry).toMatchObject([
        {
          match_id: originalMatchId,
          cron: "* * * * *",
          state: "resolved",
          attempts: 2,
          result_version_uid: version.resourceUid,
        },
      ]);
      const retriedEffects = await effects(root);
      expect(retriedEffects).toHaveLength(2);
      expect(retriedEffects.map(({ cron, scheduledTime }) => ({ cron, scheduledTime }))).toEqual([
        { cron: "* * * * *", scheduledTime: minute },
        { cron: "* * * * *", scheduledTime: minute },
      ]);
      expect(retriedEffects[0]?.pid).not.toBe(retriedEffects[1]?.pid);
      expect(retriedEffects.map((effect) => effect.moduleMarker)).toEqual([
        "held-module-scheduled-v1",
        "held-module-scheduled-v1",
      ]);

      await update(
        second.origin,
        cron.resourceUid,
        { worker: { resourceUid: worker.resourceUid }, cron: "*/2 * * * *" },
        1,
        "cron-future-update",
      );
      const oldOnlyMinute =
        minute + (new Date(minute).getUTCMinutes() % 2 === 0 ? 60_000 : 120_000);
      expect(new Date(oldOnlyMinute).getUTCMinutes() % 2).toBe(1);
      expect(await tick(second.origin, oldOnlyMinute + 1_000)).toMatchObject({
        recorded: 0,
        claimed: 0,
      });
      expect(await matches(second.origin)).toHaveLength(1);
      await writeFile(join(root, "reject-next-event"), "1");
      const nextMinute = oldOnlyMinute + 60_000;
      expect(await tick(second.origin, nextMinute + 1_000)).toMatchObject({
        recorded: 1,
        claimed: 1,
        rejected: 1,
      });
      expect((await matches(second.origin))[1]).toMatchObject({
        cron: "*/2 * * * *",
        state: "rejected",
        attempts: 1,
        result_version_uid: version.resourceUid,
      });
      await writeFile(join(root, "unknown-next-event"), "1");
      const pendingMinute = nextMinute + 120_000;
      expect(await tick(second.origin, pendingMinute + 1_000)).toMatchObject({
        recorded: 1,
        claimed: 1,
        unknown: 1,
      });
      const beforeDelete = await matches(second.origin);
      expect(beforeDelete).toHaveLength(3);
      expect(beforeDelete[2]).toMatchObject({ cron: "*/2 * * * *", state: "pending", attempts: 1 });
      const deletion = await request(
        second.origin,
        `/resources/${cron.resourceUid}`,
        "DELETE",
        undefined,
        "cron-trigger-delete-key",
        2,
      );
      if (deletion.status !== 202)
        throw new Error(`Cron DELETE returned ${deletion.status}: ${await deletion.text()}`);
      const deletedOperation = (await deletion.json()) as { id: string };
      expect(await operation(second.origin, deletedOperation.id, "reconciling")).toMatchObject({
        status: "reconciling",
      });
      expect(await tick(second.origin, pendingMinute + 3_000)).toMatchObject({
        recorded: 0,
        claimed: 1,
        resolved: 1,
      });
      expect((await matches(second.origin))[2]).toMatchObject({ state: "resolved", attempts: 2 });
      const advanced = await fetch(
        `${second.origin}/__fixture/advance-host-clock?at=${Date.now() + 60_000}`,
      );
      expect(advanced.status).toBe(200);
      expect(await operation(second.origin, deletedOperation.id)).toMatchObject({
        status: "succeeded",
        effect: "complete",
      });
      expect((await request(second.origin, `/resources/${cron.resourceUid}`)).status).toBe(410);
      expect(await tick(second.origin, pendingMinute + 61_000)).toMatchObject({
        recorded: 0,
        claimed: 0,
      });
      expect(await matches(second.origin)).toHaveLength(3);
      const allEffects = await effects(root);
      expect(allEffects).toHaveLength(5);
      expect(allEffects.every((effect) => effect.moduleMarker === "held-module-scheduled-v1")).toBe(
        true,
      );
      expect((await request(second.origin, `/resources/${deployment.resourceUid}`)).status).toBe(
        200,
      );
    } finally {
      await first?.close();
      await second?.close();
      await removeOwnerPrivateSocketDirectories(root);
      await rm(root, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);
