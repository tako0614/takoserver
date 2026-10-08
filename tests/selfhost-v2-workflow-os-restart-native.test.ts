import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const guard = nativeEvidenceBinary(
  "workerd-artifact",
  "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
);
const api = "/apis/forms.takoform.com/v2";
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const moduleCode = encoder.encode(`
export class ChildWorkflow {
  async run(event) { return { value: event.params.value, origin: "native-child" }; }
}
export class ParentWorkflow {
  constructor(env) { this.env = env; }
  async run(event, step) {
    const child = await step.do("create-child", async () => {
      const created = await this.env.CHILD.create({
        id: "child-" + event.instanceId,
        params: { value: event.params.value }
      });
      return { id: created.id };
    });
    const resumed = await step.waitForEvent("resume", { type: "resume", timeoutSeconds: 120 });
    const fetched = await this.env.CHILD.get(child.id);
    const status = await fetched.status();
    return { child: fetched.id, childStatus: status.status, resumed };
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "parent-before";
    if (url.pathname === "/create") {
      const created = await env.PARENT.create({ id, params: { value: 42 } });
      return Response.json({ id: created.id, status: (await created.status()).status });
    }
    if (url.pathname === "/status") {
      const parent = await env.PARENT.get(id);
      return Response.json(await parent.status());
    }
    if (url.pathname === "/child-status") {
      const child = await env.CHILD.get("child-" + id);
      return Response.json(await child.status());
    }
    if (url.pathname === "/resume") {
      const parent = await env.PARENT.get(id);
      await parent.sendEvent({ type: "resume", payload: { via: "second-host" } });
      return Response.json(await parent.status());
    }
    return new Response(null, { status: 404 });
  }
};
`);

type HostEvent = {
  stage: "restoring" | "restored" | "listening" | "startup_error" | "tick_error";
  port?: number;
  pid?: number;
  restored?: string[];
  code?: string;
};

async function startHost(root: string, workerd: string, workflowGuard: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-workflow-os-restart-host.ts"),
      root,
      workerd,
      workflowGuard,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  );
  const events: HostEvent[] = [];
  const reader = child.stdout.getReader();
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)) as HostEvent);
        buffer = buffer.slice(end + 1);
      }
    }
  })();
  let stopped = false;
  async function close(): Promise<void> {
    if (stopped) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    reader.releaseLock();
    stopped = child.exitCode !== null || child.signalCode !== null;
    if (!stopped) throw new Error("owned Workflow Host termination unconfirmed");
  }
  try {
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const ready = events.find((event) => event.stage === "listening");
      if (ready?.port && ready.pid === child.pid)
        return { ...ready, port: ready.port, pid: ready.pid, close, stopped: () => stopped };
      const failed = events.find((event) => event.stage === "startup_error");
      if (failed) throw new Error(`Workflow Host startup refused: ${failed.code}`);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Workflow Host exited before startup");
      await Bun.sleep(10);
    }
    throw new Error(`Workflow Host startup timed out: ${events.map((event) => event.stage)}`);
  } catch (error) {
    await close();
    throw error;
  }
}

async function request(
  port: number,
  key: string,
  path: string,
  method = "GET",
  body?: unknown,
  replayKey?: string,
  generation?: number,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      host: "api.example.test",
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(replayKey ? { "idempotency-key": replayKey } : {}),
      ...(generation === undefined ? {} : { "takoform-expected-generation": String(generation) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function settled(port: number, key: string, id: string): Promise<void> {
  let last = "unobserved";
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    const response = await request(port, key, `${api}/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as {
      status: string;
      effect: string;
      error?: { code?: string };
    };
    last = `${operation.status}/${operation.effect}/${operation.error?.code ?? "no-code"}`;
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed")
      throw new Error(`accepted Workflow operation failed: ${last}`);
    await Bun.sleep(10);
  }
  throw new Error(`accepted Workflow operation did not settle: ${last}`);
}

async function activeChild(root: string, uid: string): Promise<LinuxProcessIdentity> {
  const record = JSON.parse(
    await readFile(join(root, "owners", digest(encoder.encode(uid)), "runtime-owner.json"), "utf8"),
  ) as { incarnations: { status: string; processIdentity: LinuxProcessIdentity | null }[] };
  const identity = record.incarnations.find((item) => item.status === "active")?.processIdentity;
  if (!identity) throw new Error("native Worker child identity not persisted");
  return identity;
}

test.skipIf(binary === undefined || guard === undefined)(
  "accepted v2 Workflow Binding replays parent steps and child state after Host SIGKILL and new PID",
  async () => {
    if (!binary || !guard) throw new Error("pinned Workflow native tools unavailable");
    const root = await mkdtemp(join(tmpdir(), "wos-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    let oldWorkerChild: LinuxProcessIdentity | undefined;
    let recoveredWorkerChild: LinuxProcessIdentity | undefined;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned Workerd unavailable");
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
      const signedIn = await accounts.signIn({
        provider: "google",
        assertion: "workflow-os-owner",
      });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Workflow OS org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Workflow OS writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      database.close();
      const space = organization.id;
      const principal = `org:${space}`;
      const manifestUrl = "https://artifacts.example.test/workflow-os/manifest.json";
      const moduleUrl = "https://artifacts.example.test/workflow-os/index.mjs";
      const manifest = encoder.encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: moduleUrl,
              sha256: digest(moduleCode),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const objects = createFileObjectStore({ root: join(root, "objects") });
      await objects.create("workflow-os/manifest", manifest);
      await objects.create("workflow-os/module", moduleCode);
      await writeFile(
        join(root, "held-artifacts.json"),
        JSON.stringify([
          {
            url: manifestUrl,
            sha256: digest(manifest),
            objectKey: "workflow-os/manifest",
            grants: [{ principal, space }],
          },
          {
            url: moduleUrl,
            sha256: digest(moduleCode),
            objectKey: "workflow-os/module",
            grants: [{ principal, space }],
          },
        ]),
        { mode: 0o600 },
      );
      first = await startHost(root, selected.binary, guard);
      expect(first.restored).toEqual([]);
      const initial = first;
      async function create(form: string, name: string, spec: Record<string, unknown>) {
        const response = await request(
          initial.port,
          key.secret,
          `${api}/resources`,
          "POST",
          { form, space, name, spec },
          `workflow-os-create-${name}`,
        );
        if (response.status !== 202)
          throw new Error(`create ${name} failed (${response.status}): ${await response.text()}`);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(initial.port, key.secret, accepted.id);
        return accepted;
      }
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: manifestUrl, sha256: digest(manifest) },
      });
      const source = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
      };
      const unbound = await create(WORKER_VERSION_FORM_URL, "unbound", source);
      const deploymentSpec = (versionUid: string) => ({
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const deployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "deployment",
        deploymentSpec(unbound.resourceUid),
      );
      const child = await create(DURABLE_WORKFLOW_FORM_URL, "child", {
        worker: { resourceUid: worker.resourceUid },
        className: "ChildWorkflow",
      });
      const parentSpec = {
        worker: { resourceUid: worker.resourceUid },
        className: "ParentWorkflow",
      };
      const parent = await create(DURABLE_WORKFLOW_FORM_URL, "parent", parentSpec);
      const bound = await create(WORKER_VERSION_FORM_URL, "bound", {
        ...source,
        workflowBindings: [
          { name: "CHILD", resource: { resourceUid: child.resourceUid } },
          { name: "PARENT", resource: { resourceUid: parent.resourceUid } },
        ],
      });
      const switchVersion = await request(
        initial.port,
        key.secret,
        `${api}/resources/${deployment.resourceUid}`,
        "PUT",
        { spec: deploymentSpec(bound.resourceUid) },
        "workflow-os-switch",
        1,
      );
      expect(switchVersion.status).toBe(202);
      await settled(initial.port, key.secret, ((await switchVersion.json()) as { id: string }).id);
      const serve = async (port: number, path: string) => {
        const response = await request(
          port,
          key.secret,
          `/__fixture/serve/${worker.resourceUid}${path}`,
        );
        if (response.status !== 200)
          throw new Error(
            `Workflow Binding ${path} failed (${response.status}): ${await response.text()}`,
          );
        return (await response.json()) as Record<string, unknown>;
      };
      expect(await serve(initial.port, "/create?id=parent-before")).toEqual({
        id: "parent-before",
        status: "queued",
      });
      const firstPoll = await request(initial.port, key.secret, "/__fixture/poll", "POST");
      expect(firstPoll.status).toBe(200);
      expect(await firstPoll.json()).toMatchObject({ outcomes: [{ kind: "parked" }] });
      expect(await serve(initial.port, "/status?id=parent-before")).toMatchObject({
        status: "waiting",
      });
      expect(await serve(initial.port, "/child-status?id=parent-before")).toMatchObject({
        status: "queued",
      });
      const originalOperation = await request(
        initial.port,
        key.secret,
        `${api}/operations/${bound.id}`,
      );
      expect(originalOperation.status).toBe(200);
      oldWorkerChild = await activeChild(root, worker.resourceUid);
      const firstHostPid = initial.pid;
      await initial.close();
      first = undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await linuxProcessLiveness(oldWorkerChild)) === "stale") break;
        await Bun.sleep(10);
      }
      expect(await linuxProcessLiveness(oldWorkerChild)).toBe("stale");
      second = await startHost(root, selected.binary, guard);
      expect(second.pid).not.toBe(firstHostPid);
      expect(second.restored).toEqual([worker.resourceUid]);
      recoveredWorkerChild = await activeChild(root, worker.resourceUid);
      expect(recoveredWorkerChild.pid).not.toBe(oldWorkerChild.pid);
      expect(await linuxProcessLiveness(recoveredWorkerChild)).toBe("live");
      expect(await serve(second.port, "/status?id=parent-before")).toMatchObject({
        status: "waiting",
      });
      expect(await serve(second.port, "/child-status?id=parent-before")).toMatchObject({
        status: "queued",
      });
      const replayedOperation = await request(
        second.port,
        key.secret,
        `${api}/operations/${bound.id}`,
      );
      expect(replayedOperation.status).toBe(200);
      expect(await replayedOperation.json()).toEqual(await originalOperation.json());
      const childPoll = await request(second.port, key.secret, "/__fixture/poll", "POST");
      expect(childPoll.status).toBe(200);
      expect(await serve(second.port, "/child-status?id=parent-before")).toEqual({
        status: "complete",
        output: { value: 42, origin: "native-child" },
      });
      expect(await serve(second.port, "/resume?id=parent-before")).toMatchObject({
        status: "waiting",
      });
      const parentPoll = await request(second.port, key.secret, "/__fixture/poll", "POST");
      expect(parentPoll.status).toBe(200);
      expect(await serve(second.port, "/status?id=parent-before")).toEqual({
        status: "complete",
        output: {
          child: "child-parent-before",
          childStatus: "complete",
          resumed: { via: "second-host" },
        },
      });
      expect(await serve(second.port, "/create?id=parent-after")).toEqual({
        id: "parent-after",
        status: "queued",
      });
      const sameSpec = await request(
        second.port,
        key.secret,
        `${api}/resources/${parent.resourceUid}`,
        "PUT",
        { spec: parentSpec },
        "workflow-os-same-parent",
        1,
      );
      expect(sameSpec.status).toBe(202);
      await settled(second.port, key.secret, ((await sameSpec.json()) as { id: string }).id);
      const parentRead = await request(
        second.port,
        key.secret,
        `${api}/resources/${parent.resourceUid}`,
      );
      expect(parentRead.status).toBe(200);
      expect((await parentRead.json()) as { generation: number }).toMatchObject({ generation: 2 });

      const recovered = second;
      async function remove(uid: string, name: string) {
        const read = await request(recovered.port, key.secret, `${api}/resources/${uid}`);
        expect(read.status).toBe(200);
        const generation = ((await read.json()) as { generation: number }).generation;
        const response = await request(
          recovered.port,
          key.secret,
          `${api}/resources/${uid}`,
          "DELETE",
          undefined,
          `workflow-os-delete-${name}`,
          generation,
        );
        expect(response.status).toBe(202);
        await settled(recovered.port, key.secret, ((await response.json()) as { id: string }).id);
      }
      for (const [name, uid] of [
        ["deployment", deployment.resourceUid],
        ["bound", bound.resourceUid],
        ["unbound", unbound.resourceUid],
        ["parent", parent.resourceUid],
        ["child", child.resourceUid],
        ["bundle", bundle.resourceUid],
        ["worker", worker.resourceUid],
      ] as const)
        await remove(uid, name);
    } catch (error) {
      primaryFailure = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const host of [second, first]) {
        try {
          await host?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      const workerStopped = (
        await Promise.all(
          [oldWorkerChild, recoveredWorkerChild]
            .filter((identity): identity is LinuxProcessIdentity => identity !== undefined)
            .map(linuxProcessLiveness),
        )
      ).every((state) => state === "stale");
      const safeToRemove =
        cleanupErrors.length === 0 &&
        [second, first].every((host) => !host || host.stopped()) &&
        workerStopped;
      if (safeToRemove) await rm(root, { recursive: true, force: true });
      if (cleanupErrors.length > 0)
        cleanupFailure = new AggregateError(
          cleanupErrors,
          `Workflow Host cleanup incomplete; retained ${root}`,
        );
      else if (!safeToRemove)
        cleanupFailure = new Error(`Workflow child absence unconfirmed; retained ${root}`);
    }
    if (primaryFailure && cleanupFailure)
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Workflow restart and cleanup failed",
      );
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailure) throw cleanupFailure;
  },
  180_000,
);
