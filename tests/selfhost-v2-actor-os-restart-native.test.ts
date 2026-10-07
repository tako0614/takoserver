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
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
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
const api = "/apis/forms.takoform.com/v2";
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const targetCode = encoder.encode(`
export class CounterActor {
  constructor(context, env) { this.context = context; this.env = env; }
  async start() {
    await this.context.storage.execute("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/write") {
      const result = await this.context.storage.execute("INSERT INTO counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value");
      return Response.json({ id: this.context.id, value: Number(result.rows[0].value), version: this.env.VERSION });
    }
    if (path === "/read") {
      const result = await this.context.storage.query("SELECT value FROM counter WHERE id = 1");
      return Response.json({ id: this.context.id, value: Number(result.rows[0]?.value ?? 0), version: this.env.VERSION });
    }
    return new Response(null, { status: 404 });
  }
  async alarm() {}
  async socketMessage() {}
  async socketClose() {}
  async socketError() {}
}
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    const binding = path === "/self" ? env.SELF : path === "/other" ? env.OTHER : null;
    if (!binding) return new Response("target");
    return binding.get(binding.idFromName("same-room")).fetch(new Request("http://actor.invalid/read"));
  }
};
`);
const callerCode = encoder.encode(`
export class CallerActor {
  constructor(context, env) { this.context = context; this.env = env; }
  async fetch() {
    return Response.json({ from: "caller-actor", id: this.context.id });
  }
  async alarm() {}
  async socketMessage() {}
  async socketClose() {}
  async socketError() {}
}
export default {
  fetch(request, env) {
    return env.ACTOR.get(env.ACTOR.idFromName("same-room")).fetch(request);
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

async function startHost(root: string, workerd: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-actor-host.ts"),
      root,
      workerd,
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
    if (!stopped) throw new Error("owned Host child termination unconfirmed");
  }
  try {
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const ready = events.find((event) => event.stage === "listening");
      if (ready?.port && ready.pid === child.pid)
        return { ...ready, port: ready.port, pid: ready.pid, close, stopped: () => stopped };
      const failed = events.find((event) => event.stage === "startup_error");
      if (failed) throw new Error(`Actor Host startup refused: ${failed.code}`);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Actor Host exited before startup");
      await Bun.sleep(10);
    }
    throw new Error(
      `Actor Host startup timed out after ${events.map((event) => event.stage).join(",")}`,
    );
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
  let last:
    | { status: string; effect: string; code?: string; error?: { code?: string } }
    | undefined;
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    const response = await request(port, key, `${api}/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as {
      status: string;
      effect: string;
      code?: string;
      error?: { code?: string };
    };
    last = operation;
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") throw new Error("accepted Actor operation failed");
    await Bun.sleep(10);
  }
  throw new Error(
    `accepted Actor operation did not settle: ${last?.status}/${last?.effect}/${last?.code ?? last?.error?.code ?? "no-code"}`,
  );
}

async function activeChild(root: string, uid: string): Promise<LinuxProcessIdentity> {
  const ownerKey = digest(encoder.encode(uid));
  const record = JSON.parse(
    await readFile(join(root, "owners", ownerKey, "runtime-owner.json"), "utf8"),
  ) as {
    incarnations: { status: string; processIdentity: LinuxProcessIdentity | null }[];
  };
  const identity = record.incarnations.find((item) => item.status === "active")?.processIdentity;
  if (!identity) throw new Error("native Worker child identity not persisted");
  return identity;
}

async function activeActorChild(
  root: string,
  principal: string,
  namespaceUid: string,
): Promise<LinuxProcessIdentity> {
  const key = digest(encoder.encode(JSON.stringify([principal, namespaceUid])));
  const record = JSON.parse(
    await readFile(
      join(root, "v2-runtime", "actor-storage", "leases", `${key}.child.json`),
      "utf8",
    ),
  ) as {
    schema: string;
    scope: { tenantId: string; namespaceResourceUid: string };
    child: LinuxProcessIdentity;
  };
  expect(record.schema).toBe("takoserver.actor-native-child@1");
  expect(record.scope).toEqual({ tenantId: principal, namespaceResourceUid: namespaceUid });
  return record.child;
}

test.skipIf(binary === undefined)(
  "accepted v2 Actor Binding retains one Actor ID across Host SIGKILL, recovers and drains references",
  async () => {
    if (!binary) throw new Error("pinned Workerd unavailable");
    // Unix-domain Actor broker addresses are bounded by the kernel path limit.
    const root = await mkdtemp(join(tmpdir(), "aos-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    const actorChildren: LinuxProcessIdentity[] = [];
    let safeToRemove = false;
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "actor-os-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Actor OS org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Actor OS writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      database.close();
      const space = organization.id;
      const principal = `org:${space}`;
      const objects = createFileObjectStore({ root: join(root, "objects") });
      const heldArtifacts: {
        url: string;
        sha256: string;
        objectKey: string;
        grants: { principal: string; space: string }[];
      }[] = [];
      async function addBundle(name: string, bytes: Uint8Array) {
        const manifestUrl = `https://artifacts.example.test/actor-os/${name}/manifest.json`;
        const moduleUrl = `https://artifacts.example.test/actor-os/${name}/index.mjs`;
        const manifest = encoder.encode(
          JSON.stringify({
            entrypoint: "index.mjs",
            files: [
              {
                path: "index.mjs",
                url: moduleUrl,
                sha256: digest(bytes),
                mediaType: "application/javascript+module",
              },
            ],
          }),
        );
        const manifestKey = `actor-os/${name}/manifest`;
        const moduleKey = `actor-os/${name}/module`;
        await objects.create(manifestKey, manifest);
        await objects.create(moduleKey, bytes);
        heldArtifacts.push(
          {
            url: manifestUrl,
            sha256: digest(manifest),
            objectKey: manifestKey,
            grants: [{ principal, space }],
          },
          {
            url: moduleUrl,
            sha256: digest(bytes),
            objectKey: moduleKey,
            grants: [{ principal, space }],
          },
        );
        return { artifact: { url: manifestUrl, sha256: digest(manifest) } };
      }
      const targetBundleSpec = await addBundle("target", targetCode);
      const callerBundleSpec = await addBundle("caller", callerCode);
      await writeFile(join(root, "held-artifacts.json"), JSON.stringify(heldArtifacts), {
        mode: 0o600,
      });
      first = await startHost(root, selected.binary);
      expect(first.restored).toEqual([]);
      const initial = first;
      async function create(form: string, name: string, spec: Record<string, unknown>) {
        const response = await request(
          initial.port,
          key.secret,
          `${api}/resources`,
          "POST",
          { form, space, name, spec },
          `actor-os-create-${name}`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(initial.port, key.secret, accepted.id);
        return accepted;
      }
      const target = await create(MODULE_WORKER_FORM_URL, "target", {});
      const caller = await create(MODULE_WORKER_FORM_URL, "caller", {});
      const targetBundle = await create(WORKER_BUNDLE_FORM_URL, "target-bundle", targetBundleSpec);
      const callerBundle = await create(WORKER_BUNDLE_FORM_URL, "caller-bundle", callerBundleSpec);
      const namespaceSpec = {
        worker: { resourceUid: target.resourceUid },
        className: "CounterActor",
      };
      const namespace = await create(ACTOR_NAMESPACE_FORM_URL, "namespace", namespaceSpec);
      const callerNamespace = await create(ACTOR_NAMESPACE_FORM_URL, "caller-namespace", {
        worker: { resourceUid: caller.resourceUid },
        className: "CallerActor",
      });
      const targetVersionSpec = (version: string) => ({
        worker: { resourceUid: target.resourceUid },
        bundle: { resourceUid: targetBundle.resourceUid },
        handlers: ["fetch"],
        vars: { VERSION: version },
        actorBindings: [
          { name: "SELF", resource: { resourceUid: namespace.resourceUid } },
          { name: "OTHER", resource: { resourceUid: callerNamespace.resourceUid } },
        ],
      });
      const targetVersionOne = await create(
        WORKER_VERSION_FORM_URL,
        "target-version-one",
        targetVersionSpec("one"),
      );
      const targetDeploymentSpec = (uid: string) => ({
        worker: { resourceUid: target.resourceUid },
        versions: [{ workerVersion: { resourceUid: uid }, weight: 10_000 }],
      });
      const targetDeployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "target-deployment",
        targetDeploymentSpec(targetVersionOne.resourceUid),
      );
      const callerVersionSpec = {
        worker: { resourceUid: caller.resourceUid },
        bundle: { resourceUid: callerBundle.resourceUid },
        handlers: ["fetch"],
        actorBindings: [{ name: "ACTOR", resource: { resourceUid: namespace.resourceUid } }],
      };
      const callerVersion = await create(
        WORKER_VERSION_FORM_URL,
        "caller-version",
        callerVersionSpec,
      );
      const callerDeployment = await create(WORKER_DEPLOYMENT_FORM_URL, "caller-deployment", {
        worker: { resourceUid: caller.resourceUid },
        versions: [{ workerVersion: { resourceUid: callerVersion.resourceUid }, weight: 10_000 }],
      });
      const invoke = async (port: number, path: string, method = "GET") => {
        const response = await request(
          port,
          key.secret,
          `/__fixture/serve/${caller.resourceUid}${path}`,
          method,
        );
        if (response.status !== 200)
          throw new Error(`Actor invocation ${response.status}: ${await response.text()}`);
        return (await response.json()) as { id: string; value: number; version: string };
      };
      const written = await invoke(initial.port, "/write", "POST");
      expect(written).toMatchObject({ value: 1, version: "one" });
      const firstHostPid = initial.pid;
      const oldCallerChild = await activeChild(root, caller.resourceUid);
      const oldTargetChild = await activeChild(root, target.resourceUid);
      const oldActorChild = await activeActorChild(root, principal, namespace.resourceUid);
      actorChildren.push(oldActorChild);
      await initial.close();
      first = undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          (await linuxProcessLiveness(oldCallerChild)) === "stale" &&
          (await linuxProcessLiveness(oldTargetChild)) === "stale" &&
          (await linuxProcessLiveness(oldActorChild)) === "stale"
        )
          break;
        await Bun.sleep(10);
      }
      expect(await linuxProcessLiveness(oldCallerChild)).toBe("stale");
      expect(await linuxProcessLiveness(oldTargetChild)).toBe("stale");
      expect(await linuxProcessLiveness(oldActorChild)).toBe("stale");
      second = await startHost(root, selected.binary);
      expect(second.pid).not.toBe(firstHostPid);
      expect(second.restored?.sort()).toEqual([caller.resourceUid, target.resourceUid].sort());
      expect((await activeChild(root, caller.resourceUid)).pid).not.toBe(oldCallerChild.pid);
      expect((await activeChild(root, target.resourceUid)).pid).not.toBe(oldTargetChild.pid);
      expect(await invoke(second.port, "/read")).toEqual(written);
      // The accepted graph contains B→B and B→A while caller A→B. All
      // restored brokers are admitted only after the entire cycle is proved.
      const self = await request(
        second.port,
        key.secret,
        `/__fixture/serve/${target.resourceUid}/self`,
      );
      expect(self.status).toBe(200);
      expect(await self.json()).toEqual(written);
      const other = await request(
        second.port,
        key.secret,
        `/__fixture/serve/${target.resourceUid}/other`,
      );
      expect(other.status).toBe(200);
      expect(await other.json()).toMatchObject({ from: "caller-actor" });
      const newActorChild = await activeActorChild(root, principal, namespace.resourceUid);
      actorChildren.push(newActorChild);
      expect(newActorChild.pid).not.toBe(oldActorChild.pid);
      expect(await linuxProcessLiveness(newActorChild)).toBe("live");
      const targetVersionTwo = await (async () => {
        const response = await request(
          second.port,
          key.secret,
          `${api}/resources`,
          "POST",
          {
            form: WORKER_VERSION_FORM_URL,
            space,
            name: "target-version-two",
            spec: targetVersionSpec("two"),
          },
          "actor-os-create-target-version-two",
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(second.port, key.secret, accepted.id);
        return accepted;
      })();
      const switchTarget = await request(
        second.port,
        key.secret,
        `${api}/resources/${targetDeployment.resourceUid}`,
        "PUT",
        { spec: targetDeploymentSpec(targetVersionTwo.resourceUid) },
        "actor-os-switch-target",
        1,
      );
      expect(switchTarget.status).toBe(202);
      await settled(second.port, key.secret, ((await switchTarget.json()) as { id: string }).id);
      expect(await invoke(second.port, "/read")).toEqual({ ...written, version: "two" });
      const updateCaller = await request(
        second.port,
        key.secret,
        `${api}/resources/${callerVersion.resourceUid}`,
        "PUT",
        { spec: callerVersionSpec },
        "actor-os-same-caller",
        1,
      );
      expect(updateCaller.status).toBe(202);
      await settled(second.port, key.secret, ((await updateCaller.json()) as { id: string }).id);
      expect(await invoke(second.port, "/write", "POST")).toEqual({
        ...written,
        value: 2,
        version: "two",
      });

      const restored = second;
      async function remove(uid: string, name: string) {
        const read = await request(restored.port, key.secret, `${api}/resources/${uid}`);
        expect(read.status).toBe(200);
        const generation = ((await read.json()) as { generation: number }).generation;
        const response = await request(
          restored.port,
          key.secret,
          `${api}/resources/${uid}`,
          "DELETE",
          undefined,
          `actor-os-delete-${name}`,
          generation,
        );
        expect(response.status).toBe(202);
        await settled(restored.port, key.secret, ((await response.json()) as { id: string }).id);
      }
      for (const [name, uid] of [
        ["caller-deployment", callerDeployment.resourceUid],
        ["caller-version", callerVersion.resourceUid],
        ["target-deployment", targetDeployment.resourceUid],
        ["target-version-two", targetVersionTwo.resourceUid],
        ["target-version-one", targetVersionOne.resourceUid],
        ["caller-namespace", callerNamespace.resourceUid],
        ["namespace", namespace.resourceUid],
        ["caller-bundle", callerBundle.resourceUid],
        ["target-bundle", targetBundle.resourceUid],
        ["caller", caller.resourceUid],
        ["target", target.resourceUid],
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
      safeToRemove =
        cleanupErrors.length === 0 &&
        [second, first].every((host) => !host || host.stopped()) &&
        (await Promise.all(actorChildren.map(linuxProcessLiveness))).every(
          (state) => state === "stale",
        );
      if (safeToRemove) await rm(root, { recursive: true, force: true });
      if (cleanupErrors.length > 0)
        cleanupFailure = new AggregateError(
          cleanupErrors,
          `Actor Host cleanup incomplete; retained ${root}`,
        );
      else if (!safeToRemove)
        cleanupFailure = new Error(`Actor child absence unconfirmed; retained ${root}`);
    }
    if (primaryFailure && cleanupFailure)
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Actor restart and cleanup failed",
      );
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailure) throw cleanupFailure;
  },
  180_000,
);
