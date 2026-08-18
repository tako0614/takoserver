import { describe, expect, test } from "bun:test";
import type { ProviderOffering } from "../src/provider-port.ts";
import type { WorkerdRuntime, WorkerdSite } from "../src/providers/workerd.ts";
import { createWorkerdProvider } from "../src/providers/workerd.ts";

/**
 * A Worker that declares a site has to be served one.
 *
 * The Cloudflare provider uploads an asset bundle and binds it; a self-hosted
 * deployment that skipped that would answer every path with the script, which
 * for anything routing on the client is a blank page. These say the bundle is
 * resolved, the files reach the runtime, and a declaration naming a bundle
 * that was never committed is refused rather than published empty.
 */

const OFFERING: ProviderOffering = {
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
  unitPriceMinor: 500,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};

function newProvider(manifests: Record<string, unknown>, blobs: Record<string, string> = {}) {
  const written: {
    name: string;
    site: WorkerdSite;
    modules: ReadonlyMap<string, Uint8Array>;
    assets?: ReadonlyMap<string, Uint8Array>;
  }[] = [];
  const runtime: WorkerdRuntime = {
    async write(name, site, modules, assets) {
      written.push({ name, site, modules, ...(assets ? { assets } : {}) });
    },
    async remove() {},
    async reload() {},
    async has() {
      return true;
    },
  };
  const provider = createWorkerdProvider({
    offerings: [OFFERING],
    runtime,
    artifacts: {
      async manifest(_tenant, digest) {
        return (manifests[digest] ?? null) as never;
      },
      async blob(digest) {
        const value = blobs[digest];
        return value === undefined ? null : new TextEncoder().encode(value);
      },
    },
  });
  return { provider, written };
}

const WORKER_BUNDLE = {
  kind: "WorkerBundle",
  mainModule: "index.js",
  modules: [{ name: "index.js", digest: "sha256:mod" }],
};

function apply(spec: Record<string, unknown>) {
  return {
    operationId: "op-1",
    offering: OFFERING,
    identity: { tenantRef: "ten_1", space: "default", name: "site" },
    spec: { bundle: "sha256:worker", ...spec },
  };
}

describe("a Worker that declares a site", () => {
  test("carries its files to the runtime", async () => {
    const { provider, written } = newProvider(
      {
        "sha256:worker": WORKER_BUNDLE,
        "sha256:site": {
          kind: "StaticAssetBundle",
          files: [
            { name: "index.html", digest: "sha256:html" },
            { name: "app.css", digest: "sha256:css" },
          ],
        },
      },
      { "sha256:mod": "export default {}", "sha256:html": "<html>", "sha256:css": "body{}" },
    );

    const ticket = await provider.apply(apply({ assets: { bundle: "sha256:site" } }));
    expect(ticket.phase).toBe("succeeded");
    expect([...(written[0]?.assets?.keys() ?? [])].sort()).toEqual(["app.css", "index.html"]);
    expect(written[0]?.site.assets).toEqual({ notFoundHandling: "single-page-application" });
  });

  test("keeps the handling the declaration asked for", async () => {
    const { provider, written } = newProvider(
      {
        "sha256:worker": WORKER_BUNDLE,
        "sha256:site": {
          kind: "StaticAssetBundle",
          files: [{ name: "index.html", digest: "sha256:html" }],
        },
      },
      { "sha256:mod": "export default {}", "sha256:html": "<html>" },
    );

    await provider.apply(
      apply({ assets: { bundle: "sha256:site", notFoundHandling: "404-page" } }),
    );
    expect(written[0]?.site.assets).toEqual({ notFoundHandling: "404-page" });
  });

  test("declares no assets when it declared none", async () => {
    const { provider, written } = newProvider(
      { "sha256:worker": WORKER_BUNDLE },
      { "sha256:mod": "export default {}" },
    );

    const ticket = await provider.apply(apply({}));
    expect(ticket.phase).toBe("succeeded");
    expect(written[0]?.site.assets).toBeUndefined();
    expect(written[0]?.assets).toBeUndefined();
  });

  test("refuses a bundle that is not a committed asset bundle", async () => {
    const { provider, written } = newProvider(
      { "sha256:worker": WORKER_BUNDLE, "sha256:site": WORKER_BUNDLE },
      { "sha256:mod": "export default {}" },
    );

    const ticket = await provider.apply(apply({ assets: { bundle: "sha256:site" } }));
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    // Nothing is published from a declaration that cannot be satisfied.
    expect(written).toHaveLength(0);
  });

  test("refuses when a declared file is missing, rather than serving a partial site", async () => {
    const { provider, written } = newProvider(
      {
        "sha256:worker": WORKER_BUNDLE,
        "sha256:site": {
          kind: "StaticAssetBundle",
          files: [
            { name: "index.html", digest: "sha256:html" },
            { name: "gone.css", digest: "sha256:gone" },
          ],
        },
      },
      { "sha256:mod": "export default {}", "sha256:html": "<html>" },
    );

    const ticket = await provider.apply(apply({ assets: { bundle: "sha256:site" } }));
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(written).toHaveLength(0);
  });
});

describe("the configuration a site produces", () => {
  test("gives the script an ASSETS binding backed by a disk service at an absolute path", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createWorkerdRuntime } = await import("../src/workerd-runtime.ts");

    const root = await mkdtemp(join(tmpdir(), "workerd-assets-"));
    const runtime = createWorkerdRuntime({ root, port: 9999 });
    await runtime.write(
      "site",
      {
        directory: "site",
        mainModule: "index.js",
        hostnames: ["site.test"],
        assets: { notFoundHandling: "single-page-application" },
      },
      new Map([["index.js", new TextEncoder().encode("export default {}")]]),
      new Map([["index.html", new TextEncoder().encode("<html>")]]),
    );
    await runtime.reload();

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('(name = "ASSETS", service = "site-assets")');
    expect(config).toContain('name = "site-assets-files"');
    // A disk path is resolved against the process's working directory, not
    // against this file the way an embed is. Relative would find nothing.
    expect(config).toContain(`path = "${join(root, "workers", "site", "__assets")}"`);
    expect(config).toContain('(name = "NOT_FOUND", text = "single-page-application")');

    const served = await readFile(join(root, "workers", "site", "__assets", "index.html"), "utf8");
    expect(served).toBe("<html>");
  });

  test("a script with no site gets no binding and no disk service", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createWorkerdRuntime } = await import("../src/workerd-runtime.ts");

    const root = await mkdtemp(join(tmpdir(), "workerd-plain-"));
    const runtime = createWorkerdRuntime({ root, port: 9999 });
    await runtime.write(
      "plain",
      { directory: "plain", mainModule: "index.js", hostnames: ["plain.test"] },
      new Map([["index.js", new TextEncoder().encode("export default {}")]]),
    );
    await runtime.reload();

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).not.toContain("ASSETS");
    expect(config).not.toContain("disk =");
  });

  test("refuses an asset name that would escape the directory", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createWorkerdRuntime } = await import("../src/workerd-runtime.ts");

    const root = await mkdtemp(join(tmpdir(), "workerd-escape-"));
    const runtime = createWorkerdRuntime({ root, port: 9999 });
    await expect(
      runtime.write(
        "site",
        {
          directory: "site",
          mainModule: "index.js",
          hostnames: ["site.test"],
          assets: { notFoundHandling: "none" },
        },
        new Map([["index.js", new TextEncoder().encode("export default {}")]]),
        new Map([["../escaped.txt", new TextEncoder().encode("no")]]),
      ),
    ).rejects.toThrow(/unusable asset name/u);
  });
});
