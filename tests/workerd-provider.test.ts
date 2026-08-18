import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOffering } from "../src/provider-port.ts";
import { createWorkerdProvider } from "../src/providers/workerd.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * Running somebody's Worker on a machine you own is what makes a self-hosted
 * deployment a platform rather than a place to keep files. What matters here
 * is who gets served: a hostname nobody claimed must not reach whichever
 * script happens to be first, because that failure is silent and it is one
 * customer reading another customer's site.
 */

const WORKER: ProviderOffering = {
  id: "compute.worker.standard",
  kind: "worker_script",
  displayName: "Worker",
  form: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "WorkerVersion",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:22fde31c0b695ca59f5c46230c1ed03d6a6f53c01015d4a5acf6bdb0ed70b50c",
  },
  unit: "worker-month",
  unitPriceMinor: 1_500,
  protocols: [],
  capabilities: ["create", "update", "delete", "observe"],
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-workerd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function provider(
  options: { suffixes?: readonly string[]; modules?: Record<string, string> } = {},
) {
  const modules = options.modules ?? { "index.js": "export default {}" };
  const runtime = createWorkerdRuntime({ root });
  return createWorkerdProvider({
    offerings: [WORKER],
    runtime,
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    artifacts: {
      async manifest() {
        return {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: Object.keys(modules).map((name) => ({ name, digest: `sha256:${name}` })),
        };
      },
      async blob(digest) {
        const name = digest.slice("sha256:".length);
        const source = modules[name];
        return source === undefined ? null : new TextEncoder().encode(source);
      },
    },
  });
}

const identity = { tenantRef: "org_demo", space: "default", name: "hello" };

describe("running a Worker locally", () => {
  test("writes the modules and a config that names the host", async () => {
    const ticket = await provider().apply({
      operationId: "op_1",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: ["hello.test"] },
    });
    expect(ticket.phase).toBe("succeeded");

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    // The route table is a JSON string inside the config, so it appears escaped.
    expect(config).toContain("hello.test");
    expect(config).toContain(
      '(name = "org_demo-default-hello", service = "org_demo-default-hello")',
    );
    // Relative, because workerd resolves an embed against the config's own
    // directory and silently fails to read an absolute one.
    expect(config).toContain('embed "org_demo-default-hello/index.js"');
    expect(config).not.toContain(`embed "${root}`);
  });

  test("a republish replaces the modules rather than merging them", async () => {
    const first = provider({ modules: { "index.js": "a", "old.js": "b" } });
    await first.apply({
      operationId: "op_1",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: [] },
    });
    const second = provider({ modules: { "index.js": "a2" } });
    await second.apply({
      operationId: "op_2",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: [] },
    });
    // A module the new bundle does not contain must not survive, where it
    // would be loadable and wrong.
    const kept = await readFile(
      join(root, "workers", "org_demo-default-hello", "old.js"),
      "utf8",
    ).catch(() => null);
    expect(kept).toBeNull();
  });

  test("refuses a hostname this deployment does not serve", async () => {
    const ticket = await provider({ suffixes: ["mine.test"] }).apply({
      operationId: "op_1",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: ["somebody-else.test"] },
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("refuses a bundle whose modules the store cannot produce", async () => {
    const broken = createWorkerdProvider({
      offerings: [WORKER],
      runtime: createWorkerdRuntime({ root }),
      artifacts: {
        async manifest() {
          return {
            kind: "WorkerBundle",
            mainModule: "index.js",
            modules: [{ name: "index.js", digest: `sha256:${"f".repeat(64)}` }],
          };
        },
        async blob() {
          return null;
        },
      },
    });
    const ticket = await broken.apply({
      operationId: "op_1",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: [] },
    });
    // Otherwise it becomes a script that fails to start later, for reasons
    // nothing connects back to this apply.
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("a deleted script leaves the config and stops being observed", async () => {
    const local = provider();
    const created = await local.apply({
      operationId: "op_1",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: ["hello.test"] },
    });
    const nativeId = created.phase === "succeeded" ? created.result.nativeId : "";
    expect((await local.observe({ offering: WORKER, nativeId, identity, spec: {} })).phase).toBe(
      "succeeded",
    );

    await local.delete({ operationId: "op_2", offering: WORKER, nativeId, identity });
    expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).not.toContain(
      "hello.test",
    );
    expect((await local.observe({ offering: WORKER, nativeId, identity, spec: {} })).phase).toBe(
      "failed",
    );
  });

  test("skips a directory whose upload never finished", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await provider().apply({
      operationId: "op_1",
      offering: WORKER,
      identity,
      spec: { bundle: `sha256:${"c".repeat(64)}`, hostnames: ["hello.test"] },
    });
    // Modules present, manifest absent: a script that is still arriving.
    await mkdir(join(root, "workers", "half-written"), { recursive: true });
    await writeFile(join(root, "workers", "half-written", "index.js"), "export default {}");

    await createWorkerdRuntime({ root }).reload();
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    // Serving traffic from an incomplete upload is worse than not serving it.
    expect(config).not.toContain("half-written");
    expect(config).toContain("org_demo-default-hello");
  });
});
