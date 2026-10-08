import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SELFHOST_WORKER_PRELUDE_MODULE } from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import {
  openWorkerdActorNamespace,
  type WorkerdActorNativeProcessAdapter,
} from "../src/selfhost-actor-native-process.ts";
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";
import type { WorkerdActiveActorGraph } from "../src/workerd-runtime.ts";

test("Actor native custody ACK failure kills the stopped child before workerd can exec", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-native-ack-loss-"));
  const storagePath = join(root, "state");
  await mkdir(storagePath, { mode: 0o700 });
  let captured: LinuxProcessIdentity | undefined;
  try {
    await expect(
      openWorkerdActorNamespace("/bin/true", {
        namespaceKey: createHash("sha256").update("actor-native-ack-loss").digest("hex"),
        storagePath,
        className: "Actor",
        graph: graph(),
        signal: AbortSignal.timeout(10_000),
        admitAlarm: async () => null,
        completeAlarm() {},
        admitSocket: async () => null,
        completeSocket() {},
        async beforeNativeExec(identity) {
          captured = identity;
          expect(await linuxProcessLiveness(identity)).toBe("live");
          throw new Error("custody ACK unavailable");
        },
      }),
    ).rejects.toThrow("custody ACK unavailable");
    expect(captured).toBeDefined();
    if (captured) expect(await linuxProcessLiveness(captured)).toBe("stale");
  } finally {
    if (!captured || (await linuxProcessLiveness(captured)) === "stale")
      await rm(root, { recursive: true, force: true });
  }
}, 12_000);

function graph(): WorkerdActiveActorGraph {
  const mainModule = "main.mjs";
  const hostEntrypoint = "__actor-host.mjs";
  const source = `export class Actor {
  fetch() { return new Response("ok"); }
  alarm() {}
  socketMessage() {}
  socketClose() {}
}`;
  const encoder = new TextEncoder();
  return {
    generation: "process-recovery-generation",
    generationKey: createHash("sha256").update("process-recovery-generation").digest("hex"),
    workerResourceUid: "resource-actor-process-recovery",
    versions: [
      {
        versionId: "process-recovery-version",
        workerVersionUid: "worker-version-process-recovery",
        weight: 10_000,
        variantKey: "process-recovery-variant",
        site: {
          directory: "version",
          mainModule,
          hostEntrypoint,
          hostModules: [hostEntrypoint, SELFHOST_WORKER_PRELUDE_MODULE],
          hostnames: [],
          generation: "process-recovery-generation",
          workerResourceUid: "resource-actor-process-recovery",
          fetchHandler: true,
        },
        modules: new Map([[mainModule, encoder.encode(source)]]),
        hostModules: new Map([
          [SELFHOST_WORKER_PRELUDE_MODULE, encoder.encode("export {};\n")],
          [
            hostEntrypoint,
            encoder.encode(
              selfhostWorkerEntrypointSource({
                originalMainModule: mainModule,
                declaredHandlers: ["fetch"],
                bindings: [],
                publication: "process-recovery-generation",
                probeHostname: "actor.invalid",
              }),
            ),
          ],
        ]),
      },
    ],
  };
}

function controlledChild() {
  let exitCode: number | null = null;
  let resolveExited!: (code: number) => void;
  const killSignals: string[] = [];
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const child = {
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return null;
    },
    exited,
    kill(signal?: number | NodeJS.Signals) {
      if (exitCode !== null) return;
      killSignals.push(String(signal ?? ""));
      exitCode = 137;
      resolveExited(exitCode);
    },
  } satisfies ReturnType<WorkerdActorNativeProcessAdapter["spawn"]>;
  return { child, killSignals };
}

function abortableReadiness(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test("Actor startup abort reaps its child before a fresh namespace start", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-process-recovery-test-"));
  const storagePath = join(root, "state");
  await mkdir(storagePath, { mode: 0o700 });
  const controller = new AbortController();
  const firstChild = controlledChild();
  const secondChild = controlledChild();
  const childRoots: string[] = [];
  let readinessCalls = 0;
  let readinessStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readinessStarted = resolve;
  });
  const processAdapter: WorkerdActorNativeProcessAdapter = {
    spawn(_binary, config) {
      childRoots.push(dirname(config));
      return childRoots.length === 1 ? firstChild.child : secondChild.child;
    },
    probeReadiness({ signal }) {
      readinessCalls += 1;
      if (readinessCalls === 1) {
        readinessStarted();
        return abortableReadiness(signal);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  const options = {
    namespaceKey: createHash("sha256").update("actor-process-recovery").digest("hex"),
    storagePath,
    className: "Actor",
    graph: graph(),
    signal: controller.signal,
    admitAlarm: async () => null,
    completeAlarm() {},
    admitSocket: async () => null,
    completeSocket() {},
    processAdapter,
  };

  try {
    const firstStart = openWorkerdActorNamespace("/unused/workerd", options);
    await started;
    controller.abort(new Error("Actor startup stopped"));
    const settledPromptly = await Promise.race([
      firstStart.then(
        () => true,
        () => true,
      ),
      Bun.sleep(250).then(() => false),
    ]);
    if (!settledPromptly) await firstStart.catch(() => undefined);
    expect(settledPromptly).toBe(true);
    await expect(firstStart).rejects.toThrow("Actor startup stopped");
    expect(firstChild.killSignals).toEqual(["SIGKILL"]);
    expect(await pathExists(childRoots[0] ?? "")).toBe(false);

    const freshOptions = { ...options, signal: new AbortController().signal };
    const freshNamespace = await openWorkerdActorNamespace("/unused/workerd", freshOptions);
    expect(readinessCalls).toBe(2);
    await freshNamespace.close();
    expect(secondChild.killSignals).toEqual(["SIGKILL"]);
    expect(await pathExists(childRoots[1] ?? "")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test("Actor startup rejects a signaled child before readiness probing and does not kill it", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-signaled-startup-test-"));
  const storagePath = join(root, "state");
  await mkdir(storagePath, { mode: 0o700 });
  const childRoots: string[] = [];
  const killSignals: string[] = [];
  let readinessCalls = 0;
  const exitedChild = {
    exitCode: null,
    signalCode: "SIGTERM",
    exited: Promise.resolve(143),
    kill(signal?: number | NodeJS.Signals) {
      killSignals.push(String(signal ?? ""));
    },
  } satisfies ReturnType<WorkerdActorNativeProcessAdapter["spawn"]>;
  const processAdapter: WorkerdActorNativeProcessAdapter = {
    spawn(_binary, config) {
      childRoots.push(dirname(config));
      return exitedChild;
    },
    probeReadiness() {
      readinessCalls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  const options = {
    namespaceKey: createHash("sha256").update("actor-signaled-startup").digest("hex"),
    storagePath,
    className: "Actor",
    graph: graph(),
    signal: new AbortController().signal,
    admitAlarm: async () => null,
    completeAlarm() {},
    admitSocket: async () => null,
    completeSocket() {},
    processAdapter,
  };

  let namespace: Awaited<ReturnType<typeof openWorkerdActorNamespace>> | undefined;
  try {
    const opening = openWorkerdActorNamespace("/unused/workerd", options).then((opened) => {
      namespace = opened;
      return opened;
    });
    await expect(opening).rejects.toThrow("Actor native child exited during startup");
    expect(readinessCalls).toBe(0);
    expect(killSignals).toEqual([]);
    expect(await pathExists(childRoots[0] ?? "")).toBe(false);
  } finally {
    await namespace?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
