import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";

const executorModule = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class Executor extends WorkerEntrypoint {
  async concludeApplyNoEffect() {
    return {
      phase: "unsupported",
      executorApplyNoEffectUnsupported: {
        schema: "takoserver.cloudflare-provider-executor-apply-no-effect@v1",
        action: "unsupported",
        operationId: "operation-no-effect-1",
        providerInstallationRef: "cloudflare.installation",
        executionAuthority: {
          tenantId: "tenant-1",
          resourceUid: "resource-1",
          leaseToken: "lease-token-1",
          fingerprint: "fingerprint-1",
        },
      },
    };
  }
}

export default { fetch() { return new Response("ok"); } };
`;

test("native WorkerEntrypoint RPC no-effect proof restores through the public proxy", async () => {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const buildDirectory = await mkdtemp(join(tmpdir(), "takoserver-native-rpc-"));
  const entrypoint = join(repositoryRoot, `.takoserver-native-rpc-${randomUUID()}.ts`);
  const outputPath = join(buildDirectory, "caller.js");
  const callerSource = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { CloudflareProviderProxy } from "./src/providers/cloudflare-provider-proxy.ts";
import { maybeExactRecord } from "./src/providers/cloudflare-provider-executor-codec.ts";

const input = {
  operationId: "operation-no-effect-1",
  providerInstallationRef: "cloudflare.installation",
  executionAuthority: {
    tenantId: "tenant-1",
    resourceUid: "resource-1",
    leaseToken: "lease-token-1",
    fingerprint: "fingerprint-1",
  },
  offering: {},
  identity: { tenantRef: "tenant-1", space: "default", name: "worker", uid: "resource-1" },
};

export class Caller extends WorkerEntrypoint {
  async probe() {
    const raw = await this.env.EXECUTOR.concludeApplyNoEffect(input);
    const descriptor = Object.getOwnPropertyDescriptor(raw, Symbol.dispose);
    const rawRootKeys = Reflect.ownKeys(raw).map((key) =>
      typeof key === "symbol" ? ["symbol", key.description ?? ""].join(":") : key,
    );
    const rawPrototypeIsObject = Object.getPrototypeOf(raw) === Object.prototype;
    const strictRejected =
      maybeExactRecord(raw, ["phase", "executorApplyNoEffectUnsupported"]) === null;
    let disposals = 0;
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error("missing native RPC disposer");
    }
    const nativeDispose = descriptor.value;
    Object.defineProperty(raw, Symbol.dispose, {
      ...descriptor,
      value: () => {
        disposals += 1;
        return nativeDispose.call(raw);
      },
    });
    const binding = {
      concludeApplyNoEffect: async () => raw,
    };
    const proxy = new CloudflareProviderProxy({
      providerInstallationId: "cloudflare.installation",
      offerings: [{}],
      managedBaseDomain: "workers.example.test",
      binding,
    });
    const restored = await proxy.concludeApplyNoEffect(input);
    return {
      rawType: typeof raw,
      rawPrototypeIsObject,
      rawRootKeys,
      strictRejected,
      disposer: {
        kind: "value" in descriptor ? "data" : "accessor",
        valueType: "value" in descriptor ? typeof descriptor.value : null,
        enumerable: descriptor.enumerable,
        writable: "writable" in descriptor ? descriptor.writable : null,
        configurable: descriptor.configurable,
      },
      disposals,
      restoredPhase: restored.phase,
      restoredRootKeys: Reflect.ownKeys(restored).map((key) =>
        typeof key === "symbol" ? ["symbol", key.description ?? ""].join(":") : key,
      ),
    };
  }
}

export default { fetch() { return new Response("ok"); } };
`;
  try {
    await Bun.write(entrypoint, callerSource);
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        entrypoint,
        "--target=browser",
        "--format=esm",
        "--external=cloudflare:workers",
        `--outfile=${outputPath}`,
      ],
      {
        cwd: repositoryRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error([stdout, stderr].filter(Boolean).join("\n"));
    }
    const output = Bun.file(outputPath);
    if (!(await output.exists())) throw new Error("missing bundled native RPC caller");

    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "caller",
            type: "worker",
            compatibilityDate: "2026-08-17",
            env: {
              EXECUTOR: { type: "worker", workerName: "executor", exportName: "Executor" },
              SELF: { type: "worker", workerName: "caller", exportName: "Caller" },
            },
            manifest: {
              mainModule: "caller.js",
              modules: { "caller.js": { type: "esm", contents: await output.text() } },
            },
          },
        },
        {
          config: {
            name: "executor",
            type: "worker",
            compatibilityDate: "2026-08-17",
            manifest: {
              mainModule: "executor.js",
              modules: { "executor.js": { type: "esm", contents: executorModule } },
            },
          },
        },
      ],
    });
    try {
      const bindings = await runtime.getBindings<Record<string, unknown>>("caller");
      const result = (await (bindings.SELF as { probe(): Promise<unknown> }).probe()) as Record<
        PropertyKey,
        unknown
      >;
      const outerDescriptor = Object.getOwnPropertyDescriptor(result, Symbol.dispose);
      if (
        outerDescriptor !== undefined &&
        (!("value" in outerDescriptor) || typeof outerDescriptor.value !== "function")
      ) {
        throw new Error("invalid outer native RPC disposer");
      }
      const outerDispose = outerDescriptor?.value as (() => void) | undefined;
      try {
        const expectedStringKeys = [
          "rawType",
          "rawPrototypeIsObject",
          "rawRootKeys",
          "strictRejected",
          "disposer",
          "disposals",
          "restoredPhase",
          "restoredRootKeys",
        ];
        const outerKeys = Reflect.ownKeys(result);
        expect(outerKeys.filter((key): key is string => typeof key === "string")).toEqual(
          expectedStringKeys,
        );
        expect(outerKeys.filter((key): key is symbol => typeof key === "symbol")).toEqual(
          outerDescriptor === undefined ? [] : [Symbol.dispose],
        );
        if (outerDescriptor !== undefined) {
          expect({
            kind: "value" in outerDescriptor ? "data" : "accessor",
            valueType: "value" in outerDescriptor ? typeof outerDescriptor.value : null,
            enumerable: outerDescriptor.enumerable,
            writable: "writable" in outerDescriptor ? outerDescriptor.writable : null,
            configurable: outerDescriptor.configurable,
          }).toEqual({
            kind: "data",
            valueType: "function",
            enumerable: false,
            writable: true,
            configurable: true,
          });
        }
        expect({
          rawType: result.rawType,
          rawPrototypeIsObject: result.rawPrototypeIsObject,
          rawRootKeys: result.rawRootKeys,
          strictRejected: result.strictRejected,
          disposer: result.disposer,
          disposals: result.disposals,
          restoredPhase: result.restoredPhase,
          restoredRootKeys: result.restoredRootKeys,
        }).toEqual({
          rawType: "object",
          rawPrototypeIsObject: true,
          rawRootKeys: ["phase", "executorApplyNoEffectUnsupported", "symbol:Symbol.dispose"],
          strictRejected: true,
          disposer: {
            kind: "data",
            valueType: "function",
            enumerable: false,
            writable: true,
            configurable: true,
          },
          disposals: 1,
          restoredPhase: "unsupported",
          restoredRootKeys: ["phase"],
        });
      } finally {
        outerDispose?.call(result);
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    await Promise.all([
      rm(entrypoint, { force: true }),
      rm(buildDirectory, { recursive: true, force: true }),
    ]);
  }
});
