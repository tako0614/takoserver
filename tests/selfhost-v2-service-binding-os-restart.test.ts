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
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const api = "/apis/forms.takoform.com/v2";
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const callerCode = encoder.encode(`
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/identity") return new Response("missing", { status: 404 });
    const target = await env.TARGET.fetch("https://unrelated.invalid/identity", {
      headers: { "x-service-probe": "caller-owned" },
    });
    return Response.json({ callerHost: new URL(request.url).hostname, target: await target.json() });
  }
};`);
const targetCode = (version: string) =>
  encoder.encode(`
const VERSION = ${JSON.stringify(version)};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/identity") return new Response("missing", { status: 404 });
    return Response.json({ version: VERSION, marker: env.MARKER, host: url.hostname,
      probe: request.headers.get("x-service-probe"),
      authorization: request.headers.get("authorization"),
      privateHeaders: [...request.headers.keys()].filter(name =>
        name.startsWith("x-takoserver-") || name.startsWith("x-workerd-")) });
  }
};`);

type HostEvent = {
  stage: "listening" | "startup_error" | "tick_error";
  port?: number;
  pid?: number;
  restored?: string[];
  code?: string;
  ownerLines?: string[];
};

async function startHost(root: string, workerd: string, organizationId: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-service-binding-host.ts"),
      root,
      workerd,
      organizationId,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
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
  async function close() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    reader.releaseLock();
  }
  try {
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const ready = events.find((event) => event.stage === "listening");
      if (ready?.port && ready.pid) return { ...ready, port: ready.port, pid: ready.pid, close };
      const failed = events.find((event) => event.stage === "startup_error");
      if (failed)
        throw new Error(
          `Host startup refused: ${failed.code} at owner lines ${failed.ownerLines?.join(",") ?? "unknown"}`,
        );
      if (child.exitCode !== null) throw new Error("Host exited before startup");
      await Bun.sleep(10);
    }
    throw new Error("Host startup timed out");
  } catch (error) {
    await close();
    throw error;
  }
}

async function hostRequest(
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
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    const response = await hostRequest(port, key, `${api}/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as { status: string; effect: string };
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") throw new Error("accepted Worker operation failed");
    await Bun.sleep(10);
  }
  throw new Error("accepted Worker operation did not settle");
}

async function activeChild(root: string, workerUid: string): Promise<LinuxProcessIdentity> {
  const ownerKey = digest(encoder.encode(workerUid));
  const record = JSON.parse(
    await readFile(join(root, "owners", ownerKey, "runtime-owner.json"), "utf8"),
  ) as {
    incarnations: { status: string; processIdentity: LinuxProcessIdentity | null }[];
  };
  const identity = record.incarnations.find((item) => item.status === "active")?.processIdentity;
  if (!identity) throw new Error("native child identity was not persisted");
  return identity;
}

test.skipIf(binary === undefined)(
  "accepted Service Binding survives Host OS SIGKILL and target-only update on the same graph",
  async () => {
    if (!binary) throw new Error("pinned Workerd unavailable");
    const root = await mkdtemp(join(tmpdir(), "v2-service-os-restart-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error("pinned Workerd unavailable");
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "service-os-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Service OS org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Service OS writer",
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
        const manifestUrl = `https://artifacts.example.test/service-os/${name}/manifest.json`;
        const moduleUrl = `https://artifacts.example.test/service-os/${name}/index.mjs`;
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
        const manifestKey = `service-os/${name}/manifest`;
        const moduleKey = `service-os/${name}/module`;
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
      const callerBundleSpec = await addBundle("caller", callerCode);
      const targetOneBundleSpec = await addBundle("target-one", targetCode("one"));
      const targetTwoBundleSpec = await addBundle("target-two", targetCode("two"));
      await writeFile(join(root, "held-artifacts.json"), JSON.stringify(heldArtifacts), {
        mode: 0o600,
      });
      first = await startHost(root, selected.binary, space);
      expect(first.restored).toEqual([]);
      const initial = first;
      async function create(form: string, name: string, spec: Record<string, unknown>) {
        const response = await hostRequest(
          initial.port,
          key.secret,
          `${api}/resources`,
          "POST",
          { form, space, name, spec },
          `service-os-create-${name}`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(initial.port, key.secret, accepted.id);
        return accepted;
      }
      const target = await create(MODULE_WORKER_FORM_URL, "target", {});
      const caller = await create(MODULE_WORKER_FORM_URL, "caller", {});
      const targetBundleOne = await create(
        WORKER_BUNDLE_FORM_URL,
        "target-bundle-one",
        targetOneBundleSpec,
      );
      const targetBundleTwo = await create(
        WORKER_BUNDLE_FORM_URL,
        "target-bundle-two",
        targetTwoBundleSpec,
      );
      const callerBundle = await create(WORKER_BUNDLE_FORM_URL, "caller-bundle", callerBundleSpec);
      const targetVersionOne = await create(WORKER_VERSION_FORM_URL, "target-version-one", {
        worker: { resourceUid: target.resourceUid },
        bundle: { resourceUid: targetBundleOne.resourceUid },
        handlers: ["fetch"],
        vars: { MARKER: "target-one" },
      });
      const deploymentSpec = (uid: string) => ({
        worker: { resourceUid: target.resourceUid },
        versions: [{ workerVersion: { resourceUid: uid }, weight: 10_000 }],
      });
      const targetDeployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "target-deployment",
        deploymentSpec(targetVersionOne.resourceUid),
      );
      const callerVersion = await create(WORKER_VERSION_FORM_URL, "caller-version", {
        worker: { resourceUid: caller.resourceUid },
        bundle: { resourceUid: callerBundle.resourceUid },
        handlers: ["fetch"],
        serviceBindings: [{ name: "TARGET", resource: { resourceUid: target.resourceUid } }],
      });
      const callerDeployment = await create(WORKER_DEPLOYMENT_FORM_URL, "caller-deployment", {
        worker: { resourceUid: caller.resourceUid },
        versions: [{ workerVersion: { resourceUid: callerVersion.resourceUid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "caller-endpoint", {
        worker: { resourceUid: caller.resourceUid },
      });
      const endpointResponse = await hostRequest(
        initial.port,
        key.secret,
        `${api}/resources/${endpoint.resourceUid}`,
      );
      expect(endpointResponse.status).toBe(200);
      const endpointRead = (await endpointResponse.json()) as { output: { url: string } };
      const endpointUrl = endpointRead.output.url;
      const hostname = new URL(endpointUrl).hostname;
      const invoke = async (port: number) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/__fixture/serve/${caller.resourceUid}`,
          {
            headers: { host: hostname, authorization: `Bearer ${key.secret}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        expect(response.status).toBe(200);
        return await response.json();
      };
      const targetAnswer = (version: string) => ({
        version,
        marker: `target-${version}`,
        host: "unrelated.invalid",
        probe: "caller-owned",
        authorization: null,
        privateHeaders: [],
      });
      expect(await invoke(initial.port)).toEqual({
        callerHost: hostname,
        target: targetAnswer("one"),
      });
      const firstHostPid = initial.pid;
      const oldCallerChild = await activeChild(root, caller.resourceUid);
      const oldTargetChild = await activeChild(root, target.resourceUid);
      await initial.close();
      first = undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          (await linuxProcessLiveness(oldCallerChild)) === "stale" &&
          (await linuxProcessLiveness(oldTargetChild)) === "stale"
        )
          break;
        await Bun.sleep(10);
      }
      expect(await linuxProcessLiveness(oldCallerChild)).toBe("stale");
      expect(await linuxProcessLiveness(oldTargetChild)).toBe("stale");
      second = await startHost(root, selected.binary, space);
      expect(second.pid).not.toBe(firstHostPid);
      expect(second.restored?.sort()).toEqual([caller.resourceUid, target.resourceUid].sort());
      expect((await activeChild(root, caller.resourceUid)).pid).not.toBe(oldCallerChild.pid);
      expect((await activeChild(root, target.resourceUid)).pid).not.toBe(oldTargetChild.pid);
      const endpointAfter = await hostRequest(
        second.port,
        key.secret,
        `${api}/resources/${endpoint.resourceUid}`,
      );
      expect(endpointAfter.status).toBe(200);
      expect(((await endpointAfter.json()) as { output: { url: string } }).output.url).toBe(
        endpointUrl,
      );
      expect(await invoke(second.port)).toEqual({
        callerHost: hostname,
        target: targetAnswer("one"),
      });
      const targetVersionTwo = await (async () => {
        const response = await hostRequest(
          second.port,
          key.secret,
          `${api}/resources`,
          "POST",
          {
            form: WORKER_VERSION_FORM_URL,
            space,
            name: "target-version-two",
            spec: {
              worker: { resourceUid: target.resourceUid },
              bundle: { resourceUid: targetBundleTwo.resourceUid },
              handlers: ["fetch"],
              vars: { MARKER: "target-two" },
            },
          },
          "service-os-create-target-version-two",
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(second.port, key.secret, accepted.id);
        return accepted;
      })();
      const switchResponse = await hostRequest(
        second.port,
        key.secret,
        `${api}/resources/${targetDeployment.resourceUid}`,
        "PUT",
        { spec: deploymentSpec(targetVersionTwo.resourceUid) },
        "service-os-switch-target",
        1,
      );
      expect(switchResponse.status).toBe(202);
      await settled(second.port, key.secret, ((await switchResponse.json()) as { id: string }).id);
      expect(await invoke(second.port)).toEqual({
        callerHost: hostname,
        target: targetAnswer("two"),
      });
      const callerDeploymentRead = await hostRequest(
        second.port,
        key.secret,
        `${api}/resources/${callerDeployment.resourceUid}`,
      );
      expect(callerDeploymentRead.status).toBe(200);
      expect(((await callerDeploymentRead.json()) as { generation: number }).generation).toBe(1);
      const restoredHost = second;
      async function remove(uid: string, name: string) {
        const read = await hostRequest(restoredHost.port, key.secret, `${api}/resources/${uid}`);
        expect(read.status).toBe(200);
        const generation = ((await read.json()) as { generation: number }).generation;
        const response = await hostRequest(
          restoredHost.port,
          key.secret,
          `${api}/resources/${uid}`,
          "DELETE",
          undefined,
          `service-os-delete-${name}`,
          generation,
        );
        expect(response.status).toBe(202);
        await settled(
          restoredHost.port,
          key.secret,
          ((await response.json()) as { id: string }).id,
        );
      }
      for (const [name, uid] of [
        ["caller-endpoint", endpoint.resourceUid],
        ["caller-deployment", callerDeployment.resourceUid],
        ["caller-version", callerVersion.resourceUid],
        ["target-deployment", targetDeployment.resourceUid],
        ["target-version-two", targetVersionTwo.resourceUid],
        ["target-version-one", targetVersionOne.resourceUid],
        ["caller-bundle", callerBundle.resourceUid],
        ["target-bundle-two", targetBundleTwo.resourceUid],
        ["target-bundle-one", targetBundleOne.resourceUid],
        ["caller", caller.resourceUid],
        ["target", target.resourceUid],
      ] as const)
        await remove(uid, name);
    } finally {
      await second?.close();
      await first?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
