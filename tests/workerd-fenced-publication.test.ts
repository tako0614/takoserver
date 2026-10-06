import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerdRuntime,
  type WorkerdDeploymentPublication,
  type WorkerdPublicationIdentity,
} from "../src/workerd-runtime.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-fenced-workerd-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function publication(
  generation: string,
  weights: readonly [number, number] = [1, 9_999],
): WorkerdDeploymentPublication {
  const version = (suffix: string, weight: number) => ({
    versionId: `version-${suffix}`,
    workerVersionUid: `uid-WorkerVersion-${suffix}`,
    weight,
    site: {
      directory: "site",
      mainModule: "index.js",
      hostEntrypoint: "host.js",
      hostnames: [],
      generation,
      workerResourceUid: "uid-ModuleWorker-site",
      fetchHandler: true,
    },
    modules: new Map([
      [
        "index.js",
        new TextEncoder().encode("export default { fetch() { return new Response('ok'); } }"),
      ],
    ]),
    hostModules: new Map([
      ["host.js", new TextEncoder().encode('export { default } from "./index.js";')],
    ]),
  });
  return {
    generation,
    workerResourceUid: "uid-ModuleWorker-site",
    hostnames: ["site.localhost"],
    versions: [version("b", weights[1]), version("a", weights[0])],
  };
}

function identity(candidate: WorkerdDeploymentPublication): WorkerdPublicationIdentity {
  return {
    generation: candidate.generation,
    workerResourceUid: candidate.workerResourceUid,
    hostnames: candidate.hostnames,
    versions: candidate.versions.map(({ versionId, workerVersionUid, weight }) => ({
      versionId,
      workerVersionUid,
      weight,
    })),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function probe() {
  let serving: { identity: string; token: string } | null = null;
  let reloadCount = 0;
  let onReloadEffect: ((count: number) => Promise<void> | void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const current = serving;
      if (
        !current ||
        request.method !== "POST" ||
        request.headers.get("host") !== "runtime.selfhost-config.invalid" ||
        new URL(request.url).pathname !== "/.well-known/takoserver/selfhost-runtime-config/v1" ||
        request.headers.get("x-takoserver-selfhost-runtime-config") !== current.token
      ) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 204,
        headers: { "x-takoserver-selfhost-config-identity": current.identity },
      });
    },
  });
  if (server.port === undefined) throw new Error("probe failed to bind");
  return {
    port: server.port,
    stop: () => server.stop(true),
    setOnReloadEffect: (effect: typeof onReloadEffect) => {
      onReloadEffect = effect;
    },
    setWrongIdentity: () => {
      if (serving) serving = { ...serving, identity: "0".repeat(64) };
    },
    async onReload(path: string) {
      const config = await readFile(path, "utf8");
      const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      if (!identity || !token) throw new Error("invalid config probe");
      serving = { identity, token };
      reloadCount += 1;
      await onReloadEffect?.(reloadCount);
    },
  };
}

test("fenced success and exact complete identity or absence observation", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const candidate = publication("generation-1");
    const firstVersion = identity(candidate).versions[0];
    if (!firstVersion) throw new Error("version fixture unavailable");
    await runtime.publishFenced(
      "site",
      async (current) => {
        expect(current).toBeNull();
        return candidate;
      },
      async () => true,
    );
    expect(await runtime.observeExactPublication?.("site", identity(candidate))).toBe("matches");
    expect(
      await runtime.observeExactPublication?.("site", {
        ...identity(candidate),
        generation: "other",
      }),
    ).toBe("different");
    expect(
      await runtime.observeExactPublication?.("site", {
        ...identity(candidate),
        workerResourceUid: "uid-ModuleWorker-other",
      }),
    ).toBe("different");
    expect(
      await runtime.observeExactPublication?.("site", {
        ...identity(candidate),
        hostnames: ["other.localhost"],
      }),
    ).toBe("different");
    expect(
      await runtime.observeExactPublication?.("site", {
        ...identity(candidate),
        versions: [{ ...firstVersion, weight: 10_000 }],
      }),
    ).toBe("different");
    await expect(
      runtime.observeExactPublication?.("site", {
        ...identity(candidate),
        versions: [firstVersion, firstVersion],
      }),
    ).rejects.toThrow();
    expect(await runtime.observeExactPublication?.("site", null)).toBe("different");
    await runtime.publishFenced(
      "site",
      async (current) => {
        expect(current).toEqual({
          ...identity(candidate),
          hostnames: ["site.localhost"],
          versions: [...identity(candidate).versions].reverse(),
        });
        return null;
      },
      async () => true,
    );
    expect(await runtime.observeExactPublication?.("site", null)).toBe("matches");
    expect(await runtime.observeExactPublication?.("site", identity(candidate))).toBe("different");
    p.setWrongIdentity();
    expect(await runtime.observeExactPublication?.("site", null)).toBe("unknown");
  } finally {
    p.stop();
  }
});

test("candidate is resolved after the activation lock, and stale queued fence cannot publish", async () => {
  const p = probe();
  const entered = deferred();
  const release = deferred();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    p.setOnReloadEffect(async (count) => {
      if (count === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const first = publication("generation-1");
    const publishing = runtime.publishFenced(
      "site",
      async () => first,
      async () => true,
    );
    await entered.promise;
    let sampled = false;
    let live = true;
    const stale = runtime.publishFenced(
      "site",
      async () => {
        sampled = true;
        return publication("stale");
      },
      async () => live,
    );
    expect(sampled).toBe(false);
    live = false;
    release.resolve();
    await publishing;
    await expect(stale).rejects.toThrow("fence lost");
    expect(sampled).toBe(false);
    expect(await runtime.observeExactPublication?.("site", identity(first))).toBe("matches");
    const latest = publication("generation-2");
    await runtime.publishFenced(
      "site",
      async (current) => {
        expect(current?.generation).toBe(first.generation);
        sampled = true;
        return latest;
      },
      async () => true,
    );
    expect(sampled).toBe(true);
    expect(await runtime.observeExactPublication?.("site", identity(latest))).toBe("matches");
  } finally {
    release.resolve();
    p.stop();
  }
});

test("lost fence after reload rolls back, and retry converges on the intended graph", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const first = publication("generation-1");
    await runtime.publishFenced(
      "site",
      async () => first,
      async () => true,
    );
    const pointerPath = join(root, "workers", "site", "takoserver-site.json");
    const beforePointer = await readFile(pointerPath, "utf8");
    let live = true;
    p.setOnReloadEffect((count) => {
      if (count === 2) live = false;
    });
    const next = publication("generation-2");
    await expect(
      runtime.publishFenced(
        "site",
        async () => next,
        async () => live,
      ),
    ).rejects.toThrow("fence lost");
    expect(await readFile(pointerPath, "utf8")).toBe(beforePointer);
    expect(await runtime.observeExactPublication?.("site", identity(first))).toBe("matches");
    p.setOnReloadEffect(undefined);
    await runtime.publishFenced(
      "site",
      async () => next,
      async () => true,
    );
    expect(await runtime.observeExactPublication?.("site", identity(next))).toBe("matches");
  } finally {
    p.stop();
  }
});

test("fence lost during delayed graph snapshot cannot start an activation", async () => {
  const p = probe();
  const entered = deferred();
  const release = deferred();
  try {
    let live = true;
    let reloaded = false;
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      isReady: () => true,
      beforeRender: async () => {
        entered.resolve();
        await release.promise;
      },
      onReload: async (path) => {
        reloaded = true;
        await p.onReload(path);
      },
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const pending = runtime.publishFenced(
      "site",
      async () => publication("generation-1"),
      async () => live,
    );
    await entered.promise;
    live = false;
    release.resolve();
    await expect(pending).rejects.toThrow("fence lost");
    expect(reloaded).toBe(false);
    await expect(
      readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    p.stop();
  }
});

test("fence lost during renderer preparation never reloads the candidate", async () => {
  const p = probe();
  const entered = deferred();
  const release = deferred();
  try {
    let live = true;
    const loadedConfigs: string[] = [];
    let preparation = 0;
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      isReady: () => true,
      onReload: async (path) => {
        loadedConfigs.push(await readFile(path, "utf8"));
        await p.onReload(path);
      },
      actorForwardLifecycle: {
        prepare: async () => {
          preparation += 1;
          if (preparation === 1) {
            entered.resolve();
            await release.promise;
          }
        },
        activated() {},
        uncertain() {},
      },
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const pending = runtime.publishFenced(
      "site",
      async () => publication("generation-1"),
      async () => live,
    );
    await entered.promise;
    live = false;
    release.resolve();
    await expect(pending).rejects.toThrow("fence lost");
    expect(loadedConfigs.every((config) => !config.includes("site.localhost"))).toBe(true);
    await expect(
      readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    p.stop();
  }
});

test("a failed resolver or pre-effect fence never creates a publication pointer", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    let resolved = false;
    await expect(
      runtime.publishFenced(
        "site",
        async () => {
          resolved = true;
          return publication("generation-1");
        },
        async () => false,
      ),
    ).rejects.toThrow("fence lost");
    expect(resolved).toBe(false);
    await expect(
      runtime.publishFenced(
        "site",
        async () => {
          throw new Error("resolver unavailable");
        },
        async () => true,
      ),
    ).rejects.toThrow("resolver unavailable");
    await expect(
      readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    p.stop();
  }
});

test("fenced publication refuses a file-only runtime without serving proof", async () => {
  const runtime = createWorkerdRuntime({ root });
  if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
  let resolved = false;
  await expect(
    runtime.publishFenced(
      "site",
      async () => {
        resolved = true;
        return publication("generation-1");
      },
      async () => true,
    ),
  ).rejects.toThrow("requires serving proof");
  expect(resolved).toBe(false);
  await expect(
    readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("a retained scalar publication is not presented to the resolver as absence", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const version = publication("scalar-generation").versions[0];
    if (!version) throw new Error("version fixture unavailable");
    await runtime.write(
      "site",
      { ...version.site, hostnames: ["site.localhost"] },
      version.modules,
      undefined,
      version.hostModules,
    );
    await runtime.reload();
    const pointerPath = join(root, "workers", "site", "takoserver-site.json");
    const before = await readFile(pointerPath, "utf8");
    let resolved = false;
    await expect(
      runtime.publishFenced(
        "site",
        async () => {
          resolved = true;
          return publication("generation-2");
        },
        async () => true,
      ),
    ).rejects.toThrow("no weighted identity");
    expect(resolved).toBe(false);
    expect(await readFile(pointerPath, "utf8")).toBe(before);
  } finally {
    p.stop();
  }
});

test("an unreadable retained carrier is not presented as absence", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    await mkdir(join(root, "workers", "site"), { recursive: true });
    await writeFile(join(root, "workers", "site", "takoserver-site.json"), "unreadable");
    let resolved = false;
    await expect(
      runtime.publishFenced(
        "site",
        async () => {
          resolved = true;
          return publication("generation-1");
        },
        async () => true,
      ),
    ).rejects.toThrow("cannot be read");
    expect(resolved).toBe(false);
  } finally {
    p.stop();
  }
});

test("fence lost during post-activation lease release revokes serving claims", async () => {
  const p = probe();
  try {
    let live = true;
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
      workflowForwardSockets: () => [],
      workflowForwardLifecycle: {
        async reserve() {
          return {
            async release() {
              live = false;
            },
          };
        },
        activated: () => true,
        isRestored: () => true,
        uncertain() {},
      },
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const candidate = publication("generation-1");
    await expect(
      runtime.publishFenced(
        "site",
        async () => candidate,
        async () => live,
      ),
    ).rejects.toThrow("fence lost");
    expect(await runtime.observeExactPublication?.("site", identity(candidate))).toBe("unknown");
    expect(
      JSON.parse(await readFile(join(root, "workers", ".takoserver-active.json"), "utf8")),
    ).toEqual({});
  } finally {
    p.stop();
  }
});

test("unproved reload readback restores the prior pointer and serving identity", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced publication unavailable");
    const first = publication("generation-1");
    await runtime.publishFenced(
      "site",
      async () => first,
      async () => true,
    );
    const pointerPath = join(root, "workers", "site", "takoserver-site.json");
    const beforePointer = await readFile(pointerPath, "utf8");
    p.setOnReloadEffect((count) => {
      if (count === 2) p.setWrongIdentity();
    });
    await expect(
      runtime.publishFenced(
        "site",
        async () => publication("generation-2"),
        async () => true,
      ),
    ).rejects.toThrow("worker runtime did not confirm the rendered configuration");
    expect(await readFile(pointerPath, "utf8")).toBe(beforePointer);
    expect(await runtime.observeExactPublication?.("site", identity(first))).toBe("matches");
  } finally {
    p.stop();
  }
}, 10_000);
