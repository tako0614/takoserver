import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import {
  createSelfhostVersionMaterializer,
  type SelfhostVersionArtifactManifest,
} from "../src/providers/selfhost-version-materialization.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const EDGE_API = "edge.forms.takoform.com/v1beta1";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-version-materialization-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function artifactFixture(source = "export default {}") {
  const bytes = new TextEncoder().encode(source);
  const blobDigest = await bytesDigest(bytes);
  const manifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle" as const,
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        mediaType: "application/javascript+module",
        size: bytes.byteLength,
        digest: blobDigest,
      },
    ],
  } satisfies SelfhostVersionArtifactManifest;
  const manifestDigest = await canonicalDigest(manifest);
  let available = true;
  return {
    manifest,
    manifestDigest,
    setAvailable(value: boolean) {
      available = value;
    },
    artifacts: {
      async manifest(_tenantRef: string, digest: string) {
        return digest === manifestDigest ? manifest : null;
      },
      async blob(digest: string) {
        return available && digest === blobDigest ? bytes : null;
      },
    },
  };
}

async function materializerFixture(source?: string) {
  const fixture = await artifactFixture(source);
  const materializer = createSelfhostVersionMaterializer({
    root,
    artifacts: fixture.artifacts,
  });
  const input = {
    tenantRef: "tenant-a",
    script: "script-a",
    versionId: "version-a",
    manifestDigest: fixture.manifestDigest,
  } as const;
  return { fixture, materializer, input };
}

describe("self-host Worker Version materialization", () => {
  test("a missing blob preserves an existing complete version", async () => {
    const { fixture, materializer, input } = await materializerFixture();
    await materializer.materialize(input);
    const finalPath = join(root, input.script, input.versionId);
    const before = await readFile(join(finalPath, "meta.json"));
    fixture.setAvailable(false);

    await expect(materializer.materialize(input)).rejects.toMatchObject({ code: "invalid_spec" });

    expect(await readFile(join(finalPath, "meta.json"))).toEqual(before);
    expect((await materializer.inspect(input)).state).toBe("present");
  });

  test("a crash before rename leaves the prior committed version untouched", async () => {
    const old = await materializerFixture("export default 'old'");
    await old.materializer.materialize({ ...old.input, versionId: "version-old" });
    const next = await materializerFixture("export default 'new'");
    const crashing = createSelfhostVersionMaterializer({
      root,
      artifacts: next.fixture.artifacts,
      beforeRename: () => {
        throw new Error("simulated crash before rename");
      },
    });

    await expect(
      crashing.materialize({ ...next.input, versionId: "version-new" }),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect((await old.materializer.inspect({ ...old.input, versionId: "version-old" })).state).toBe(
      "present",
    );
    expect((await crashing.inspect({ ...next.input, versionId: "version-new" })).state).toBe(
      "absent",
    );
    const siblings = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(root, next.input.script)).catch(() => []),
    );
    expect(siblings.some((entry) => entry.startsWith("version-new.staging-"))).toBe(false);
  });

  test("an exact digest replay is idempotent and does not rewrite the final", async () => {
    const { materializer, input } = await materializerFixture();
    await materializer.materialize(input);
    const finalPath = join(root, input.script, input.versionId);
    const before = await lstat(finalPath);
    const metaBefore = await readFile(join(finalPath, "meta.json"));

    const replay = await materializer.materialize(input);
    const after = await lstat(finalPath);
    const inspected = await materializer.inspect(input);

    expect(inspected.state).toBe("present");
    if (inspected.state !== "present") throw new Error("replayed materialization is not present");
    expect(replay.materializationDigest).toBe(inspected.digest);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(join(finalPath, "meta.json"))).toEqual(metaBefore);
  });

  test("a digest-mismatched or corrupt final refuses overwrite", async () => {
    const { fixture, materializer, input } = await materializerFixture();
    await materializer.materialize(input);
    const modulePath = join(root, input.script, input.versionId, "modules", "index.js");
    await writeFile(modulePath, "tampered", "utf8");

    await expect(materializer.materialize(input)).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(modulePath, "utf8")).toBe("tampered");
    expect((await materializer.inspect(input)).state).toBe("corrupt");

    // A valid final carrying a different source digest is also create-only:
    // the new request cannot replace the committed identity.
    const different = await materializerFixture("export default 'different'");
    const other = createSelfhostVersionMaterializer({
      root,
      artifacts: different.fixture.artifacts,
    });
    await rm(join(root, input.script, input.versionId), { recursive: true, force: true });
    await materializer.materialize(input);
    await expect(
      other.materialize({ ...input, manifestDigest: different.fixture.manifestDigest }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.manifestDigest).not.toBe(different.fixture.manifestDigest);
  });

  test("inspection is exactly absent, present, or corrupt", async () => {
    const { materializer, input } = await materializerFixture();
    expect(await materializer.inspect(input)).toEqual({ state: "absent" });
    await materializer.materialize(input);
    expect((await materializer.inspect(input)).state).toBe("present");
    await rm(join(root, input.script, input.versionId, "meta.json"));
    expect(await materializer.inspect(input)).toEqual({ state: "corrupt" });
  });
});

function offering(kind: string): ProviderOffering {
  return {
    id: `selfhost.edge.${kind.toLowerCase()}`,
    kind: `takoform.${kind}`,
    displayName: kind,
    form: {
      apiVersion: EDGE_API,
      kind,
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"],
  };
}

function relation(
  pointer: string,
  kind: string,
  name: string,
  spec: Record<string, unknown> = {},
): ProviderRelation {
  return {
    pointer,
    relation: pointer.replace(/\/[0-9]+\//gu, "/*/"),
    targetUid: `uid-${kind}-${name}`,
    resource: {
      apiVersion: EDGE_API,
      kind,
      form: {
        formRef: {
          apiVersion: EDGE_API,
          kind,
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      metadata: {
        name,
        space: "default",
        uid: `uid-${kind}-${name}`,
        generation: "1",
        revision: "1",
      },
      spec: spec as never,
    },
  };
}

const runtime: WorkerdRuntime = {
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return true;
  },
};

test("the provider maps missing/corrupt observation and recovers an exact apply", async () => {
  const fixture = await artifactFixture();
  const provider = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    artifacts: fixture.artifacts,
  });
  const input = {
    operationId: "op-version",
    offering: offering("WorkerVersion"),
    identity: { tenantRef: "tenant-a", space: "default", name: "version-a" },
    spec: { handlers: ["fetch"] },
    relations: [
      relation("/worker", "ModuleWorker", "worker-a"),
      relation("/bundle", "WorkerBundle", "bundle-a", { manifestDigest: fixture.manifestDigest }),
    ],
  } as const;
  const applied = await provider.apply(input);
  expect(applied.phase).toBe("succeeded");

  const missing = await provider.observe({
    ...input,
    nativeId: "missing",
    identity: { ...input.identity, name: "missing-version" },
  });
  expect(missing).toMatchObject({ phase: "failed", failure: { code: "not_found" } });

  if (applied.phase !== "succeeded") throw new Error("version apply failed");
  const modulePath = join(
    root,
    "selfhost",
    "versions",
    String(applied.result.outputs.scriptName),
    String(applied.result.outputs.versionId),
    "modules",
    "index.js",
  );
  await writeFile(modulePath, "corrupt", "utf8");
  const corrupt = await provider.observe({ ...input, nativeId: applied.result.nativeId });
  expect(corrupt).toMatchObject({ phase: "failed", failure: { code: "provider_error" } });

  // Restore a clean materialization through a fresh provider instance to
  // verify recovery's read-only exact-digest path.
  await rm(
    join(
      root,
      "selfhost",
      "versions",
      String(applied.result.outputs.scriptName),
      String(applied.result.outputs.versionId),
    ),
    { recursive: true, force: true },
  );
  const restored = await provider.apply({ ...input, operationId: "op-version-restore" });
  expect(restored.phase).toBe("succeeded");
  if (!provider.recoverApply) throw new Error("self-host provider missing apply recovery seam");
  const recovered = await provider.recoverApply({ ...input, operationMode: "recovery" });
  expect(recovered).toMatchObject({
    phase: "succeeded",
    result: { observed: { materialized: true } },
  });
});
