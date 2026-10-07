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
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const ORIGIN = "https://api.example.test";
const API = "/apis/forms.takoform.com/v2";
const TARGET = "selfhost-v2-service-binding-native";
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const callerModule = encoder.encode(`
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/identity") {
      return env.TARGET.fetch("https://unrelated.invalid/identity", {
        headers: { "x-service-probe": "caller-owned" },
      });
    }
    return new Response("caller miss", { status: 404 });
  }
};
`);

const targetModule = (version: string) =>
  encoder.encode(`
const VERSION = ${JSON.stringify(version)};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/identity") {
      return Response.json({
        version: VERSION,
        marker: env.MARKER,
        host: url.hostname,
        probe: request.headers.get("x-service-probe"),
        authorization: request.headers.get("authorization"),
        privateHeaders: [...request.headers.keys()].filter((name) =>
          name.startsWith("x-takoserver-") || name.startsWith("x-workerd-")),
      });
    }
    return new Response("target miss", { status: 404 });
  }
};
`);

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test.skipIf(binary === undefined)(
  "accepted v2 service Binding reaches the target's current Deployment without caller republish",
  async () => {
    if (!binary) throw new Error("pinned Workerd unavailable");
    const root = await mkdtemp(join(tmpdir(), "v2-service-native-"));
    const database = new Database(join(root, "host.sqlite"));
    let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    let primaryError: unknown;
    try {
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned Workerd unavailable");

      const heldArtifacts: {
        url: string;
        sha256: string;
        objectKey: string;
        grants: { principal: string; space: string }[];
      }[] = [];
      const addBundle = async (
        name: string,
        bytes: Uint8Array,
        principal: string,
        space: string,
      ) => {
        const manifestUrl = `https://artifacts.example.test/service/${name}/manifest.json`;
        const moduleUrl = `https://artifacts.example.test/service/${name}/index.mjs`;
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
        const manifestKey = `service/${name}/manifest`;
        const moduleKey = `service/${name}/module`;
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
      };
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
      const session = await accounts.signIn({
        provider: "google",
        assertion: "service-native-owner",
      });
      const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Service native org" });
      const apiKey = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Service native writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const principal = `org:${organization.id}`;
      const space = organization.id;
      const callerBundleSpec = await addBundle("caller", callerModule, principal, space);
      const targetOneBundleSpec = await addBundle(
        "target-one",
        targetModule("one"),
        principal,
        space,
      );
      const targetTwoBundleSpec = await addBundle(
        "target-two",
        targetModule("two"),
        principal,
        space,
      );
      const ports = new Map<string, number>();
      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config: {
          cursorSigningKey: new Uint8Array(32).fill(0x53),
          documentation: "https://docs.example.test/v2",
          authenticationDocumentation: "https://docs.example.test/v2/authentication",
          workerBundle: { targetKey: TARGET, heldArtifacts },
        },
        rootDirectory: join(root, "owners"),
        targetKey: TARGET,
        workerdBinary: selected.binary,
        listenerPortForOperation: async (operationId) => {
          const port = await freePort();
          ports.set(operationId, port);
          return port;
        },
        spawn: (command) =>
          spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }),
        endpoint: {
          assignHostname({ resourceUid }) {
            return `worker-${resourceUid.slice(0, 8)}.example.test`;
          },
          async observeTls(input) {
            const owner = await composition?.ownerForWorkerUid(input.workerUid);
            const serving = await owner?.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              ready: serving?.kind === "serving" && serving.hostnames.includes(input.hostname),
            };
          },
          async observeRouteAbsent(input) {
            const owner = await composition?.ownerForWorkerUid(input.workerUid);
            const serving = await owner?.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              absent: serving?.kind === "serving" && !serving.hostnames.includes(input.hostname),
            };
          },
        },
      });
      const active = composition;
      expect(await active.restoreOwners()).toEqual([]);
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
        publicOrigin: ORIGIN,
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
        v2: {
          cursorSigningKey: new Uint8Array(32).fill(0x53),
          documentation: "https://docs.example.test/v2",
          authenticationDocumentation: "https://docs.example.test/v2/authentication",
          workerBundle: { targetKey: TARGET, heldArtifacts },
        },
        v2FormFactory: active.internalFormFactory,
      });
      const request = (
        path: string,
        method: string,
        body: unknown,
        key: string,
        generation?: number,
      ) =>
        app.fetch(
          new Request(`${ORIGIN}${API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${apiKey.secret}`,
              "content-type": "application/json",
              "idempotency-key": key,
              ...(generation === undefined
                ? {}
                : { "takoform-expected-generation": String(generation) }),
            },
            body: JSON.stringify(body),
          }),
        );
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          "/resources",
          "POST",
          { form, space, name, spec },
          `service-create-${name}`,
        );
        if (response.status !== 202)
          throw new Error(`create ${name} failed (${response.status}): ${await response.text()}`);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted;
      };
      const update = async (uid: string, spec: Record<string, unknown>, key: string) => {
        const response = await request(`/resources/${uid}`, "PUT", { spec }, key, 1);
        if (response.status !== 202)
          throw new Error(`update ${uid} failed (${response.status}): ${await response.text()}`);
        const accepted = (await response.json()) as { id: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted;
      };

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
        vars: { MARKER: "target-one-secret-independent" },
      });
      const targetDeploymentSpec = (versionUid: string) => ({
        worker: { resourceUid: target.resourceUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const targetDeployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "target-deployment",
        targetDeploymentSpec(targetVersionOne.resourceUid),
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
      const readResource = async (uid: string) => {
        const response = await app.fetch(
          new Request(`${ORIGIN}${API}/resources/${uid}`, {
            headers: { authorization: `Bearer ${apiKey.secret}` },
          }),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          generation: number;
          lastOperation: string;
          observedGeneration: number;
        };
      };
      const callerDeploymentBefore = await readResource(callerDeployment.resourceUid);
      const hostname = `worker-${endpoint.resourceUid.slice(0, 8)}.example.test`;
      const callerPort = ports.get(endpoint.id) ?? ports.get(callerDeployment.id);
      if (!callerPort) throw new Error("caller native listener port was not selected");
      const invoke = () =>
        fetch(`http://127.0.0.1:${callerPort}/identity`, {
          headers: { host: hostname },
          signal: AbortSignal.timeout(10_000),
        });
      const first = await invoke();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        version: "one",
        marker: "target-one-secret-independent",
        host: "unrelated.invalid",
        probe: "caller-owned",
        authorization: null,
        privateHeaders: [],
      });
      const targetVersionTwo = await create(WORKER_VERSION_FORM_URL, "target-version-two", {
        worker: { resourceUid: target.resourceUid },
        bundle: { resourceUid: targetBundleTwo.resourceUid },
        handlers: ["fetch"],
        vars: { MARKER: "target-two-secret-independent" },
      });
      await update(
        targetDeployment.resourceUid,
        targetDeploymentSpec(targetVersionTwo.resourceUid),
        "service-switch-target",
      );
      const callerServingBefore = await (
        await active.ownerForWorkerUid(caller.resourceUid)
      ).observeServing({
        workerResourceUid: caller.resourceUid,
        targetKey: TARGET,
      });
      expect(callerServingBefore).toMatchObject({
        kind: "serving",
        sourceOperationId: endpoint.id,
        generation: `takoserver-v2-operation:${endpoint.id}`,
        versions: [{ workerVersionUid: callerVersion.resourceUid, weight: 10_000 }],
      });
      const callerDeploymentAfter = await readResource(callerDeployment.resourceUid);
      expect(callerDeploymentAfter).toEqual(callerDeploymentBefore);
      const second = await invoke();
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        version: "two",
        marker: "target-two-secret-independent",
        host: "unrelated.invalid",
        probe: "caller-owned",
        authorization: null,
        privateHeaders: [],
      });
      const callerServingAfter = await (
        await active.ownerForWorkerUid(caller.resourceUid)
      ).observeServing({
        workerResourceUid: caller.resourceUid,
        targetKey: TARGET,
      });
      expect(callerServingAfter).toEqual(callerServingBefore);
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors: unknown[] = [];
    if (composition) {
      try {
        await composition.suspendOwnersRetainingCustody();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    database.close();
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
        `Service binding cleanup incomplete; retained ${root}`,
      );
    await rm(root, { recursive: true, force: true });
    if (primaryError !== undefined) throw primaryError;
  },
  120_000,
);
