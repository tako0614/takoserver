import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { openWorkerdActorNamespace } from "../src/selfhost-actor-native-process.ts";
import type { WorkerdActiveActorGraph } from "../src/workerd-runtime.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("actor-qualification");
const digest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
const encoder = new TextEncoder();
const forwardRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "2.0.0",
  schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
} as const;

test("Actor namespace refuses an unknown full InterfaceRef before starting a child", async () => {
  let spawned = false;
  await expect(
    openWorkerdActorNamespace("/unused/workerd", {
      namespaceKey: "a".repeat(64),
      storagePath: "/unused/actor-state",
      className: "Actor",
      graph: graph(),
      signal: new AbortController().signal,
      runtimeClassRef: {
        apiVersion: "interfaces.takoform.com/v1alpha1",
        name: "worker.actor",
        version: "2.0.0",
        schemaDigest: `sha256:${"0".repeat(64)}`,
      },
      admitAlarm: async () => null,
      completeAlarm() {},
      admitSocket: async () => null,
      completeSocket() {},
      processAdapter: {
        spawn() {
          spawned = true;
          throw new Error("child start attempted");
        },
        probeReadiness: async () => new Response(null, { status: 204 }),
      },
    }),
  ).rejects.toThrow("Actor runtime InterfaceRef is unavailable");
  expect(spawned).toBe(false);
});

test("selected Actor InterfaceRef reaches every generated child and owner without a native launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-v2-generated-profile-"));
  let configPath = "";
  let refReads = 0;
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const child = {
    exitCode: null as number | null,
    signalCode: null,
    exited,
    kill() {
      this.exitCode = 137;
      finish(137);
    },
  };
  let namespace: Awaited<ReturnType<typeof openWorkerdActorNamespace>> | undefined;
  try {
    namespace = await openWorkerdActorNamespace("/unused/workerd", {
      namespaceKey: "b".repeat(64),
      storagePath: join(root, "state"),
      className: "Actor",
      graph: graph(),
      signal: new AbortController().signal,
      get runtimeClassRef() {
        refReads += 1;
        if (refReads > 1) throw new Error("Actor InterfaceRef read twice");
        return forwardRef;
      },
      admitAlarm: async () => null,
      completeAlarm() {},
      admitSocket: async () => null,
      completeSocket() {},
      processAdapter: {
        spawn(_binary, path) {
          configPath = path;
          return child;
        },
        probeReadiness: async () => new Response(null, { status: 204 }),
      },
    });
    expect(refReads).toBe(1);
    const childRoot = dirname(configPath);
    const paths = await readdir(childRoot, { recursive: true });
    const sources = await Promise.all(
      paths
        .filter((path) => /module-\d+$/u.test(path))
        .map(async (path) => ({
          path,
          source: await readFile(join(childRoot, path), "utf8"),
        })),
    );
    const entries = sources.filter(
      ({ path, source }) =>
        path.startsWith("actor-versions/") && source.includes("const INSPECTION_TOKEN ="),
    );
    const owners = sources.filter(
      ({ path, source }) =>
        path.startsWith("host-private/") && source.includes("const inspectionTokens ="),
    );
    expect(entries).toHaveLength(2);
    expect(owners).toHaveLength(1);
    const parser = new Bun.Transpiler({ loader: "js" });
    for (const { source } of [...entries, ...owners]) {
      expect(() => parser.transformSync(source)).not.toThrow();
      expect(source).toContain(forwardRef.schemaDigest);
      expect(source).toContain("resolveActorAbiProfile");
    }
    for (const { source } of entries) {
      expect(source).toContain('action === "callback-error"');
      expect(source).toContain("execution.socketError(");
      expect(source).toContain("ABI_PROFILE?.socketMessageBytes");
    }
    expect(owners[0]?.source).toContain("undefined, undefined, ABI_PROFILE");
  } finally {
    await namespace?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function graph(invalidSecond = false): WorkerdActiveActorGraph {
  const validActor = `export class Actor {
  constructor() { throw new Error("tenant constructor must not run during class inspection"); }
  fetch() { return new Response("ok"); }
  alarm() {}
  socketMessage() {}
  socketClose() {}
}`;
  const otherValidActor = `export class Actor {
  constructor() { throw new Error("tenant constructor must not run during class inspection"); }
  fetch() { return new Response("other weighted Version"); }
  alarm() {}
  socketMessage() {}
  socketClose() {}
}`;
  const invalidActor = `export class Actor {
  constructor() { throw new Error("tenant constructor must not run during class inspection"); }
  fetch() { return new Response("ok"); }
  socketMessage() {}
  socketClose() {}
}`;
  return {
    generation: "inspection-generation",
    generationKey: createHash("sha256").update("inspection-generation").digest("hex"),
    workerResourceUid: "resource-actor-inspection",
    versions: [validActor, invalidSecond ? invalidActor : otherValidActor].map((source, index) => {
      const mainModule = "main.mjs";
      const hostEntrypoint = "__actor-host.mjs";
      return {
        versionId: `version-${index}`,
        workerVersionUid: `worker-version-${index}`,
        weight: index === 0 ? 1 : 9999,
        variantKey: `version-${index}`,
        site: {
          directory: `version-${index}`,
          mainModule,
          hostEntrypoint,
          hostModules: [hostEntrypoint, SELFHOST_WORKER_PRELUDE_MODULE],
          hostnames: [],
          generation: "inspection-generation",
          workerResourceUid: "resource-actor-inspection",
          fetchHandler: true,
        },
        modules: new Map([[mainModule, encoder.encode(source)]]),
        hostModules: new Map([
          [SELFHOST_WORKER_PRELUDE_MODULE, encoder.encode(selfhostWorkerPreludeSource())],
          [
            hostEntrypoint,
            encoder.encode(
              selfhostWorkerEntrypointSource({
                originalMainModule: mainModule,
                declaredHandlers: ["fetch"],
                bindings: [],
                publication: "inspection-generation",
                probeHostname: "actor.invalid",
              }),
            ),
          ],
        ]),
      };
    }),
  };
}

test.skipIf(binary === undefined)(
  "native Actor startup inspects every active weighted Version before readiness without constructing tenant classes",
  async () => {
    if (!binary || !digest || !/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("explicit candidate binary and SHA256 required");
    const root = await mkdtemp(join(tmpdir(), "actor-class-inspection-"));
    const storagePath = join(root, "state");
    await mkdir(storagePath, { mode: 0o700 });
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(digest);
    let namespace: Awaited<ReturnType<typeof openWorkerdActorNamespace>> | undefined;
    try {
      const options = {
        namespaceKey: createHash("sha256").update("actor-inspection").digest("hex"),
        storagePath,
        className: "Actor",
        graph: graph(),
        signal: new AbortController().signal,
        admitAlarm: async () => null,
        completeAlarm() {},
        admitSocket: async () => null,
        completeSocket() {},
      };
      namespace = await openWorkerdActorNamespace(binary, options);
      await namespace.close();
      namespace = undefined;

      let startupError: unknown;
      namespace = await openWorkerdActorNamespace(binary, { ...options, graph: graph(true) }).catch(
        (error: unknown) => {
          startupError = error;
          return undefined;
        },
      );
      expect(startupError).toBeInstanceOf(Error);
      expect(String(startupError)).not.toContain("tenant constructor must not run");
      expect(namespace).toBeUndefined();
    } finally {
      await namespace?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
