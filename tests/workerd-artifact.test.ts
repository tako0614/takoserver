import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceName,
} from "../src/provider-worker-endpoint-origin.ts";
import {
  selectClosedGraphWorkerd,
  WORKERD_CLOSED_GRAPH_ARTIFACT,
} from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import { assertIsolatedSelfhostNativeEnvironment } from "./helpers/isolated-selfhost-native.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const HTTPS_DIAGNOSTIC_SUFFIX = "apps.queue-process-restart.test";
const HTTPS_DIAGNOSTIC_TENANT_REF = "queue-https-shape-diagnostic";
const HTTPS_DIAGNOSTIC_SPACE = "default";
const HTTPS_DIAGNOSTIC_WORKER_NAME = "queue-restart-worker";
const HTTPS_DIAGNOSTIC_PORT = 443;
const HTTPS_DIAGNOSTIC_TIMEOUT_MS = 2_000;
// Mirrors the Queue restart journey's source, data bindings, and event-gate
// capability; this diagnostic only requests `/` and publishes no Consumer.
const HTTPS_DIAGNOSTIC_MODULE = `async function seen(env) {
  const value = await env.KV.get("seen");
  return value === null ? [] : JSON.parse(new TextDecoder().decode(value));
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/send" && request.method === "POST") {
      return Response.json({ id: await env.QUEUE.send("host-process-restart") });
    }
    if (path === "/seen") return Response.json({ seen: await seen(env) });
    if (path === "/object") {
      const object = await env.BUCKET.get("queue-recovery/effect");
      return object === null ? new Response(null, { status: 404 }) : new Response(object.body);
    }
    return Response.json({ ready: true });
  },
  async queue(batch, env) {
    const observed = await seen(env);
    for (const message of batch.messages) {
      observed.push({ id: message.id, attempts: message.attempts });
      if (message.attempts === 1) {
        await env.BUCKET.put("queue-recovery/effect", "persisted-before-unknown-ack");
      } else if (await env.BUCKET.get("queue-recovery/effect") === null) {
        throw new Error("object did not survive Host restart");
      }
    }
    await env.KV.put("seen", JSON.stringify(observed));
    for (const message of batch.messages) message.acknowledge();
  },
};`;
const HTTPS_DIAGNOSTIC_RESPONSE_BODY = '{"ready":true}';
const HTTPS_DIAGNOSTIC_PHASES = [
  "fixture",
  "publication",
  "supervisor_ready",
  "rendered_proof",
  "probe",
  "client_handshake",
  "http_response",
  "cleanup",
  "outcome",
] as const;
const HTTPS_DIAGNOSTIC_MILESTONES = ["tcp", "tls", "headers", "first_byte", "end"] as const;
const HTTPS_DIAGNOSTIC_OUTCOMES = [
  "ok",
  "error",
  "timeout",
  "idle_timeout",
  "wall_timeout",
  "tls_error",
  "transport_error",
  "not_reached",
  "status_200",
  "status_other",
  "removed",
  "retained",
] as const;
type HttpsDiagnosticPhase = (typeof HTTPS_DIAGNOSTIC_PHASES)[number];
type HttpsDiagnosticMilestone = (typeof HTTPS_DIAGNOSTIC_MILESTONES)[number];

test("projects a representative self-host Worker endpoint under the diagnostic certificate wildcard", async () => {
  const hostname = await projectedDiagnosticWorkerHostname();
  const labels = hostname.split(".");

  expect(labels).toHaveLength(4);
  expect(labels[0]).toMatch(/^sw-[0-9a-f]{40}$/u);
  expect(labels.slice(1).join(".")).toBe(HTTPS_DIAGNOSTIC_SUFFIX);
  expect(canonicalWorkerEndpointOrigin(labels[0] as string, HTTPS_DIAGNOSTIC_SUFFIX)).toBe(
    `https://${hostname}`,
  );
});

test("compiles the Queue diagnostic module with its r5 data-plane and event-gate composition", async () => {
  const hostname = await projectedDiagnosticWorkerHostname();
  const graph = compileHttpsDiagnosticGraph(hostname);

  expect(graph.site.hostEntrypoint).toBeDefined();
  expect(graph.site.hostnames).toEqual([hostname]);
  expect(graph.site.dataPlane).toEqual({
    address: "127.0.0.1:9",
    module: "__takoserver-selfhost-data.js",
    vars: [
      { name: "__TAKOSERVER_SELFHOST_DATA_TOKEN", value: "diagnostic-only-token", kind: "text" },
    ],
  });
  expect(graph.hostModules.has("__takoserver-selfhost-data.js")).toBe(true);
  const entrypoint = new TextDecoder().decode(
    graph.hostModules.get("__takoserver-selfhost-entrypoint.js"),
  );
  expect(entrypoint).toContain(
    '"bindings":[{"kind":"edge.kv@1.0.0","publicName":"KV"},{"kind":"edge.objects@1.0.0","publicName":"BUCKET"},{"kind":"edge.queue@1.0.0","publicName":"QUEUE"}]',
  );
  expect(graph.site.events).toEqual({
    module: "__takoserver-selfhost-events.js",
    vars: [
      {
        name: "__TAKOSERVER_SELFHOST_EVENT_TOKEN",
        value: "diagnostic-only-event-token",
        kind: "text",
      },
    ],
  });
  expect(graph.hostModules.has("__takoserver-selfhost-events.js")).toBe(true);
  expect(entrypoint).toContain("takoserverSelfhostEvents");
  expect(graph.site.serviceBindings).toBeUndefined();
  expect(graph.site.vars).toBeUndefined();

  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-event-graph-"));
  try {
    const runtime = createWorkerdRuntime({ root, port: HTTPS_DIAGNOSTIC_PORT });
    await runtime.write(
      "https-diagnostic",
      graph.site,
      graph.modules,
      graph.assets,
      graph.hostModules,
    );
    await runtime.reload();
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('( name = "https-diagnostic-selfhost-events"');
    expect(config).toContain("__takoserver-selfhost-events.js");
    expect(config).toContain("https-diagnostic.selfhost-events.invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not select an implicit package runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-"));
  try {
    expect(await selectClosedGraphWorkerd({ binary: undefined, privateRoot: root })).toEqual({
      binary: null,
      diagnostic: "TAKOSERVER_WORKERD_BINARY is not configured; Worker execution is disabled",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a runnable binary whose immutable digest is not the owner pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-"));
  try {
    const selected = await selectClosedGraphWorkerd({ binary: "/bin/bash", privateRoot: root });
    expect(selected.binary).toBeNull();
    expect(selected.diagnostic).toContain(WORKERD_CLOSED_GRAPH_ARTIFACT.sha256);
    expect(selected.diagnostic).toContain("digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(nativeEvidenceBinary("workerd-artifact") === undefined)(
  "selects the pinned artifact only after its real closed-graph capability executes",
  async () => {
    const binary = nativeEvidenceBinary("workerd-artifact") as string;
    const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-"));
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: root,
      });
      expect(selected.diagnostic).toBeNull();
      expect(selected.binary).not.toBe(binary);
      expect(selected.binary?.startsWith(root)).toBe(true);
      const selectedBytes = await Bun.file(selected.binary as string).arrayBuffer();
      expect(createHash("sha256").update(new Uint8Array(selectedBytes)).digest("hex")).toBe(
        WORKERD_CLOSED_GRAPH_ARTIFACT.sha256,
      );
      expect((await stat(selected.binary as string)).mode & 0o777).toBe(0o500);
      expect((await stat(dirname(selected.binary as string))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(nativeEvidenceBinary("workerd-artifact") === undefined)(
  "later inspection executes the selected byte identity after the configured path is replaced",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-replacement-"));
    const configured = join(root, "configured-workerd");
    const marker = join(root, "substituted-binary-ran");
    let running: ReturnType<typeof Bun.spawn> | undefined;
    let supervisor: ReturnType<typeof createWorkerdSupervisor> | undefined;
    try {
      await copyFile(nativeEvidenceBinary("workerd-artifact") as string, configured);
      await chmod(configured, 0o700);
      const selected = await selectClosedGraphWorkerd({
        binary: configured,
        privateRoot: join(root, "private"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "workerd was not selected");

      const replacement = join(root, "replacement");
      await writeFile(replacement, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 97\n`, {
        encoding: "utf8",
        mode: 0o700,
      });
      await rename(replacement, configured);

      const bytes = new TextEncoder().encode(
        `export default { fetch() { return new Response("artifact snapshot served"); } };`,
      );
      const result = await createWorkerdWorkerModuleInspector({
        repositoryRoot: resolve(import.meta.dir, ".."),
        binary: selected.binary,
      }).inspect({
        mainModule: "worker.mjs",
        modules: [
          {
            name: "worker.mjs",
            mediaType: "application/javascript+module",
            bytes,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        ],
        declaredHandlers: ["fetch"],
      });
      expect(result).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });

      const reserved = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const port = Number(reserved.port);
      reserved.stop(true);
      supervisor = createWorkerdSupervisor({
        binary: selected.binary,
        spawn: (command) => {
          running = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
          return running;
        },
        readiness: async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/`, {
                headers: { host: "artifact.localhost" },
                signal: AbortSignal.timeout(250),
              });
              if (response.status >= 100) return true;
            } catch {
              await new Promise<void>((wake) => setTimeout(wake, 50));
            }
          }
          return false;
        },
      });
      const runtime = createWorkerdRuntime({
        root: join(root, "runtime"),
        binary: selected.binary,
        port,
        isReady: () => supervisor?.isReady() === true,
        onReload: (configPath) => supervisor?.ensure(configPath) ?? Promise.resolve(),
      });
      await runtime.write(
        "artifact",
        {
          directory: "artifact",
          mainModule: "worker.mjs",
          hostnames: ["artifact.localhost"],
        },
        new Map([["worker.mjs", bytes]]),
      );
      await runtime.reload();
      expect(
        await (
          await fetch(`http://127.0.0.1:${port}/`, {
            headers: { host: "artifact.localhost" },
          })
        ).text(),
      ).toBe("artifact snapshot served");
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(selected.binary).not.toBe(configured);
    } finally {
      supervisor?.stop();
      await running?.exited.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

const HTTPS_DIAGNOSTIC_WORKERD = nativeEvidenceBinary("workerd-artifact") ?? null;

test.skipIf(HTTPS_DIAGNOSTIC_WORKERD === null)(
  "diagnoses one TLS request to a rendered Worker on the isolated default port",
  async () => {
    type Outcome = (typeof HTTPS_DIAGNOSTIC_OUTCOMES)[number];
    type Child = ReturnType<typeof Bun.spawn>;

    const phases: Record<HttpsDiagnosticPhase, Outcome> = {
      fixture: "not_reached",
      publication: "not_reached",
      supervisor_ready: "not_reached",
      rendered_proof: "not_reached",
      probe: "not_reached",
      client_handshake: "not_reached",
      http_response: "not_reached",
      cleanup: "not_reached",
      outcome: "not_reached",
    };
    const mark = (phase: HttpsDiagnosticPhase, outcome: Outcome): void => {
      phases[phase] = outcome;
    };
    let root: string | undefined;
    let child: Child | undefined;
    let supervisor: ReturnType<typeof createWorkerdSupervisor> | undefined;
    let primaryFailure: string | undefined;
    let responseStatus: number | null = null;
    let preserveFixture = false;
    let activePhase: HttpsDiagnosticPhase = "fixture";
    const milestones: Record<HttpsDiagnosticMilestone, "not_reached" | "ok"> = {
      tcp: "not_reached",
      tls: "not_reached",
      headers: "not_reached",
      first_byte: "not_reached",
      end: "not_reached",
    };
    let hostname: string | undefined;

    try {
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [HTTPS_DIAGNOSTIC_PORT],
      });
      root = await mkdtemp(join(tmpdir(), "takoserver-workerd-https-diagnostic-"));
      await chmod(root, 0o700);
      // The literal hostname from the earlier r5 run was not retained. Derive
      // a representative through the same provider-owned script-name and
      // endpoint-origin projections, with a synthetic tenant reference.
      const diagnosticHostname = await projectedDiagnosticWorkerHostname();
      hostname = diagnosticHostname;
      const tls = await createHttpsDiagnosticTls(root, HTTPS_DIAGNOSTIC_SUFFIX);
      mark("fixture", "ok");

      supervisor = createWorkerdSupervisor({
        binary: HTTPS_DIAGNOSTIC_WORKERD,
        spawn: (command) => {
          child = Bun.spawn([...command], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          return child;
        },
        readiness: async () => {
          if (!child || !(await waitForHttpsDiagnosticListener(child))) {
            mark("supervisor_ready", "timeout");
            return false;
          }
          mark("supervisor_ready", "ok");
          return true;
        },
      });
      const runtime = createWorkerdRuntime({
        root: join(root, "runtime"),
        binary: HTTPS_DIAGNOSTIC_WORKERD,
        port: HTTPS_DIAGNOSTIC_PORT,
        tls,
        isReady: () => supervisor?.isReady() === true,
        onReload: async (configPath) => {
          activePhase = "supervisor_ready";
          await supervisor?.ensure(configPath);
          if (!supervisor?.isReady()) throw new Error("https_diagnostic_supervisor_unready");
          activePhase = "rendered_proof";
        },
      });

      activePhase = "publication";
      const graph = compileHttpsDiagnosticGraph(diagnosticHostname);
      await runtime.write(
        "https-diagnostic",
        graph.site,
        graph.modules,
        graph.assets,
        graph.hostModules,
      );
      mark("publication", "ok");
      activePhase = "rendered_proof";
      await runtime.reload();
      mark("rendered_proof", "ok");

      activePhase = "probe";
      if (!child) throw new Error("https_diagnostic_workerd_child_missing");
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: child });
      mark("probe", "ok");

      activePhase = "client_handshake";
      const response = await requestHttpsDiagnosticOnce(
        tls.certificateChain,
        diagnosticHostname,
        (milestone) => {
          milestones[milestone] = "ok";
          if (milestone === "tls") {
            mark("client_handshake", "ok");
            activePhase = "http_response";
          }
        },
      );
      responseStatus = response.status;
      mark("http_response", response.status === 200 ? "status_200" : "status_other");
      if (response.status !== 200) throw new Error("https_diagnostic_response_status");
      if (response.body !== HTTPS_DIAGNOSTIC_RESPONSE_BODY) {
        throw new Error("https_diagnostic_response_body");
      }
      mark("outcome", "ok");
    } catch (error) {
      primaryFailure = classifyHttpsDiagnosticFailure(error, activePhase);
      if (phases[activePhase] === "not_reached") {
        mark(
          activePhase,
          primaryFailure.endsWith("wall_timeout")
            ? "wall_timeout"
            : primaryFailure.endsWith("idle_timeout")
              ? "idle_timeout"
              : primaryFailure.endsWith("timeout")
                ? "timeout"
                : primaryFailure.endsWith("tls_error")
                  ? "tls_error"
                  : primaryFailure.endsWith("transport_error")
                    ? "transport_error"
                    : "error",
        );
      }
      mark("outcome", "error");
    } finally {
      supervisor?.stop();
      let childExited = child === undefined;
      if (child) {
        const timeout = Symbol("cleanup-timeout");
        const exit = await Promise.race([child.exited, Bun.sleep(5_000).then(() => timeout)]);
        childExited = exit !== timeout;
      }

      if (root && childExited) {
        try {
          await rm(root, { recursive: true, force: true });
          mark("cleanup", "removed");
        } catch {
          preserveFixture = true;
          mark("cleanup", "retained");
        }
      } else if (root) {
        preserveFixture = true;
        mark("cleanup", "retained");
      } else {
        mark("cleanup", "removed");
      }
      if (preserveFixture && primaryFailure === undefined) {
        primaryFailure = "https_diagnostic_cleanup_unconfirmed";
        mark("outcome", "error");
      }
      const fields = HTTPS_DIAGNOSTIC_PHASES.map((phase) => `${phase}=${phases[phase]}`);
      fields.push(
        ...HTTPS_DIAGNOSTIC_MILESTONES.map((milestone) => `${milestone}=${milestones[milestone]}`),
      );
      fields.push(
        `hostname_shape=${hostname ? "representative_projected_worker_wildcard" : "not_reached"}`,
      );
      fields.push("graph=selfhost_compiled_queue_worker_data_plane_event_gate_no_consumer");
      fields.push(`http_status=${responseStatus ?? "none"}`);
      process.stdout.write(`[workerd-https-diagnostic] ${fields.join(" ")}\n`);
    }

    if (primaryFailure !== undefined) throw new Error(primaryFailure);
  },
  20_000,
);

test("HTTPS diagnostic wall deadline survives trickle and clears on settle", async () => {
  expect(
    classifyHttpsDiagnosticFailure(new Error("https_diagnostic_wall_timeout"), "client_handshake"),
  ).toBe("client_handshake_wall_timeout");

  const trickleTimers = createManualDeadlineScheduler();
  let aborted = false;
  let receivedChunks = 0;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const responseBody = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new Uint8Array([1]));
        receivedChunks += 1;
      },
    }),
  ).text();
  const trickledResponse = withAbsoluteDeadline(
    (registerAbort) => {
      registerAbort(() => {
        aborted = true;
        bodyController?.error(new Error("https_diagnostic_wall_timeout"));
      });
      return responseBody;
    },
    HTTPS_DIAGNOSTIC_TIMEOUT_MS,
    trickleTimers.scheduler,
  );
  expect(trickleTimers.scheduledDelay).toBe(HTTPS_DIAGNOSTIC_TIMEOUT_MS);
  // Multiple body chunks are activity, but the body has not completed.
  bodyController?.enqueue(new Uint8Array([2]));
  receivedChunks += 1;
  expect(receivedChunks).toBe(2);
  trickleTimers.fire();
  await expect(trickledResponse).rejects.toThrow("https_diagnostic_wall_timeout");
  expect(aborted).toBe(true);
  expect(trickleTimers.clearCount).toBe(1);

  const successTimers = createManualDeadlineScheduler();
  let successAborted = false;
  await expect(
    withAbsoluteDeadline(
      (registerAbort) => {
        registerAbort(() => {
          successAborted = true;
        });
        return Promise.resolve("response");
      },
      HTTPS_DIAGNOSTIC_TIMEOUT_MS,
      successTimers.scheduler,
    ),
  ).resolves.toBe("response");
  expect(successTimers.clearCount).toBe(1);
  successTimers.fire();
  expect(successAborted).toBe(false);

  const errorTimers = createManualDeadlineScheduler();
  let errorAborted = false;
  await expect(
    withAbsoluteDeadline(
      (registerAbort) => {
        registerAbort(() => {
          errorAborted = true;
        });
        return Promise.reject(new Error("https_diagnostic_request_failed"));
      },
      HTTPS_DIAGNOSTIC_TIMEOUT_MS,
      errorTimers.scheduler,
    ),
  ).rejects.toThrow("https_diagnostic_request_failed");
  expect(errorTimers.clearCount).toBe(1);
  errorTimers.fire();
  expect(errorAborted).toBe(false);
});

async function projectedDiagnosticWorkerHostname(): Promise<string> {
  const script = await derivedProviderResourceName("sw", {
    tenantRef: HTTPS_DIAGNOSTIC_TENANT_REF,
    space: HTTPS_DIAGNOSTIC_SPACE,
    name: HTTPS_DIAGNOSTIC_WORKER_NAME,
  });
  const origin = canonicalWorkerEndpointOrigin(script, HTTPS_DIAGNOSTIC_SUFFIX);
  if (origin === null) throw new Error("https_diagnostic_endpoint_projection_invalid");
  return new URL(origin).hostname;
}

function compileHttpsDiagnosticGraph(hostname: string) {
  const moduleBytes = new TextEncoder().encode(HTTPS_DIAGNOSTIC_MODULE);
  return compileWorkerdVersionGraph({
    directory: "https-diagnostic",
    mainModule: "worker.mjs",
    modules: new Map([["worker.mjs", moduleBytes]]),
    moduleMediaTypes: { "worker.mjs": "application/javascript+module" },
    hostnames: [hostname],
    generation: "https-diagnostic-generation",
    declaredHandlers: ["fetch", "queue"],
    readiness: {
      publication: "https-diagnostic-publication",
      probeHostname: "https-diagnostic.internal.invalid",
    },
    serviceBindings: [],
    environment: [],
    dataPlane: {
      address: "127.0.0.1:9",
      token: "diagnostic-only-token",
      bindings: [
        { kind: "edge.kv@1.0.0", publicName: "KV" },
        { kind: "edge.objects@1.0.0", publicName: "BUCKET" },
        { kind: "edge.queue@1.0.0", publicName: "QUEUE" },
      ],
    },
    eventToken: "diagnostic-only-event-token",
  });
}

async function createHttpsDiagnosticTls(
  root: string,
  suffix: string,
): Promise<{
  readonly privateKey: string;
  readonly certificateChain: string;
}> {
  const privateKeyPath = join(root, "worker-key.pem");
  const certificatePath = join(root, "worker-cert.pem");
  const generated = Bun.spawn(
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
      `/CN=*.${suffix}`,
      "-addext",
      `subjectAltName=DNS:*.${suffix}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await generated.exited) !== 0) {
    throw new Error("https_diagnostic_certificate_generation_failed");
  }
  await chmod(privateKeyPath, 0o600);
  await chmod(certificatePath, 0o600);
  return {
    privateKey: await Bun.file(privateKeyPath).text(),
    certificateChain: await Bun.file(certificatePath).text(),
  };
}

async function waitForHttpsDiagnosticListener(
  child: ReturnType<typeof Bun.spawn>,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: child });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connectTcp({ host: "127.0.0.1", port: HTTPS_DIAGNOSTIC_PORT });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          reject(new Error("https_diagnostic_listener_unavailable"));
        });
      });
      return true;
    } catch {
      await Bun.sleep(50);
    }
  }
  return false;
}

async function requestHttpsDiagnosticOnce(
  certificateAuthority: string,
  hostname: string,
  onMilestone: (milestone: HttpsDiagnosticMilestone) => void,
): Promise<{ readonly status: number; readonly body: string }> {
  return await withAbsoluteDeadline(
    (registerAbort) =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: HTTPS_DIAGNOSTIC_PORT,
            servername: hostname,
            path: "/",
            method: "GET",
            ca: certificateAuthority,
            headers: { host: hostname },
          },
          (response) => {
            onMilestone("headers");
            const chunks: Buffer[] = [];
            let received = 0;
            response.on("data", (chunk: Buffer) => {
              if (received === 0) onMilestone("first_byte");
              received += chunk.byteLength;
              if (received > 4_096) {
                response.destroy(new Error("https_diagnostic_response_too_large"));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            response.once("error", () => reject(new Error("https_diagnostic_response_error")));
            response.once("end", () => {
              onMilestone("end");
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        registerAbort(() => request.destroy(new Error("https_diagnostic_wall_timeout")));
        request.once("socket", (socket) => {
          socket.once("connect", () => onMilestone("tcp"));
          socket.once("secureConnect", () => onMilestone("tls"));
        });
        request.once("error", (error: NodeJS.ErrnoException) => {
          const safeCode =
            error.message === "https_diagnostic_wall_timeout"
              ? "wall_timeout"
              : error.message === "https_diagnostic_idle_timeout"
                ? "idle_timeout"
                : error.code === "ETIMEDOUT"
                  ? "timeout"
                  : error.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
                      error.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
                      error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
                    ? "tls_error"
                    : error.code === "ECONNREFUSED" || error.code === "ECONNRESET"
                      ? "transport_error"
                      : "error";
          reject(new Error(`https_diagnostic_client_${safeCode}`));
        });
        request.setTimeout(HTTPS_DIAGNOSTIC_TIMEOUT_MS, () => {
          request.destroy(new Error("https_diagnostic_idle_timeout"));
        });
        request.end();
      }),
    HTTPS_DIAGNOSTIC_TIMEOUT_MS,
  );
}

function classifyHttpsDiagnosticFailure(error: unknown, phase: HttpsDiagnosticPhase): string {
  if (error instanceof Error && error.message === "https_diagnostic_wall_timeout") {
    return `${phase}_wall_timeout`;
  }
  if (
    error instanceof Error &&
    /^https_diagnostic_client_(timeout|idle_timeout|wall_timeout|tls_error|transport_error|error)$/u.test(
      error.message,
    )
  ) {
    return `${phase}_${error.message.slice("https_diagnostic_client_".length)}`;
  }
  if (error instanceof Error && error.message === "https_diagnostic_response_status") {
    return "https_diagnostic_http_status_unexpected";
  }
  if (error instanceof Error && error.message === "https_diagnostic_response_body") {
    return "https_diagnostic_response_body_unexpected";
  }
  if (error instanceof Error && error.message === "https_diagnostic_cleanup_unconfirmed") {
    return error.message;
  }
  return `${phase}_error`;
}

interface DiagnosticDeadlineScheduler {
  schedule(callback: () => void, timeoutMillis: number): unknown;
  clear(handle: unknown): void;
}

function withAbsoluteDeadline<T>(
  operation: (registerAbort: (abort: () => void) => void) => Promise<T>,
  timeoutMillis: number,
  scheduler: DiagnosticDeadlineScheduler = {
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abort = (): void => undefined;
    let timer: unknown;
    timer = scheduler.schedule(() => {
      if (settled) return;
      settled = true;
      scheduler.clear(timer);
      try {
        abort();
      } catch {
        // The wall deadline still wins if request cancellation itself throws.
      }
      reject(new Error("https_diagnostic_wall_timeout"));
    }, timeoutMillis);

    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      scheduler.clear(timer);
      complete();
    };

    try {
      void operation((cancel) => {
        abort = cancel;
      }).then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function createManualDeadlineScheduler(): {
  readonly scheduler: DiagnosticDeadlineScheduler;
  readonly scheduledDelay: number | undefined;
  readonly clearCount: number;
  fire(): void;
} {
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let clears = 0;
  return {
    scheduler: {
      schedule(run, timeoutMillis) {
        callback = run;
        delay = timeoutMillis;
        return 1;
      },
      clear() {
        clears += 1;
        callback = undefined;
      },
    },
    get scheduledDelay() {
      return delay;
    },
    get clearCount() {
      return clears;
    },
    fire() {
      callback?.();
    },
  };
}
