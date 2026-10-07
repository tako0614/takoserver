import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const configuredBinary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";
const ORIGIN = "https://api.native.test";
const TARGET = "selfhost-v2-worker-assets-native-test";
const SUFFIX = "assets.workers.native.test";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function certificateFixture() {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-v2-assets-native-"));
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
  method = "GET",
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        path,
        method,
        headers: { host: hostname },
        // This ephemeral certificate proves local SNI only, not public trust.
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: response.headers["content-type"],
          }),
        );
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("test HTTPS request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test.skipIf(configuredBinary === null)(
  "normal v2 Host API publishes a module-less static Worker Version through native assets routing",
  async () => {
    // The logical Endpoint listener is TCP 443; this isolated fixture remaps
    // it to loopback. It is not external DNS or public CA evidence.
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-assets-native-state-"));
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
    let loopbackPort: number | undefined;
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "assets-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({ actor, name: "Native Assets Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "native assets writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });

      const manifestUrl = "https://artifacts.example.test/native-assets/manifest.json";
      const indexUrl = "https://artifacts.example.test/native-assets/index.html";
      const cssUrl = "https://artifacts.example.test/native-assets/assets/site.css";
      const indexBytes = new TextEncoder().encode("<!doctype html><title>held-index</title>\n");
      const cssBytes = new TextEncoder().encode("body { color: rgb(17, 34, 51); }\n");
      const codeManifestUrl = "https://artifacts.example.test/native-assets/code.json";
      const codeUrl = "https://artifacts.example.test/native-assets/index.mjs";
      const codeBytes = new TextEncoder().encode(
        "export default { fetch(request) { const path = new URL(request.url).pathname; return path === '/worker-ok' ? new Response('worker-ok') : request.method === 'POST' ? new Response('worker-post') : new Response('worker-404', { status: 404 }); } };\n",
      );
      const codeManifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: codeUrl,
              sha256: sha256(codeBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          files: [
            {
              path: "index.html",
              url: indexUrl,
              sha256: sha256(indexBytes),
              mediaType: "text/html",
            },
            {
              path: "assets/site.css",
              url: cssUrl,
              sha256: sha256(cssBytes),
              mediaType: "text/css",
            },
          ],
        }),
      );
      await objects.create("native-assets/manifest", manifestBytes);
      await objects.create("native-assets/index.html", indexBytes);
      await objects.create("native-assets/assets/site.css", cssBytes);
      await objects.create("native-assets/code-manifest", codeManifestBytes);
      await objects.create("native-assets/index.mjs", codeBytes);
      const grants = [{ principal: `org:${organization.id}`, space: organization.id }];
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x67),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        staticAssetBundle: {
          targetKey: TARGET,
          heldArtifacts: [
            {
              url: manifestUrl,
              sha256: sha256(manifestBytes),
              objectKey: "native-assets/manifest",
              grants,
            },
            {
              url: indexUrl,
              sha256: sha256(indexBytes),
              objectKey: "native-assets/index.html",
              grants,
            },
            {
              url: cssUrl,
              sha256: sha256(cssBytes),
              objectKey: "native-assets/assets/site.css",
              grants,
            },
          ],
        },
        workerBundle: {
          targetKey: TARGET,
          heldArtifacts: [
            {
              url: codeManifestUrl,
              sha256: sha256(codeManifestBytes),
              objectKey: "native-assets/code-manifest",
              grants,
            },
            {
              url: codeUrl,
              sha256: sha256(codeBytes),
              objectKey: "native-assets/index.mjs",
              grants,
            },
          ],
        },
      };
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
          async observeTls(input, execution) {
            if (!endpointFrontend) throw new Error("Endpoint frontend is not composed");
            return await endpointFrontend.observeTls(input, execution);
          },
          async observeRouteAbsent(input, execution) {
            if (!endpointFrontend) throw new Error("Endpoint frontend is not composed");
            return await endpointFrontend.observeRouteAbsent(input, execution);
          },
        },
      });
      await composition.restoreOwners();
      const activeComposition = composition;
      const publicationStateForEndpoint = activeComposition.endpointPublicationState;
      const ownerForEndpoint = activeComposition.ownerForWorkerUid.bind(activeComposition);

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
            const server = Bun.serve({ ...options, hostname: "127.0.0.1", port: 0 });
            loopbackPort = server.port;
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
      if (loopbackPort === undefined) {
        throw new Error("native assets endpoint dependencies are not composed");
      }
      const activeListener = listener;
      endpointFrontend = createSelfhostV2WorkerEndpointFrontend({
        sql,
        targetKey: TARGET,
        publicOrigin: ORIGIN,
        workerEndpointSuffix: SUFFIX,
        publicationState: publicationStateForEndpoint,
        ownerForWorkerUid: ownerForEndpoint,
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
        v2FormFactory: activeComposition.internalFormFactory,
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
          `create-${name}-native-assets`,
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
      const updateDeployment = async (
        deploymentUid: string,
        workerUid: string,
        versionUid: string,
        generation: number,
      ) => {
        const response = await http(
          `/resources/${deploymentUid}`,
          "PUT",
          {
            spec: {
              worker: { resourceUid: workerUid },
              versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
            },
          },
          `update-${workerUid}-native-assets`,
          generation,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(accepted.resourceUid).toBe(deploymentUid);
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted.id;
      };
      const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const assetUid = await create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
        artifact: { url: manifestUrl, sha256: sha256(manifestBytes) },
      });
      const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        handlers: [],
        assets: {
          bundle: { resourceUid: assetUid },
          runWorkerFirst: false,
          notFoundHandling: "single_page_application",
        },
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
        output: { hostname: string; url: string };
        observed: { tlsReady: boolean; activeDeploymentRouteReady: boolean };
      };
      expect(endpoint).toMatchObject({
        uid: endpointUid,
        output: { url: `https://${endpoint.output.hostname}/` },
        observed: { tlsReady: true, activeDeploymentRouteReady: true },
      });
      expect(await getHttps(loopbackPort, endpoint.output.hostname, "/")).toMatchObject({
        status: 200,
        body: new TextDecoder().decode(indexBytes),
        contentType: "text/html",
      });
      expect(
        await getHttps(loopbackPort, endpoint.output.hostname, "/assets/site.css?revision=ignored"),
      ).toMatchObject({
        status: 200,
        body: new TextDecoder().decode(cssBytes),
        contentType: "text/css",
      });
      // Static-only single-page-application routing uses the held root index
      // only for a valid miss. It never invents a module fetch handler.
      expect(await getHttps(loopbackPort, endpoint.output.hostname, "/client/route")).toMatchObject(
        {
          status: 200,
          body: new TextDecoder().decode(indexBytes),
        },
      );
      expect(
        await getHttps(loopbackPort, endpoint.output.hostname, "/assets/site.css", "HEAD"),
      ).toMatchObject({
        status: 200,
        body: "",
        contentType: "text/css",
      });
      expect(await getHttps(loopbackPort, endpoint.output.hostname, "/", "POST")).toMatchObject({
        status: 404,
      });
      const owner = await activeComposition.ownerForWorkerUid(workerUid);
      expect(
        await owner.observeServing({ workerResourceUid: workerUid, targetKey: TARGET }),
      ).toMatchObject({ kind: "serving" });
      const observedAssets = await sql.query(
        "SELECT observed_json FROM tf_v2_resources WHERE uid = ? LIMIT 2",
        [assetUid],
      );
      expect(observedAssets).toHaveLength(1);
      expect(observedAssets[0]?.observed_json).toBeString();
      const rows = await sql.query(
        "SELECT uid, generation, observed_generation, deleted_at FROM tf_v2_resources WHERE uid = ? AND form_url = ? LIMIT 2",
        [versionUid, WORKER_VERSION_FORM_URL],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ uid: versionUid, generation: 1, observed_generation: 1 });
      expect(rows[0]?.deleted_at).toBeNull();

      const codeBundleUid = await create(WORKER_BUNDLE_FORM_URL, "code-bundle", {
        artifact: { url: codeManifestUrl, sha256: sha256(codeManifestBytes) },
      });
      const publishCodeWorker = async (name: string, runWorkerFirst: boolean) => {
        const codeWorkerUid = await create(MODULE_WORKER_FORM_URL, `${name}-worker`, {});
        const codeVersionUid = await create(WORKER_VERSION_FORM_URL, `${name}-version`, {
          worker: { resourceUid: codeWorkerUid },
          bundle: { resourceUid: codeBundleUid },
          handlers: ["fetch"],
          vars: {},
          requiredSensitiveVars: [],
          assets: {
            bundle: { resourceUid: assetUid },
            runWorkerFirst,
            notFoundHandling: runWorkerFirst ? "single_page_application" : "none",
          },
        });
        await create(WORKER_DEPLOYMENT_FORM_URL, `${name}-deployment`, {
          worker: { resourceUid: codeWorkerUid },
          versions: [{ workerVersion: { resourceUid: codeVersionUid }, weight: 10_000 }],
        });
        const codeEndpointUid = await create(WORKER_ENDPOINT_FORM_URL, `${name}-endpoint`, {
          worker: { resourceUid: codeWorkerUid },
        });
        const response = await http(`/resources/${codeEndpointUid}`);
        expect(response.status).toBe(200);
        const codeEndpoint = (await response.json()) as {
          output: { hostname: string; url: string };
          observed: { tlsReady: boolean; activeDeploymentRouteReady: boolean };
        };
        expect(codeEndpoint.observed).toEqual({
          tlsReady: true,
          activeDeploymentRouteReady: true,
        });
        return {
          workerUid: codeWorkerUid,
          endpointUid: codeEndpointUid,
          hostname: codeEndpoint.output.hostname,
          owner: await activeComposition.ownerForWorkerUid(codeWorkerUid),
        };
      };
      const assetsFirst = await publishCodeWorker("assets-first", false);
      const assetsFirstServing = await assetsFirst.owner.observeServing({
        workerResourceUid: assetsFirst.workerUid,
        targetKey: TARGET,
      });
      expect(assetsFirstServing).toMatchObject({ kind: "serving" });
      if (assetsFirstServing.kind !== "serving") throw new Error("assets-first owner is unknown");
      const currentServingResolution =
        await activeComposition.endpointPublicationState.resolveCurrentServing({
          workerUid: assetsFirst.workerUid,
          targetKey: TARGET,
          sourceOperationId: assetsFirstServing.sourceOperationId,
          expectedIdentity: {
            generation: assetsFirstServing.generation,
            workerResourceUid: assetsFirstServing.workerResourceUid,
            hostnames: assetsFirstServing.hostnames,
            versions: assetsFirstServing.versions,
          },
        });
      expect(currentServingResolution).toMatchObject({ kind: "ready" });
      if (currentServingResolution.kind !== "ready") {
        throw new Error("native current serving resolution is not ready");
      }
      expect(currentServingResolution.snapshot.endpoint).toMatchObject({
        uid: assetsFirst.endpointUid,
        generation: 1,
        spec: { worker: { resourceUid: assetsFirst.workerUid } },
        output: { hostname: assetsFirst.hostname, url: `https://${assetsFirst.hostname}/` },
      });
      expect(await currentServingResolution.stillCurrent()).toBe(true);
      expect(
        await endpointFrontend.routeDenies({
          endpointUid: assetsFirst.endpointUid,
          workerUid: assetsFirst.workerUid,
          hostname: assetsFirst.hostname,
          url: `https://${assetsFirst.hostname}/`,
        }),
      ).toBe(false);
      const ownerAssetResponse = await assetsFirst.owner.fetch(
        new Request(`https://${assetsFirst.hostname}/assets/site.css`),
      );
      expect(ownerAssetResponse.status).toBe(200);
      expect(await ownerAssetResponse.text()).toBe(new TextDecoder().decode(cssBytes));
      expect(await getHttps(loopbackPort, assetsFirst.hostname, "/assets/site.css")).toMatchObject({
        status: 200,
        body: new TextDecoder().decode(cssBytes),
        contentType: "text/css",
      });
      expect(await getHttps(loopbackPort, assetsFirst.hostname, "/worker-ok")).toMatchObject({
        status: 200,
        body: "worker-ok",
      });
      expect(await getHttps(loopbackPort, assetsFirst.hostname, "/no-file")).toMatchObject({
        status: 404,
        body: "worker-404",
      });
      expect(await getHttps(loopbackPort, assetsFirst.hostname, "/", "POST")).toMatchObject({
        status: 200,
        body: "worker-post",
      });
      expect(
        await getHttps(loopbackPort, assetsFirst.hostname, "/assets/site.css", "HEAD"),
      ).toMatchObject({
        status: 200,
        body: "",
        contentType: "text/css",
      });

      const workerFirst = await publishCodeWorker("worker-first", true);
      const workerFirstServing = await workerFirst.owner.observeServing({
        workerResourceUid: workerFirst.workerUid,
        targetKey: TARGET,
      });
      expect(workerFirstServing).toMatchObject({ kind: "serving" });
      if (workerFirstServing.kind !== "serving") throw new Error("worker-first owner is unknown");
      expect(await getHttps(loopbackPort, workerFirst.hostname, "/assets/site.css")).toMatchObject({
        status: 200,
        body: new TextDecoder().decode(cssBytes),
        contentType: "text/css",
      });
      expect(await getHttps(loopbackPort, workerFirst.hostname, "/worker-ok")).toMatchObject({
        status: 200,
        body: "worker-ok",
      });
      expect(await getHttps(loopbackPort, workerFirst.hostname, "/client/route")).toMatchObject({
        status: 200,
        body: new TextDecoder().decode(indexBytes),
      });
      expect(await getHttps(loopbackPort, workerFirst.hostname, "/no-file")).toMatchObject({
        status: 200,
        body: new TextDecoder().decode(indexBytes),
      });
      expect(await getHttps(loopbackPort, workerFirst.hostname, "/", "POST")).toMatchObject({
        status: 200,
        body: "worker-post",
      });

      // The Workerd disk service is part of the exact serving graph. Removing
      // one declared execution copy makes owner readback unknown and the live
      // request cannot receive bytes that are no longer present.
      const workerKey = sha256(new TextEncoder().encode(workerFirst.workerUid));
      const publicationRoot = join(
        root,
        "v2-worker-owners",
        workerKey,
        "incarnations",
        workerFirstServing.sourceOperationId,
        "groups",
        workerKey,
        "workers",
        ".publications",
        `v2-worker-${workerKey}`,
      );
      const publicationGeneration = (await readdir(publicationRoot))[0];
      if (!publicationGeneration) throw new Error("native asset publication is missing");
      const nativeManifest = JSON.parse(
        await readFile(join(publicationRoot, publicationGeneration, "deployment.json"), "utf8"),
      ) as {
        versions: Array<{
          storageKey: string;
          manifest: { assets: { files: Record<string, { key: string }> } };
        }>;
      };
      const nativeVersion = nativeManifest.versions[0];
      const nativeAsset = nativeVersion && Object.values(nativeVersion.manifest.assets.files)[0];
      if (!nativeVersion || !nativeAsset) throw new Error("native asset inventory is missing");
      const nativeAssetPath = join(
        publicationRoot,
        publicationGeneration,
        nativeVersion.storageKey,
        "assets",
        nativeAsset.key,
      );
      const exactNativeAsset = await readFile(nativeAssetPath);
      await rm(nativeAssetPath);
      expect(
        await workerFirst.owner.observeServing({
          workerResourceUid: workerFirst.workerUid,
          targetKey: TARGET,
        }),
      ).toEqual({
        kind: "unknown",
      });
      expect(await getHttps(loopbackPort, workerFirst.hostname, "/assets/site.css")).toMatchObject({
        status: 503,
      });
      await writeFile(nativeAssetPath, exactNativeAsset, { mode: 0o600 });
      expect(
        await workerFirst.owner.observeServing({
          workerResourceUid: workerFirst.workerUid,
          targetKey: TARGET,
        }),
      ).toMatchObject({
        kind: "serving",
      });

      // Preserve the same-Worker UPDATE regression: a fresh Endpoint alone
      // does not exercise the stale route-qualification path found natively.
      const updatedVersionUid = await create(WORKER_VERSION_FORM_URL, "updated-code-version", {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: codeBundleUid },
        handlers: ["fetch"],
        vars: {},
        requiredSensitiveVars: [],
        assets: {
          bundle: { resourceUid: assetUid },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      });
      await updateDeployment(deploymentUid, workerUid, updatedVersionUid, 1);
      const updatedEndpointRead = await http(`/resources/${endpointUid}`);
      expect(updatedEndpointRead.status).toBe(200);
      const updatedEndpoint = (await updatedEndpointRead.json()) as {
        output: { hostname: string; url: string };
        observed: { tlsReady: boolean; activeDeploymentRouteReady: boolean };
      };
      const updatedRoute = await getHttps(loopbackPort, endpoint.output.hostname, "/worker-ok");
      if (
        updatedRoute.status !== 200 ||
        updatedRoute.body !== "worker-ok" ||
        updatedEndpoint.output.hostname !== endpoint.output.hostname ||
        updatedEndpoint.output.url !== endpoint.output.url ||
        updatedEndpoint.observed.activeDeploymentRouteReady !== true
      ) {
        throw new Error(
          `same-Worker Deployment update did not serve its accepted Version: ${JSON.stringify({
            endpointUid,
            deploymentUid,
            workerUid,
            routeStatus: updatedRoute.status,
            routeBody: updatedRoute.body,
            output: updatedEndpoint.output,
            observed: updatedEndpoint.observed,
          })}`,
        );
      }
    } catch (error) {
      testFailure = error;
    } finally {
      if (listener) {
        try {
          await listener.close(true);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (composition) {
        try {
          await composition.suspendOwnersRetainingCustody();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        database.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length === 0) {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          ...(tls ? [rm(tls.directory, { recursive: true, force: true })] : []),
        ]);
      }
    }
    if (testFailure !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError([testFailure, ...cleanupErrors], "native asset test cleanup failed");
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "native asset test cleanup failed");
    }
    if (testFailure !== undefined) throw testFailure;
  },
  120_000,
);
