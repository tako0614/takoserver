import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfhostFormAdmission } from "../scripts/selfhost-form-admission.ts";
import { buildApp } from "../src/app.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostEventTargets,
} from "../src/providers/selfhost.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import { createSelfhostQueuePump } from "../src/selfhost-queue-pump.ts";
import { createSelfhostWorkerScheduler } from "../src/selfhost-scheduler.ts";
import { createStandaloneProviderComposition } from "../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import type { TakoformV1Alpha3FormRef as FormRef } from "../src/takoform/types.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";
import { createSyntheticPublisherSetVerifier } from "./helpers/synthetic-publisher-set-verifier.ts";

// Native-only: run in an isolated network namespace with loopback enabled and
// port 443 free. WorkerEndpoint@0.1.0 promises HTTPS without a non-default port.
// The executor must verify the configured closed-graph binary's owner digest.
const WORKERD = process.env.TAKOSERVER_WORKERD_BINARY ?? null;
const HOST_ORIGIN = "https://api.takoserver.test";
const SUFFIX = "apps.selfhost.test";
const LANE = "/apis/forms.takoform.com/v1";
const SPACE = "default";
const SOURCE = "journey-source";
const DEAD = "journey-dead";
const KINDS = [
  "ModuleWorker",
  "EdgeKVNamespace",
  "AtLeastOnceQueue",
  "WorkerBundle",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
  "QueueConsumer",
] as const;

interface Observation {
  readonly id: string;
  readonly timestampMillis: number;
  readonly attempts: number;
  readonly queue: string;
  readonly body: string;
}

const TENANT = `async function readSeen(env) {
  const value = await env.KV.get("seen");
  return value === null ? [] : JSON.parse(new TextDecoder().decode(value));
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/send" && request.method === "POST") {
      return Response.json({ id: await env.QUEUE.send("public-api-retry") });
    }
    if (path === "/seen") return Response.json({ seen: await readSeen(env) });
    return Response.json({ ready: true });
  },
  async queue(batch, env) {
    const seen = await readSeen(env);
    for (const message of batch.messages) {
      seen.push({ id: message.id, timestampMillis: message.timestampMillis,
        attempts: message.attempts, queue: batch.queue, body: atob(message.body.data) });
    }
    await env.KV.put("seen", JSON.stringify(seen));
    for (const message of batch.messages) {
      if (batch.queue === "${SOURCE}") message.retry();
      else message.acknowledge();
    }
  },
};`;

test.skipIf(WORKERD === null)(
  "public Host resources deliver retries and a fresh dead-letter message through native HTTPS",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-host-http-queue-"));
    const children: ReturnType<typeof Bun.spawn>[] = [];
    let supervisor: ReturnType<typeof createWorkerdSupervisor> | undefined;
    let planes: ReturnType<typeof serveSelfhostDataPlanes> | undefined;
    try {
      const tls = await testCertificate(root);
      const sql = createEphemeralSql();
      const objects = createMemoryObjectStore();
      let millis = Date.now();
      const clock = () => new Date(millis);
      const access = createSelfhostDataPlaneAccess(root);
      planes = serveSelfhostDataPlanes({
        sql,
        grant: (script, versionId) => access.grant(script, versionId),
        databasePath: (name) => access.databasePath(name),
        objectRoot: join(root, "selfhost", "objects"),
        clock,
      });
      const activeSupervisor = createWorkerdSupervisor({
        binary: WORKERD,
        spawn(command) {
          const child = Bun.spawn([...command], {
            env: {},
            stdout: "ignore",
            stderr: "ignore",
          });
          children.push(child);
          return child;
        },
        async readiness() {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            try {
              const response = await tenantRequest(`probe.${SUFFIX}`, "/", tls.certificateChain);
              await response.text();
              return true;
            } catch {
              await new Promise<void>((resolve) => setTimeout(resolve, 50));
            }
          }
          return false;
        },
      });
      supervisor = activeSupervisor;
      const runtime = createWorkerdRuntime({
        root,
        binary: WORKERD,
        port: 443,
        tls,
        dataPlaneAddress: planes.address,
        isReady: () => activeSupervisor.isReady(),
        onReload: (configPath) => activeSupervisor.ensure(configPath),
      });
      const artifacts = createTakoformArtifacts({
        sql,
        objects,
        clock,
        randomId: () => crypto.randomUUID(),
      });
      const candidates = currentTakoformCandidates();
      const targets = createSelfhostEventTargets(root);
      const pump = createSelfhostQueuePump({ sql, runtime, targets, clock });
      const scheduler = createSelfhostWorkerScheduler({ sql, runtime, targets, clock });
      const composition = createStandaloneProviderComposition({
        mode: "stable-selfhost",
        stableForms: candidates.forms,
        edge: await buildEdgeForms(),
        dataRoot: root,
        runtime,
        workerRuntimeAvailable: true,
        workerEndpointSuffix: SUFFIX,
        workerEndpointScheme: "https",
        workerEndpointPort: 443,
        suffixes: [SUFFIX],
        dataPlaneAddress: planes.address,
        events: {
          forgetSchedules: (script, cron) => scheduler.forgetSchedules(script, cron),
        },
        artifacts: {
          manifest: (tenantId, digest) => artifacts.resolveManifest(tenantId, digest),
          async blob(digest) {
            const object = await objects.get(`art/${digest.slice("sha256:".length)}`);
            return object ? new Uint8Array(await new Response(object.body).arrayBuffer()) : null;
          },
        },
        now: clock(),
      });
      const app = buildApp({
        sql,
        objects,
        publicOrigin: HOST_ORIGIN,
        clock,
        forms: candidates.forms,
        bindings: candidates.bindings,
        hostForms: candidates.forms,
        hostBindings: candidates.bindings,
        ...composition,
        artifacts,
        identity: {
          async verify() {
            return {
              providerSubject: "queue-owner",
              email: "owner@example.test",
              displayName: "Owner",
            };
          },
        },
        settlement: {
          async verify() {
            throw new Error("zero-cost self-host journey must not require external funding");
          },
        },
      });
      let auth: Record<string, string> = {};
      async function call<T>(
        method: string,
        path: string,
        status: number,
        body?: unknown,
        headers: Record<string, string> = {},
      ): Promise<T> {
        const response = await app.fetch(
          new Request(`${HOST_ORIGIN}${path}`, {
            method,
            headers: {
              ...auth,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        if (response.status !== status) {
          const error = (await response.json()) as { error?: { code?: string } };
          throw new Error(
            `${method} ${path}: expected ${status}, got ${response.status} (${error.error?.code ?? "unknown"})`,
          );
        }
        return (await response.json()) as T;
      }
      const session = await call<{ sessionToken: string }>("POST", "/v1/sessions", 200, {
        provider: "google",
        assertion: "synthetic-external-identity",
      });
      auth = { authorization: `Bearer ${session.sessionToken}` };
      const { organization } = await call<{ organization: { id: string } }>(
        "POST",
        "/v1/organizations",
        201,
        { name: "Queue journey" },
      );
      auth["takoform-organization"] = organization.id;
      // This seeds normal durable authority using real published package bytes.
      // The external verifier response and identity assertion are synthetic:
      // neither real Core/Sigstore nor Accounts/OIDC are qualified by this test.
      const seeded = await runSelfhostFormAdmission({
        organizationId: organization.id,
        space: SPACE,
        hostId: HOST_ORIGIN,
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: true,
        sql,
        objects,
        fetch: createSyntheticPublisherSetVerifier().fetch,
      });
      expect(seeded.applied?.status).toBe("converged");
      const discovery = await call<{ forms: { identity: { formRef: FormRef } }[] }>(
        "GET",
        `${LANE}/forms?space=${SPACE}`,
        200,
      );
      const forms = new Map(
        discovery.forms.map((form) => [form.identity.formRef.kind, form.identity.formRef]),
      );
      for (const kind of KINDS) {
        const expected = candidates.forms.find((form) => form.identity.formRef.kind === kind);
        expect(expected).toBeDefined();
        expect(forms.get(kind)).toEqual(expected?.identity.formRef);
      }
      const reference = (kind: string, name: string) => ({
        apiVersion: "edge.forms.takoform.com",
        kind,
        name,
      });
      async function apply(kind: string, name: string, spec: JsonObject) {
        const formRef = forms.get(kind);
        if (!formRef) throw new Error(`required Form missing: ${kind}`);
        const desired = {
          apiVersion: formRef.apiVersion,
          kind,
          form: { formRef },
          metadata: { name, space: SPACE },
          spec,
        };
        const { review } = await call<{ review: { prepareDigest: string } }>(
          "POST",
          `${LANE}/resources/prepare`,
          200,
          desired,
        );
        const query = new URLSearchParams({
          space: SPACE,
          definitionVersion: formRef.definitionVersion,
          schemaDigest: formRef.schemaDigest,
        });
        // PUT/GET return the resource itself; prepare/observe use an envelope.
        return await call<{ status: { outputs: JsonObject } }>(
          "PUT",
          `${LANE}/resources/${formRef.apiVersion}/${kind}/${name}?${query}`,
          201,
          { ...desired, review },
          { "idempotency-key": `${kind}-${name}-create`, "if-none-match": "*" },
        );
      }
      const moduleBytes = new TextEncoder().encode(TENANT);
      const moduleDigest = await bytesDigest(moduleBytes);
      const upload = await call<{ uploadId: string; missingBlobs: string[] }>(
        "POST",
        `${LANE}/artifacts/uploads`,
        201,
        {
          manifest: {
            apiVersion: "artifacts.takoform.com/v1alpha1",
            kind: "WorkerBundle",
            mainModule: "index.js",
            modules: [
              {
                name: "index.js",
                mediaType: "application/javascript+module",
                size: moduleBytes.byteLength,
                digest: moduleDigest,
              },
            ],
          },
        },
        { "idempotency-key": "queue-journey-upload" },
      );
      expect(upload.missingBlobs).toContain(moduleDigest);
      const uploaded = await app.fetch(
        new Request(
          `${HOST_ORIGIN}${LANE}/artifacts/uploads/${upload.uploadId}/blobs/${moduleDigest}`,
          {
            method: "PUT",
            headers: auth,
            body: moduleBytes,
          },
        ),
      );
      expect(uploaded.status).toBe(201);
      await uploaded.arrayBuffer();
      const artifact = await call<{ manifestDigest: string }>(
        "POST",
        `${LANE}/artifacts/uploads/${upload.uploadId}/commit`,
        201,
        undefined,
        { "idempotency-key": "queue-journey-upload-commit" },
      );
      await apply("ModuleWorker", "journey-worker", {});
      await apply("EdgeKVNamespace", "journey-cache", {});
      for (const queue of [SOURCE, DEAD]) {
        await apply("AtLeastOnceQueue", queue, {
          messageRetentionSeconds: 345_600,
          deliveryDelaySeconds: 0,
        });
      }
      await apply("WorkerBundle", "journey-bundle", { manifestDigest: artifact.manifestDigest });
      await apply("WorkerVersion", "journey-v1", {
        worker: reference("ModuleWorker", "journey-worker"),
        bundle: reference("WorkerBundle", "journey-bundle"),
        handlers: ["fetch", "queue"],
        requiredSensitiveVars: [],
        kvBindings: [{ name: "KV", resource: reference("EdgeKVNamespace", "journey-cache") }],
        queueProducerBindings: [{ name: "QUEUE", resource: reference("AtLeastOnceQueue", SOURCE) }],
      });
      await apply("WorkerDeployment", "journey-live", {
        worker: reference("ModuleWorker", "journey-worker"),
        versions: [{ workerVersion: reference("WorkerVersion", "journey-v1"), weight: 10_000 }],
      });
      const endpoint = await apply("WorkerEndpoint", "journey-endpoint", {
        worker: reference("ModuleWorker", "journey-worker"),
      });
      for (const queue of [SOURCE, DEAD]) {
        await apply("QueueConsumer", `${queue}-consumer`, {
          worker: reference("ModuleWorker", "journey-worker"),
          queue: reference("AtLeastOnceQueue", queue),
          ...(queue === SOURCE ? { deadLetterQueue: reference("AtLeastOnceQueue", DEAD) } : {}),
          maxBatchSize: 1,
          maxBatchTimeoutSeconds: 0,
          maxRetries: queue === SOURCE ? 1 : 0,
          retryDelaySeconds: 1,
          maxConcurrency: 1,
        });
      }
      const url = new URL(String(endpoint.status.outputs.url));
      expect(url.protocol).toBe("https:");
      expect(url.port).toBe("");
      expect(url.pathname).toBe("/");
      expect(endpoint.status.outputs.hostname).toBe(url.hostname);
      const ask = async (path: string, method = "GET") => {
        const response = await tenantRequest(url.hostname, path, tls.certificateChain, method);
        expect(response.status).toBe(200);
        return response;
      };
      const observed = async () =>
        ((await (await ask("/seen")).json()) as { seen: Observation[] }).seen;
      const accepted = (await (await ask("/send", "POST")).json()) as { id: string };
      expect(accepted.id).toMatch(/^[0-9a-f-]{36}$/u);
      await pump.tick();
      const first = await observed();
      const original: Observation = {
        id: accepted.id,
        timestampMillis: millis,
        attempts: 1,
        queue: SOURCE,
        body: "public-api-retry",
      };
      expect(first).toEqual([original]);
      millis += 999;
      await pump.tick();
      expect(await observed()).toEqual(first);
      millis += 1;
      // Which bounded tick sees the newly copied DLQ row is not an API promise.
      for (let attempt = 0; attempt < 3; attempt += 1) await pump.tick();
      const delivered = await observed();
      const source = delivered.filter((entry) => entry.queue === SOURCE);
      const dead = delivered.filter((entry) => entry.queue === DEAD);
      expect(source).toEqual([original, { ...original, attempts: 2 }]);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        timestampMillis: millis,
        attempts: 1,
        queue: DEAD,
        body: "public-api-retry",
      });
      expect(dead[0]?.id).not.toBe(accepted.id);
      expect(dead[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
      millis += 60_000;
      await pump.tick();
      expect(await observed()).toEqual(delivered);
    } finally {
      supervisor?.stop();
      await Promise.all(children.map((child) => child.exited));
      planes?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);

// Connect only to this isolated listener, but verify its actual certificate
// against the public output hostname. No system DNS/trust changes or TLS bypass.
function tenantRequest(
  hostname: string,
  path: string,
  ca: string,
  method = "GET",
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path,
        method,
        ca,
        headers: { host: hostname },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })),
        );
      },
    );
    request.setTimeout(1_000, () => request.destroy(new Error("native HTTPS request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function testCertificate(root: string) {
  const privateKeyPath = join(root, "test-key.pem");
  const certificatePath = join(root, "test-cert.pem");
  const process = Bun.spawn(
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
      "1",
      "-subj",
      "/CN=selfhost-queue-test",
      "-addext",
      `subjectAltName=DNS:*.${SUFFIX},IP:127.0.0.1`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await process.exited).toBe(0);
  await chmod(privateKeyPath, 0o600);
  await chmod(certificatePath, 0o600);
  return {
    privateKey: await readFile(privateKeyPath, "utf8"),
    certificateChain: await readFile(certificatePath, "utf8"),
  };
}
