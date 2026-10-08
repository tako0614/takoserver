import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFHOST_WORKER_DATA_SERVICE_MODULE } from "../src/providers/selfhost-data-service.ts";
import { SELFHOST_WORKER_EVENT_SERVICE_MODULE } from "../src/providers/selfhost-events.ts";
import {
  V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
  V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
} from "../src/providers/selfhost-v2-queue-transport.ts";
import {
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING,
  WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
  workerdV2PrivateWorkflowBindingName,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import {
  createWorkerdRuntime,
  readWorkerdSelectedActiveVersion,
  type WorkerdDeploymentPublication,
  type WorkerdSite,
  writeWorkerdPrivateExecution,
} from "../src/workerd-runtime.ts";

const encoder = new TextEncoder();
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const bindingName = workerdV2PrivateWorkflowBindingName(0);
const digest = `sha256:${"a".repeat(64)}` as const;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tss-wfclass-"));
  const brokerRoot = mkdtempSync(join(tmpdir(), "tss-wfbroker-"));
  roots.push(root, brokerRoot);
  chmodSync(brokerRoot, 0o700);
  const socketPath = join(brokerRoot, `${"b".repeat(22)}.sock`);
  servers.push(
    Bun.serve({
      unix: socketPath,
      fetch() {
        return new Response(null, { status: 204 });
      },
    }),
  );
  const generated = "__workflow_entry.js";
  const site: WorkerdSite = {
    directory: "worker",
    mainModule: "index.js",
    hostEntrypoint: generated,
    hostModules: [
      WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
      WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
    ],
    hostnames: [],
    workflowForward: {
      schema: "takoserver.v2-workflow-binding-forward@1",
      snapshotDigest: digest,
      bindings: [
        {
          publicName: "WORKFLOW",
          serviceName: bindingName,
          tenantId: "tenant-1",
          workflowResourceUid: "uid-DurableWorkflow-1",
          token: "c".repeat(64),
        },
      ],
    },
  };
  const hostModules = new Map(
    [
      WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
      WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
      generated,
    ].map((name) => [name, encoder.encode("export default {};")]),
  );
  return {
    root,
    site,
    modules: new Map([["index.js", encoder.encode("export default {};")]]),
    hostModules,
    runSocketPath: join(root, "run.sock"),
    companionAddress: "127.0.0.1:4666",
    workflowSourceEntrypoint: WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
    workflowBindings: [{ name: bindingName, socketPath }],
  };
}

test("guarded v2 Workflow class uses exact selected broker UDS without public ingress", async () => {
  const input = fixture();
  const configPath = await writeWorkerdPrivateExecution(input);
  const config = await readFile(configPath, "utf8");
  expect(config).toContain(`name = "${bindingName}"`);
  expect(config).toContain(`unix:${input.workflowBindings[0]?.socketPath}`);
  expect(config).toContain(
    `(name = "workflow-broker-0", external = (address = "unix:${input.workflowBindings[0]?.socketPath}", http = ()))`,
  );
  expect(config).toContain(`name = "${input.site.hostEntrypoint}"`);
  expect(config).toContain('globalOutbound = "deny"');
  expect(config).not.toContain('name = "router"');
});

test("guarded v2 Workflow class retains its selected Queue producer facade", async () => {
  const input = fixture();
  const site: WorkerdSite = {
    ...input.site,
    v2QueueProducerPlane: { address: "127.0.0.1:17779", token: `private.${"a".repeat(43)}` },
  };
  const config = await readFile(
    await writeWorkerdPrivateExecution({
      ...input,
      site,
      hostModules: new Map([
        ...input.hostModules,
        [SELFHOST_WORKER_DATA_SERVICE_MODULE, encoder.encode("export default {};")] as const,
      ]),
    }),
    "utf8",
  );
  expect(config).toContain(
    `(name = "${WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING}", service = "v2-queue-producer")`,
  );
  expect(config).toContain('name = "v2-queue-producer-origin"');
  expect(config).toContain('globalOutbound = "v2-queue-producer-deny"');
});

test("guarded Workflow class excludes event-only modules also listed by its generated entry", async () => {
  const input = fixture();
  const site: WorkerdSite = {
    ...input.site,
    hostModules: [
      ...(input.site.hostModules ?? []),
      SELFHOST_WORKER_EVENT_SERVICE_MODULE,
      V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
    ],
    events: { module: SELFHOST_WORKER_EVENT_SERVICE_MODULE, vars: [] },
    queueSettlement: {
      module: V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
      address: "127.0.0.1:17778",
      vars: [{ name: V2_QUEUE_SETTLEMENT_TOKEN_BINDING, kind: "text", value: "a".repeat(43) }],
    },
  };
  const config = await readFile(
    await writeWorkerdPrivateExecution({
      ...input,
      site,
      hostModules: new Map([
        ...input.hostModules,
        [SELFHOST_WORKER_EVENT_SERVICE_MODULE, encoder.encode("export default {};")] as const,
        [V2_QUEUE_SETTLEMENT_SERVICE_MODULE, encoder.encode("export default {};")] as const,
      ]),
    }),
    "utf8",
  );
  expect(config).not.toContain("queue-settlement-deny");
  expect(config).not.toContain("event-gate");
});

test("guarded v2 Workflow class rejects a legacy active wrapper or wrong broker", async () => {
  const legacy = fixture();
  await expect(
    writeWorkerdPrivateExecution({
      ...legacy,
      workflowSourceEntrypoint: "__legacy-workflow.js",
    }),
  ).rejects.toThrow();
  const missing = fixture();
  await expect(
    writeWorkerdPrivateExecution({ ...missing, workflowBindings: [] }),
  ).rejects.toThrow();
  const wrong = fixture();
  await expect(
    writeWorkerdPrivateExecution({
      ...wrong,
      workflowBindings: [{ name: bindingName, socketPath: join(wrong.root, "not-owned.sock") }],
    }),
  ).rejects.toThrow();
});

test("selected Version pins exact Workflow broker through injected config readback", async () => {
  const input = fixture();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "tss-wf-runtime-"));
  const serviceRoot = mkdtempSync(join("/tmp", "wfs-"));
  roots.push(runtimeRoot, serviceRoot);
  chmodSync(serviceRoot, 0o700);
  let serving: { identity: string; token: string } | undefined;
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (
        serving &&
        request.method === "POST" &&
        request.headers.get("host") === "runtime.selfhost-config.invalid" &&
        new URL(request.url).pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
        request.headers.get("x-takoserver-selfhost-runtime-config") === serving.token
      ) {
        return new Response(null, {
          status: 204,
          headers: { "x-takoserver-selfhost-config-identity": serving.identity },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  servers.push(probe);
  if (probe.port === undefined) throw new Error("probe unavailable");
  let reserved = 0;
  let released = 0;
  const site: WorkerdSite = {
    ...input.site,
    hostEntrypoint: WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
    hostModules: [WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE],
    generation: "generation-1",
    workerResourceUid: "uid-ModuleWorker-1",
    fetchHandler: true,
  };
  const publication: WorkerdDeploymentPublication = {
    generation: "generation-1",
    workerResourceUid: "uid-ModuleWorker-1",
    hostnames: [],
    versions: [
      {
        versionId: "version-1",
        workerVersionUid: "uid-WorkerVersion-1",
        weight: 10_000,
        site,
        modules: input.modules,
        hostModules: new Map(
          [...input.hostModules].filter(([name]) => name !== "__workflow_entry.js"),
        ),
      },
    ],
  };
  const binding = site.workflowForward?.bindings[0];
  if (!binding || !site.workflowForward) throw new Error("fixture unavailable");
  const runtime = createWorkerdRuntime({
    root: runtimeRoot,
    serviceBindingSocketDirectory: serviceRoot,
    port: probe.port,
    isReady: () => true,
    async onReload(path) {
      const config = await readFile(path, "utf8");
      const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      if (!identity || !token) throw new Error("probe config unavailable");
      serving = { identity, token };
    },
    workflowForwardSockets: () => [
      {
        script: "worker",
        workerResourceUid: publication.workerResourceUid,
        versionId: "version-1",
        workerVersionResourceUid: "uid-WorkerVersion-1",
        snapshotDigest: site.workflowForward?.snapshotDigest ?? digest,
        binding,
        socketPath: input.workflowBindings[0]?.socketPath ?? "",
      },
    ],
    workflowForwardLifecycle: {
      async reserve() {
        reserved += 1;
        return {
          async release() {
            released += 1;
          },
        };
      },
      activated() {
        return true;
      },
      isRestored() {
        return true;
      },
      uncertain() {},
    },
  });
  if (!runtime.publish) throw new Error("publish unavailable");
  await runtime.publish("worker", publication);
  const selected = await readWorkerdSelectedActiveVersion(runtimeRoot, "worker", {
    expectedWorkerResourceUid: publication.workerResourceUid,
    basisPoint: 0,
  });
  if (!selected) throw new Error("selected Version unavailable");
  const lease = await runtime.acquirePrivateServiceBindings({
    script: "worker",
    generation: selected.generation,
    generationKey: selected.generationKey,
    workerResourceUid: selected.workerResourceUid,
    versionId: selected.versionId,
    workerVersionUid: selected.workerVersionUid,
  });
  expect(lease.services).toEqual([]);
  expect(lease.workflowServices).toEqual([
    {
      name: binding.serviceName,
      publicName: binding.publicName,
      workflowResourceUid: binding.workflowResourceUid,
      token: binding.token,
      snapshotDigest: site.workflowForward.snapshotDigest,
      upstreamSocket: input.workflowBindings[0]?.socketPath ?? "",
    },
  ]);
  expect(reserved).toBe(2);
  expect(released).toBe(1);
  await lease.release();
  expect(released).toBe(2);
});
