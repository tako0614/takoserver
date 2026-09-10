import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderNativeReadbackDescriptor, ProviderOffering } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { createWorkerdRuntime, type WorkerdDeploymentPublication } from "../src/workerd-runtime.ts";

const EDGE_API = "edge.forms.takoform.com/v1beta1" as const;
const SCRIPT = "site";
const FORM_DIGEST = `sha256:${"a".repeat(64)}` as const;

function offering(kind: string): ProviderOffering {
  return {
    id: `selfhost.edge.${kind.toLowerCase()}`,
    kind: `takoform.${kind}`,
    displayName: kind,
    form: {
      apiVersion: EDGE_API,
      kind,
      definitionVersion: "0.1.0",
      schemaDigest: FORM_DIGEST,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"],
  };
}

function weightedPublication(): WorkerdDeploymentPublication {
  return {
    generation: "generation-1",
    workerResourceUid: "uid-ModuleWorker-site",
    hostnames: ["site.localhost"],
    versions: [
      {
        versionId: "site-v1",
        workerVersionUid: "uid-WorkerVersion-site",
        weight: 10_000,
        site: {
          directory: SCRIPT,
          mainModule: "index.js",
          hostEntrypoint: "__takoserver-host.js",
          hostnames: [],
          generation: "generation-1",
          workerResourceUid: "uid-ModuleWorker-site",
          fetchHandler: true,
        },
        modules: new Map([["index.js", new TextEncoder().encode("export default {}")]]),
        hostModules: new Map([
          [
            "__takoserver-host.js",
            new TextEncoder().encode('export { default } from "./index.js";'),
          ],
        ]),
      },
    ],
  };
}

function target() {
  return {
    tenantId: "org_demo",
    resourceUid: "uid-retained",
    incarnationId: "dep-retained",
    state: "retained" as const,
    generation: "1",
    updatedAt: Date.UTC(2026, 8, 8),
  };
}

function readbackDescriptors(
  local: ReturnType<typeof createSelfhostProvider>,
): readonly [
  ProviderOffering,
  ProviderNativeReadbackDescriptor,
  ProviderOffering,
  ProviderNativeReadbackDescriptor,
  ProviderOffering,
  ProviderNativeReadbackDescriptor,
] {
  if (!local.createNativeReadbackDescriptor) {
    throw new Error("self-host provider is missing native readback descriptor creation");
  }
  const moduleOffering = offering("ModuleWorker");
  const deploymentOffering = offering("WorkerDeployment");
  const endpointOffering = offering("WorkerEndpoint");
  const module = local.createNativeReadbackDescriptor({
    offering: moduleOffering,
    nativeId: `selfhost-worker:${SCRIPT}:delete`,
    identity: { tenantRef: "org_demo", space: "default", name: SCRIPT },
  });
  const deployment = local.createNativeReadbackDescriptor({
    offering: deploymentOffering,
    nativeId: `selfhost-deployment:${SCRIPT}:delete`,
    identity: { tenantRef: "org_demo", space: "default", name: "live" },
  });
  const endpoint = local.createNativeReadbackDescriptor({
    offering: endpointOffering,
    nativeId: `selfhost-endpoint:${SCRIPT}:site.localhost:delete`,
    identity: { tenantRef: "org_demo", space: "default", name: "endpoint" },
  });
  return [moduleOffering, module, deploymentOffering, deployment, endpointOffering, endpoint];
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-native-absence-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function publishScalar(runtime: ReturnType<typeof createWorkerdRuntime>) {
  const version = weightedPublication().versions[0];
  if (!version) throw new Error("publication fixture is unavailable");
  await runtime.write(
    SCRIPT,
    { ...version.site, hostnames: ["site.localhost"] },
    version.modules,
    undefined,
    version.hostModules,
  );
  await runtime.reload();
  return {
    manifest: await readFile(join(root, "workers", SCRIPT, "takoserver-site.json")),
    module: await readFile(join(root, "workers", SCRIPT, "application", "module-00000")),
  };
}

describe("self-host native absence after runtime unpublish", () => {
  test("proves ModuleWorker, Deployment, and Endpoint absent after weighted publish deletion", async () => {
    const runtime = createWorkerdRuntime({ root, isReady: () => true });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish(SCRIPT, weightedPublication());
    await runtime.publish(SCRIPT, null);

    const local = createSelfhostProvider({
      offerings: [],
      dataRoot: root,
      runtime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    if (!local.verifyNativeAbsence)
      throw new Error("self-host provider is missing native readback");
    const [moduleOffering, module, deploymentOffering, deployment, endpointOffering, endpoint] =
      readbackDescriptors(local);
    const actual = await Promise.all([
      local.verifyNativeAbsence({ offering: moduleOffering, descriptor: module, target: target() }),
      local.verifyNativeAbsence({
        offering: deploymentOffering,
        descriptor: deployment,
        target: target(),
      }),
      local.verifyNativeAbsence({
        offering: endpointOffering,
        descriptor: endpoint,
        target: target(),
      }),
    ]);
    expect({
      carrierDirectoryExists: existsSync(join(root, "workers", SCRIPT)),
      actual,
    }).toEqual({
      carrierDirectoryExists: false,
      actual: [
        {
          outcome: "absent",
          evidence: { provider: "local", kind: "ModuleWorker", state: "absent" },
        },
        {
          outcome: "absent",
          evidence: { provider: "local", kind: "WorkerDeployment", state: "absent" },
        },
        {
          outcome: "absent",
          evidence: { provider: "local", kind: "WorkerEndpoint", state: "absent" },
        },
      ],
    });
  });

  test("unpublishes a validated retained scalar Worker without restoring it on restart", async () => {
    const runtime = createWorkerdRuntime({ root, isReady: () => true });
    if (!runtime.publish) throw new Error("publication fixture is unavailable");
    const before = await publishScalar(runtime);
    expect(await runtime.has(SCRIPT)).toBe(true);

    await runtime.publish(SCRIPT, null);
    expect(existsSync(join(root, "workers", SCRIPT))).toBe(false);
    expect(await runtime.has(SCRIPT)).toBe(false);
    const restarted = createWorkerdRuntime({ root, isReady: () => true });
    expect(await restarted.restore()).toEqual([]);
    const retainedRoot = join(root, "workers", ".retired");
    const retained = await readdir(retainedRoot);
    expect(retained).toHaveLength(1);
    const carrier = join(retainedRoot, retained[0] as string, "publication");
    expect(await readFile(join(carrier, "takoserver-site.json"))).toEqual(before.manifest);
    expect(await readFile(join(carrier, "application", "module-00000"))).toEqual(before.module);
  });

  test("keeps a nonempty script carrier indeterminate instead of claiming absence", async () => {
    const scriptDirectory = join(root, "workers", SCRIPT);
    await mkdir(scriptDirectory, { recursive: true });
    await writeFile(join(scriptDirectory, "orphan"), "partial publication", "utf8");
    const runtime = createWorkerdRuntime({ root, isReady: () => true });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish(SCRIPT, null);
    expect(await readFile(join(scriptDirectory, "orphan"), "utf8")).toBe("partial publication");
    const local = createSelfhostProvider({
      offerings: [],
      dataRoot: root,
      runtime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    if (!local.verifyNativeAbsence)
      throw new Error("self-host provider is missing native readback");
    const [moduleOffering, module] = readbackDescriptors(local);
    expect(
      await local.verifyNativeAbsence({
        offering: moduleOffering,
        descriptor: module,
        target: target(),
      }),
    ).toEqual({ outcome: "unknown", reason: "malformed", retryable: false });
  });

  test("cleans a carrier after the first publication fails and retains its immutable snapshot", async () => {
    const runtime = createWorkerdRuntime({
      root,
      isReady: () => true,
      onReload: async () => {
        throw new Error("watcher rejected first graph");
      },
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await expect(runtime.publish(SCRIPT, weightedPublication())).rejects.toThrow(
      "worker runtime activation state is unknown",
    );

    expect(existsSync(join(root, "workers", SCRIPT))).toBe(false);
    const generations = await readdir(join(root, "workers", ".publications", SCRIPT));
    expect(generations).toHaveLength(1);
    const deployment = JSON.parse(
      await readFile(
        join(root, "workers", ".publications", SCRIPT, generations[0] as string, "deployment.json"),
        "utf8",
      ),
    ) as { generation?: string; versions?: readonly unknown[] };
    expect(deployment.generation).toBe("generation-1");
    expect(deployment.versions).toHaveLength(1);
  });
});
