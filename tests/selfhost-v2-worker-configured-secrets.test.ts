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
import { createV2WorkerVersionConfiguredInputSealer } from "../src/takoform-v2/worker-version-configured-inputs.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";
const ORIGIN = "https://api.example.test";
const TARGET = "selfhost-v2-worker-primary";
const SENTINEL = "fixture-configured-secret-sentinel";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test.skipIf(binary === null)(
  "normal organization HTTP accepts a configured Worker secret and the native owner serves it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-secret-"));
    const database = new Database(join(root, "control.sqlite"));
    const children: WorkerdProcess[] = [];
    let closeOwner: (() => Promise<void>) | undefined;
    try {
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "secret-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({ actor, name: "Secret Worker Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "secret worker writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const bundleUrl = "https://artifacts.example.test/v2-secret/bundle.json";
      const moduleUrl = "https://artifacts.example.test/v2-secret/index.mjs";
      const code = new TextEncoder().encode(
        "export default { fetch(_request, env) { return new Response(env.TOKEN + ':' + env.LABEL); } };\n",
      );
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: moduleUrl,
              sha256: sha256(code),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      await objects.create("v2-secret/manifest", manifest);
      await objects.create("v2-secret/module", code);
      const grants = [{ principal: `org:${organization.id}`, space: organization.id }];
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x51),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: {
          targetKey: TARGET,
          heldArtifacts: [
            { url: bundleUrl, sha256: sha256(manifest), objectKey: "v2-secret/manifest", grants },
            { url: moduleUrl, sha256: sha256(code), objectKey: "v2-secret/module", grants },
          ],
        },
      };
      // These are deterministic fixture-only nonextractable keys, not operator state.
      const [configuredKey, transferKey, comparisonKey] = await Promise.all([
        crypto.subtle.importKey("raw", new Uint8Array(32).fill(0x61), "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
        crypto.subtle.importKey("raw", new Uint8Array(32).fill(0x62), "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
        crypto.subtle.importKey(
          "raw",
          new Uint8Array(32).fill(0x63),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      ]);
      const sealer = createV2WorkerVersionConfiguredInputSealer({
        current: { keyId: "fixture-configured", key: configuredKey },
        keyForDecryption: (id) => (id === "fixture-configured" ? configuredKey : undefined),
      });
      let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "v2-worker-owners"),
        targetKey: TARGET,
        workerdBinary: binary,
        configuredInputSealer: sealer,
        spawn(command) {
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          children.push(child);
          return child;
        },
        endpoint: {
          assignHostname({ resourceUid }) {
            return `worker-${resourceUid.slice(0, 8)}.example.test`;
          },
          async observeTls(input) {
            const owner = await composition.ownerForWorkerUid(input.workerUid);
            const serving = await owner.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
            };
          },
          async observeRouteAbsent(input) {
            const owner = await composition.ownerForWorkerUid(input.workerUid);
            const serving = await owner.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
            };
          },
        },
      });
      expect(await composition.restoreOwners()).toEqual([]);
      // The Host owns the sealer passed at boot, even if a caller mutates the
      // original object before the application composes its Form map.
      sealer.open = async () => null;
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
        v2PrivateInputCustody: {
          transfer: { current: { id: "fixture-transfer", key: transferKey } },
          comparison: { current: { id: "fixture-comparison", key: comparisonKey } },
          transferTtlSeconds: 300,
        },
      });
      const http = (
        path: string,
        method = "GET",
        body?: unknown,
        replayKey?: string,
        generation?: number,
      ) =>
        app.fetch(
          new Request(`${ORIGIN}${API}${path}`, {
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
      const create = async (
        form: string,
        name: string,
        spec: Record<string, unknown>,
        privateInputs?: Record<string, string>,
      ) => {
        const response = await http(
          "/resources",
          "POST",
          { form, space: organization.id, name, spec, ...(privateInputs ? { privateInputs } : {}) },
          `create-${name}-secret-worker`,
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
      const remove = async (uid: string, name: string) => {
        const response = await http(
          `/resources/${uid}`,
          "DELETE",
          undefined,
          `delete-${name}-secret-worker`,
          1,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
      };
      const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: bundleUrl, sha256: sha256(manifest) },
      });
      const versionSpec = {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: bundleUid },
        handlers: ["fetch"],
        vars: { LABEL: "public-label" },
        requiredSensitiveVars: ["TOKEN"],
      };
      const versionUid = await create(WORKER_VERSION_FORM_URL, "version", versionSpec, {
        TOKEN: SENTINEL,
      });
      const publicVersion = await http(`/resources/${versionUid}`);
      expect(publicVersion.status).toBe(200);
      expect(JSON.stringify(await publicVersion.json()).includes(SENTINEL)).toBe(false);
      const wrongSecret = await http(
        `/resources/${versionUid}`,
        "PUT",
        { spec: versionSpec, privateInputs: { TOKEN: "fixture-mismatch" } },
        "version-mismatch-secret-worker",
        1,
      );
      expect(wrongSecret.status).toBe(422);
      const sameSecret = await http(
        `/resources/${versionUid}`,
        "PUT",
        { spec: versionSpec, privateInputs: { TOKEN: SENTINEL } },
        "version-same-secret-worker",
        1,
      );
      expect(sameSecret.status).toBe(202);
      const sameOperation = (await sameSecret.json()) as { id: string; resourceUid: string };
      expect(sameOperation.resourceUid).toBe(versionUid);
      expect(await app.tickTakoformV2()).toMatchObject({
        id: sameOperation.id,
        status: "succeeded",
        effect: "complete",
      });
      const sameReplay = await http(
        `/resources/${versionUid}`,
        "PUT",
        { spec: versionSpec, privateInputs: { TOKEN: SENTINEL } },
        "version-same-secret-worker",
        1,
      );
      expect(sameReplay.status).toBe(200);
      expect(await sameReplay.json()).toMatchObject({ id: sameOperation.id });
      const omittedSecret = await http(
        `/resources/${versionUid}`,
        "PUT",
        { spec: versionSpec },
        "version-omitted-secret-worker",
        2,
      );
      expect(omittedSecret.status).toBe(202);
      const omittedOperation = (await omittedSecret.json()) as { id: string };
      expect(await app.tickTakoformV2()).toMatchObject({
        id: omittedOperation.id,
        status: "succeeded",
        effect: "complete",
      });
      const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const endpointUid = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: workerUid },
      });
      const endpoint = await http(`/resources/${endpointUid}`);
      expect(endpoint.status).toBe(200);
      const endpointResource = (await endpoint.json()) as { output: { hostname: string } };
      const owner = await composition.ownerForWorkerUid(workerUid);
      closeOwner = () => owner.close();
      const served = await owner.fetch(new Request(`https://${endpointResource.output.hostname}/`));
      expect(served.status).toBe(200);
      expect((await served.text()) === `${SENTINEL}:public-label`).toBe(true);
      await remove(endpointUid, "endpoint");
      await remove(deploymentUid, "deployment");
      const versionDelete = await http(
        `/resources/${versionUid}`,
        "DELETE",
        undefined,
        "delete-version-secret-worker",
        3,
      );
      expect(versionDelete.status).toBe(202);
      const versionDeleteOperation = (await versionDelete.json()) as { id: string };
      expect(await app.tickTakoformV2()).toMatchObject({
        id: versionDeleteOperation.id,
        status: "succeeded",
        effect: "complete",
      });
      await remove(bundleUid, "bundle");
      await remove(workerUid, "worker");
      await owner.close();
    } finally {
      await closeOwner?.().catch(() => undefined);
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
