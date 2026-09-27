import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { openWorkerdActorNamespace } from "../src/selfhost-actor-native-process.ts";
import type { WorkerdActiveActorGraph } from "../src/workerd-runtime.ts";

const binary = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
const digest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
const encoder = new TextEncoder();

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
