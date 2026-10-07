import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSelfhostV2WorkerEndpointFrontend } from "../src/selfhost-v2-worker-endpoint-frontend.ts";
import {
  createSelfhostV2WorkerEndpointHttpsListener,
  verifySelfhostV2WorkerEndpointHttpsSni,
} from "../src/selfhost-v2-worker-endpoint-https.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleCustody } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const configuredBinary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";
const ORIGIN = "https://api.native.test";
const TARGET = "selfhost-v2-endpoint-native-test";
const SUFFIX = "workers.native.test";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function certificateFixture() {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-v2-endpoint-native-"));
  await chmod(directory, 0o700);
  const certificatePath = join(directory, "certificate.pem");
  const privateKeyPath = join(directory, "private-key.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      `/CN=*.${SUFFIX}`,
      "-addext",
      `subjectAltName=DNS:*.${SUFFIX}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await child.exited) !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("temporary TLS certificate generation failed");
  }
  await chmod(privateKeyPath, 0o600);
  return {
    directory,
    certificateChain: await readFile(certificatePath, "utf8"),
    privateKey: await readFile(privateKeyPath, "utf8"),
  };
}

function getHttps(
  port: number,
  hostname: string,
  path = "/",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        path,
        headers: { host: hostname },
        // This is a test-only ephemeral certificate, not external trust evidence.
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("test HTTPS request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test.skipIf(configuredBinary === null)(
  "normal v2 HTTP creates, updates and deletes an Endpoint that serves through the native Worker over local SNI",
  async () => {
    // Loopback remaps logical TCP 443 for an ephemeral test socket. This proves
    // only local SNI/certificate matching, not external DNS or public trust.
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-endpoint-native-state-"));
    await chmod(root, 0o700);
    const database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    let tls: Awaited<ReturnType<typeof certificateFixture>> | undefined;

    let listener:
      | Awaited<ReturnType<typeof createSelfhostV2WorkerEndpointHttpsListener>>
      | undefined;
    let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    let endpointFrontend: ReturnType<typeof createSelfhostV2WorkerEndpointFrontend> | undefined;
    let workerOwner:
      | Awaited<ReturnType<NonNullable<typeof composition>["ownerForWorkerUid"]>>
      | undefined;
    let loopbackPort: number | undefined;
    let workerDeleted = false;
    let databaseClosed = false;
    let testFailure: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      tls = await certificateFixture();
      const selected = await selectClosedGraphWorkerd({
        binary: configuredBinary ?? undefined,
        privateRoot: join(root, "runtime-probes"),
      });
      expect(selected.diagnostic).toBeNull();
      expect(selected.binary).toBeString();

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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "endpoint-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({
        actor,
        name: "Native Endpoint Org",
      });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "native endpoint writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });

      const manifestUrl = "https://artifacts.example.test/native-worker/manifest.json";
      const moduleUrl = "https://artifacts.example.test/native-worker/index.mjs";
      const moduleBytes = new TextEncoder().encode(
        "export default { fetch(request) { return new Response('native-worker:' + new URL(request.url).pathname); } };\n",
      );
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: moduleUrl,
              sha256: sha256(moduleBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      await objects.create("native-worker/manifest", manifestBytes);
      await objects.create("native-worker/index.mjs", moduleBytes);
      const grants = [{ principal: `org:${organization.id}`, space: organization.id }];
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x57),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: {
          targetKey: TARGET,
          heldArtifacts: [
            {
              url: manifestUrl,
              sha256: sha256(manifestBytes),
              objectKey: "native-worker/manifest",
              grants,
            },
            {
              url: moduleUrl,
              sha256: sha256(moduleBytes),
              objectKey: "native-worker/index.mjs",
              grants,
            },
          ],
        },
      };
      const bundleCustody = createWorkerBundleCustody({
        sql,
        source: createV2HeldArtifactSource({ objects, entries: config.workerBundle.heldArtifacts }),
      });
      const publicationState = createV2WorkerPublicationState({
        sql,
        now: clock,
        bundleCustody,
      });

      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "v2-worker-owners"),
        targetKey: TARGET,
        workerdBinary: selected.binary,
        endpoint: {
          assignHostname({ resourceUid }) {
            return `v2-${resourceUid.replaceAll("-", "").slice(0, 32)}.${SUFFIX}`;
          },
          observeTls(input, execution) {
            if (!endpointFrontend) throw new Error("Endpoint frontend is not composed");
            return endpointFrontend.observeTls(input, execution);
          },
          observeRouteAbsent(input, execution) {
            if (!endpointFrontend) throw new Error("Endpoint frontend is not composed");
            return endpointFrontend.observeRouteAbsent(input, execution);
          },
        },
      });
      expect(await composition.restoreOwners()).toEqual([]);

      listener = await createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: SUFFIX, port: 443 },
        certificateChain: tls.certificateChain,
        privateKey: tls.privateKey,
        fetch: async (request) =>
          (await endpointFrontend?.fetch(request)) ?? new Response(null, { status: 404 }),
        routeDenies: async (address) =>
          endpointFrontend ? await endpointFrontend.routeDenies(address) : true,
        factories: {
          serve(options) {
            const server = Bun.serve({
              ...options,
              hostname: "127.0.0.1",
              port: 0,
            });
            loopbackPort = server.port;
            // The implementation still enforces logical 443; only this test
            // factory remaps the socket to loopback's ephemeral port.
            return { port: 443, stop: (force) => server.stop(force) };
          },
          async proveSni(input) {
            if (loopbackPort === undefined) throw new Error("HTTPS listener was not created");
            await verifySelfhostV2WorkerEndpointHttpsSni({
              ...input,
              host: "127.0.0.1",
              port: loopbackPort,
            });
          },
        },
      });
      if (loopbackPort === undefined) throw new Error("HTTPS listener was not created");

      const activeComposition = composition;
      const activeListener = listener;
      if (!activeComposition || !activeListener) {
        throw new Error("v2 Worker Endpoint frontend dependencies are not composed");
      }
      endpointFrontend = createSelfhostV2WorkerEndpointFrontend({
        sql,
        targetKey: TARGET,
        publicOrigin: ORIGIN,
        workerEndpointSuffix: SUFFIX,
        publicationState,
        ownerForWorkerUid: (uid) => activeComposition.ownerForWorkerUid(uid),
        witness: activeListener.witness,
      });
      const app = buildApp({
        sql,
        objects,
        clock,
        identity,
        settlement: {
          async verify() {
            throw new Error("fixture settlement unavailable");
          },
        },
        publicOrigin: ORIGIN,
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
        v2: config,
        v2FormFactory: composition.internalFormFactory,
      });
      const http = (
        path: string,
        method = "GET",
        body?: unknown,
        idempotencyKey?: string,
        generation?: number,
      ) =>
        app.fetch(
          new Request(`${ORIGIN}${API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${key.secret}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
              ...(generation === undefined
                ? {}
                : { "takoform-expected-generation": String(generation) }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await http(
          "/resources",
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-native-endpoint`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted.resourceUid;
      };
      const mutate = async (
        uid: string,
        method: "PUT" | "DELETE",
        name: string,
        body?: unknown,
        generation = 1,
      ) => {
        const response = await http(
          `/resources/${uid}`,
          method,
          body,
          `${method.toLowerCase()}-${name}-native-endpoint`,
          generation,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(accepted.resourceUid).toBe(uid);
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted.id;
      };
      const assertSqlOperation = async (
        uid: string,
        operationId: string,
        deleted: boolean,
        generation: number,
      ) => {
        const rows = await sql.query(
          `SELECT r.uid, r.generation, r.observed_generation, r.deleted_at, r.last_operation,
                  op.status, op.effect
             FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
            WHERE r.uid = ? AND r.form_url = ? AND r.target_key = ? LIMIT 2`,
          [uid, WORKER_ENDPOINT_FORM_URL, TARGET],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          uid,
          generation,
          observed_generation: generation,
          last_operation: operationId,
          status: "succeeded",
          effect: "complete",
        });
        expect(rows[0]?.deleted_at === null).toBe(!deleted);
      };

      const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: manifestUrl, sha256: sha256(manifestBytes) },
      });
      const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: bundleUid },
        handlers: ["fetch"],
        vars: {},
        requiredSensitiveVars: [],
      });
      const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const endpointUid = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: workerUid },
      });
      const endpointRead = await http(`/resources/${endpointUid}`);
      expect(endpointRead.status).toBe(200);
      const endpoint = (await endpointRead.json()) as {
        uid: string;
        generation: number;
        output: { hostname: string; url: string };
        observed: { tlsReady: boolean; activeDeploymentRouteReady: boolean };
      };
      expect(endpoint).toMatchObject({
        uid: endpointUid,
        generation: 1,
        observed: { tlsReady: true, activeDeploymentRouteReady: true },
      });
      expect(endpoint.output.hostname).toMatch(new RegExp(`^v2-[a-f0-9]{32}\\.${SUFFIX}$`, "u"));
      expect(endpoint.output.url).toBe(`https://${endpoint.output.hostname}/`);
      expect(await getHttps(loopbackPort, endpoint.output.hostname, "/first")).toEqual({
        status: 200,
        body: "native-worker:/first",
      });
      const createdRows = await sql.query(
        "SELECT last_operation FROM tf_v2_resources WHERE uid = ? AND form_url = ? LIMIT 1",
        [endpointUid, WORKER_ENDPOINT_FORM_URL],
      );
      const createdOperation = createdRows[0]?.last_operation;
      expect(typeof createdOperation).toBe("string");
      await assertSqlOperation(endpointUid, createdOperation as string, false, 1);

      const updateOperationId = await mutate(
        endpointUid,
        "PUT",
        "endpoint",
        { spec: { worker: { resourceUid: workerUid } } },
        1,
      );
      const updatedEndpointRead = await http(`/resources/${endpointUid}`);
      expect(updatedEndpointRead.status).toBe(200);
      const updatedEndpoint = (await updatedEndpointRead.json()) as {
        uid: string;
        output: { hostname: string; url: string };
      };
      expect(updatedEndpoint).toMatchObject({
        uid: endpointUid,
        output: { hostname: endpoint.output.hostname, url: endpoint.output.url },
      });
      expect(await getHttps(loopbackPort, endpoint.output.hostname, "/after-update")).toEqual({
        status: 200,
        body: "native-worker:/after-update",
      });
      await assertSqlOperation(endpointUid, updateOperationId, false, 2);

      const deleteOperationId = await mutate(endpointUid, "DELETE", "endpoint", undefined, 2);
      const absent = await getHttps(loopbackPort, endpoint.output.hostname, "/after-delete");
      expect(absent.status).toBe(503);
      expect(
        await endpointFrontend.routeDenies({
          endpointUid,
          workerUid,
          hostname: endpoint.output.hostname,
          url: endpoint.output.url,
        }),
      ).toBe(true);
      await assertSqlOperation(endpointUid, deleteOperationId, true, 3);
      expect((await http(`/resources/${endpointUid}`)).status).toBe(410);

      await mutate(deploymentUid, "DELETE", "deployment", undefined, 1);
      await mutate(versionUid, "DELETE", "version", undefined, 1);
      await mutate(bundleUid, "DELETE", "bundle", undefined, 1);
      await mutate(workerUid, "DELETE", "worker", undefined, 1);
      workerOwner = await composition.ownerForWorkerUid(workerUid);
      workerDeleted = true;
    } catch (error) {
      testFailure = error;
    } finally {
      if (listener) {
        try {
          await listener.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (composition) {
        try {
          if (workerDeleted && workerOwner) await workerOwner.close();
          else await composition.suspendOwnersRetainingCustody();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!databaseClosed) {
        try {
          database.close();
          databaseClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 0) {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          ...(tls ? [rm(tls.directory, { recursive: true, force: true })] : []),
        ]);
      } else {
        // Keep the private state root intact whenever owner/listener teardown
        // was not positively confirmed.
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testFailure === undefined ? cleanupErrors : [testFailure, ...cleanupErrors],
        `native Endpoint fixture cleanup failed; state retained at ${root}`,
      );
    }
    if (testFailure !== undefined) throw testFailure;
  },
);
