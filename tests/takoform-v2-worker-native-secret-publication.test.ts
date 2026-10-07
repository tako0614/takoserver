import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import { referencesForWorkerVersion } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Backend, V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import {
  createInternalV2WorkerVersionForm,
  createV2CodeConfiguredInputReader,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "../src/takoform-v2/worker-version-configured-inputs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import { openWorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const configuredBinary = nativeEvidenceBinary("workerd-artifact") ?? null;
const targetKey = "native-v2-secret-publication-fixture";
const hostname = "native-v2.example.test";
const secret = "fixture-native-secret-sentinel";
const assetBytes = new TextEncoder().encode("native held asset");
const codeBytes = new TextEncoder().encode(
  "export default { fetch(request, env) { const path = new URL(request.url).pathname; return new Response(path === '/api' ? env.TOKEN + ':' + env.LABEL : 'worker fallback'); } };\n",
);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Local native owner/Workerd and loopback HTTP only. This does not qualify
// public HTTPS, normal Form registration, or OS-process owner recovery.

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test.skipIf(configuredBinary === null)(
  "accepted code+assets Version serves held bytes and private var through native owner without same-Operation reupload",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-worker-native-secret-"));
    const db = new Database(join(root, "state.sqlite"));
    const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
    let owner: Awaited<ReturnType<typeof openWorkerdWorkerRuntimeOwner>> | undefined;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary: configuredBinary as string,
        privateRoot: join(root, "selected-binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned workerd unavailable");
      migrateSqlite(db);
      const sql = createSqliteSql(db);
      const store = createV2Store(sql);
      let nowMs = Date.now();
      const now = () => new Date(nowMs++);
      let sourceAvailable = true;
      let sourceReads = 0;
      const assetManifestUrl = "https://artifacts.example.test/native/assets.json";
      const assetFileUrl = "https://artifacts.example.test/native/index.html";
      const codeManifestUrl = "https://artifacts.example.test/native/code.json";
      const codeFileUrl = "https://artifacts.example.test/native/index.mjs";
      const assetManifest = new TextEncoder().encode(
        JSON.stringify({
          files: [
            {
              path: "index.html",
              url: assetFileUrl,
              sha256: sha256(assetBytes),
              mediaType: "text/html",
            },
          ],
        }),
      );
      const codeManifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: codeFileUrl,
              sha256: sha256(codeBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const source = {
        async read({ url }: { url: string }) {
          sourceReads += 1;
          if (!sourceAvailable) throw new Error("fixture source is gone");
          if (url === assetManifestUrl) return assetManifest;
          if (url === assetFileUrl) return assetBytes;
          if (url === codeManifestUrl) return codeManifest;
          if (url === codeFileUrl) return codeBytes;
          throw new Error("unexpected source URL");
        },
      };
      const assetHost = createStaticAssetBundleHost({ sql, source, targetKey });
      const bundleHost = createWorkerBundleHost({ sql, source, targetKey });
      const publicationState = createV2WorkerPublicationState({
        sql,
        now,
        assetCustody: assetHost.custody,
        bundleCustody: bundleHost.custody,
      });
      const [configuredKey, transferKey, comparisonKey] = await Promise.all([
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
      ]);
      const sealer = createV2WorkerVersionConfiguredInputSealer({
        current: { keyId: "native-fixture", key: configuredKey },
        keyForDecryption: (id) => (id === "native-fixture" ? configuredKey : undefined),
      });
      const configuredInputs = createV2CodeConfiguredInputReader({
        sql,
        sealer,
        custody: { read: (identity) => readV2ConfiguredPrivateInputs(sql, identity) },
      });
      const inspector = createWorkerdWorkerModuleInspector({
        repositoryRoot: resolve(import.meta.dir, ".."),
        binary: selected.binary,
      });
      const ordinaryBackend: V2Backend = {
        id: "native-v2-fixture-support",
        targetKey,
        async execute(input) {
          return {
            kind: "complete" as const,
            observed:
              input.form === WORKER_ENDPOINT_FORM_URL
                ? { tlsReady: true, activeDeploymentRouteReady: true }
                : { ready: true },
            output: input.previousOutput,
          };
        },
        async reconcile(input) {
          return await this.execute(input);
        },
      };
      const form = (extra: Partial<V2Form> = {}): V2Form => ({
        validateCreate() {},
        validateUpdate() {},
        backend: ordinaryBackend,
        ...extra,
      });
      const versionForm = createInternalV2WorkerVersionForm({
        sql,
        targetKey,
        publicationState,
        retirement: { observeRetired: async () => ({ kind: "unknown" }) },
        inspectModule: inspector.inspect.bind(inspector),
        configuredInputSealer: sealer,
        configuredInputCustody: {
          read: (identity) => readV2ConfiguredPrivateInputs(sql, identity),
        },
      });
      const engine = createTakoformV2Engine({
        sql,
        now,
        replayWindowSeconds: 3600,
        leaseMilliseconds: 300_000,
        authorize: async () => true,
        privateInputCustody: {
          transfer: { current: { id: "native-transfer", key: transferKey } },
          comparison: { current: { id: "native-comparison", key: comparisonKey } },
          transferTtlSeconds: 300,
        },
        forms: {
          [MODULE_WORKER_FORM_URL]: form(),
          [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
          [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
          [WORKER_VERSION_FORM_URL]: versionForm,
          [WORKER_ENDPOINT_FORM_URL]: form({
            references: (spec) => [
              {
                resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
                formUrl: MODULE_WORKER_FORM_URL,
                readiness: "observed",
              },
            ],
            initialOutput: () => ({ hostname, url: `https://${hostname}/` }),
          }),
          [WORKER_DEPLOYMENT_FORM_URL]: form({
            references: (spec) => [
              {
                resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
                formUrl: MODULE_WORKER_FORM_URL,
                readiness: "observed",
              },
              ...(spec.versions as { workerVersion: { resourceUid: string } }[]).map(
                ({ workerVersion }) => ({
                  resourceUid: workerVersion.resourceUid,
                  formUrl: WORKER_VERSION_FORM_URL,
                  readiness: "ready" as const,
                  targetSpecMatch: {
                    path: ["worker", "resourceUid"],
                    equals: (spec.worker as { resourceUid: string }).resourceUid,
                  },
                }),
              ),
            ],
          }),
        },
      });
      const create = async (
        formUrl: string,
        name: string,
        spec: JsonObject,
        privateInputs?: Record<string, string>,
        settle = true,
      ) => {
        const accepted = await engine.acceptCreate({
          principal: "org-native",
          key: `native-create-${name}`,
          input: {
            form: formUrl,
            space: "production",
            name,
            spec,
            ...(privateInputs ? { privateInputs } : {}),
          },
        });
        if (settle)
          expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
        return accepted;
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const assets = await create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
        artifact: { url: assetManifestUrl, sha256: sha256(assetManifest) },
      });
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: codeManifestUrl, sha256: sha256(codeManifest) },
      });
      const versionSpec = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
        vars: { LABEL: "public-label" },
        requiredSensitiveVars: ["TOKEN"],
        assets: {
          bundle: { resourceUid: assets.resourceUid },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      };
      expect(referencesForWorkerVersion(parseWorkerVersionSpec(versionSpec))).toHaveLength(3);
      const version = await create(WORKER_VERSION_FORM_URL, "version", versionSpec, {
        TOKEN: secret,
      });
      const publicVersion = await engine.getResource({
        principal: "org-native",
        uid: version.resourceUid,
      });
      expect(JSON.stringify(publicVersion)).not.toContain(secret);
      await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.resourceUid },
      });
      sourceAvailable = false;
      const readsBeforePublication = sourceReads;
      const deployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "deployment",
        {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
        undefined,
        false,
      );
      const executionFor = async (operationId: string): Promise<V2Execution> => {
        const op = await store.operation(operationId);
        const resource = op && (await store.resource(op.resource_uid));
        if (!op || !resource) throw new Error("accepted Operation is unavailable");
        const token = `lease-${operationId}`;
        const claimAt = Date.now();
        expect(await store.claim(op.id, token, claimAt, claimAt + 300_000)).toBe(true);
        expect(await store.markDispatch(op.id, token, new Date(claimAt).toISOString())).toBe(true);
        return {
          operationId: op.id,
          leaseToken: token,
          backendKey: op.backend_key,
          backendId: op.backend_id,
          targetKey: op.target_key,
          resourceUid: resource.uid,
          principal: op.principal,
          action: op.action,
          generation: op.generation,
          form: resource.form_url,
          space: resource.space,
          name: resource.name,
          spec: JSON.parse(op.accepted_spec_json),
          previousObserved: JSON.parse(resource.observed_json),
          previousOutput: JSON.parse(resource.output_json),
        };
      };
      const execution = await executionFor(deployment.id);
      const ports = new Map<string, number>();
      owner = await openWorkerdWorkerRuntimeOwner({
        rootDirectory: join(root, "owner"),
        workerResourceUid: worker.resourceUid,
        targetKey,
        publicationState,
        configuredInputs,
        workerdBinary: selected.binary,
        inspectModule: inspector.inspect.bind(inspector),
        listenerPortForOperation: async (operationId) => {
          const port = await unusedPort();
          ports.set(operationId, port);
          return port;
        },
        spawn: (command) => {
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          children.push(child);
          return child;
        },
      });
      const activeOwner = owner;
      // Inject only the caller's lost ACK, after the actual owner/native write.
      await expect(
        (async () => {
          await activeOwner.execute(execution);
          throw new Error("fixture lost publication acknowledgement");
        })(),
      ).rejects.toThrow("fixture lost publication acknowledgement");
      const port = ports.get(deployment.id);
      if (!port) throw new Error("native listener was not allocated");
      const request = async (path: string) =>
        await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { host: hostname },
          signal: AbortSignal.timeout(3000),
        });
      expect(await (await request("/")).text()).toBe("native held asset");
      expect(await (await request("/api")).text()).toBe(`${secret}:public-label`);
      expect(sourceReads).toBe(readsBeforePublication);
      const processCount = children.length;
      const workerKey = sha256(new TextEncoder().encode(worker.resourceUid));
      const copies = join(
        root,
        "owner",
        workerKey,
        "incarnations",
        deployment.id,
        "groups",
        workerKey,
        "workers",
        ".publications",
        `v2-worker-${workerKey}`,
      );
      const generations = await readdir(copies);
      expect(generations).toHaveLength(1);
      const manifestPath = join(copies, generations[0] as string, "deployment.json");
      const beforeReplay = await stat(manifestPath, { bigint: true });
      expect(await owner.execute(execution)).toMatchObject({ kind: "confirmed" });
      expect(children).toHaveLength(processCount);
      expect(await readdir(copies)).toEqual(generations);
      const afterReplay = await stat(manifestPath, { bigint: true });
      expect([afterReplay.ino, afterReplay.mtimeNs]).toEqual([
        beforeReplay.ino,
        beforeReplay.mtimeNs,
      ]);
      expect(
        await owner.observeServing({ workerResourceUid: worker.resourceUid, targetKey }),
      ).toMatchObject({
        kind: "serving",
        sourceOperationId: deployment.id,
      });
      expect(
        await store.settle({
          id: deployment.id,
          token: execution.leaseToken,
          status: "succeeded",
          effect: "complete",
          at: now().toISOString(),
          retainUntil: new Date(Date.now() + 3600_000).toISOString(),
          observedJson: JSON.stringify({ ready: true, active: true }),
          outputJson: "{}",
        }),
      ).toBe(true);
      const deletion = await engine.acceptDelete({
        principal: "org-native",
        key: "native-delete-deployment",
        uid: deployment.resourceUid,
        expectedGeneration: 1,
      });
      const deleteExecution = await executionFor(deletion.id);
      expect(await owner.execute(deleteExecution)).toMatchObject({
        kind: "confirmed",
        identity: null,
      });
      expect(
        await owner.observeServing({ workerResourceUid: worker.resourceUid, targetKey }),
      ).toEqual({ kind: "unknown" });
      await expect(request("/api")).rejects.toThrow();
      expect(sourceReads).toBe(readsBeforePublication);
      await owner.close();
      owner = undefined;
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited.catch(() => undefined)));
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
