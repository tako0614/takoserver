import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { miniflareServiceBinding } from "./helpers/miniflare-service-binding.ts";

const executorModule = `
import { WorkerEntrypoint } from "cloudflare:workers";

const CONTEXT_SCHEMA = "takoserver.cloudflare-provider-mutation-context@v1";
function ticket(message) {
  return { phase: "failed", failure: { code: "unavailable", message, retryable: true } };
}
function expected(envelope, operationMode) {
  return envelope?.schema === CONTEXT_SCHEMA &&
    envelope?.prospectiveDeploymentId === "dep_native-rpc-context" &&
    envelope?.input?.operationId === "native-rpc-context" &&
    envelope?.input?.operationMode === operationMode &&
    envelope?.input?.identity?.uid === "resource-native-rpc";
}

export class Executor extends WorkerEntrypoint {
  async applyWithExecutionContextV1(envelope) {
    return ticket(expected(envelope, "initial") ? "native-apply-context-v1" : "invalid-apply-context");
  }
  async convergeApplyWithExecutionContextV1(envelope) {
    return ticket(expected(envelope, "recovery") ? "native-converge-context-v1" : "invalid-converge-context");
  }
}

export default { fetch() { return new Response("ok"); } };
`;

test("public provider proxy sends both context-v1 methods through native Worker RPC", async () => {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const buildDirectory = await mkdtemp(join(tmpdir(), "takoserver-proxy-native-rpc-"));
  const entrypoint = join(repositoryRoot, `.takoserver-proxy-native-rpc-${randomUUID()}.ts`);
  const outputPath = join(buildDirectory, "caller.js");
  const callerSource = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { CloudflareProviderProxy } from "./src/providers/cloudflare-provider-proxy.ts";

const input = {
  operationId: "native-rpc-context",
  operationMode: "initial",
  offering: { id: "fixture-offering", form: { kind: "ContainerService" } },
  identity: { tenantRef: "tenant-native-rpc", space: "main", name: "service", uid: "resource-native-rpc" },
  spec: {},
};

export class Caller extends WorkerEntrypoint {
  async probe() {
    const proxy = new CloudflareProviderProxy({
      providerInstallationId: "cloudflare.installation",
      offerings: [input.offering],
      managedBaseDomain: "workers.example.test",
      binding: this.env.EXECUTOR,
    });
    const apply = await proxy.apply(input, { prospectiveDeploymentId: "dep_native-rpc-context" });
    const convergeApply = await proxy.convergeApply(
      { ...input, operationMode: "recovery" },
      { prospectiveDeploymentId: "dep_native-rpc-context" },
    );
    return JSON.stringify({
      apply: { phase: apply.phase, message: apply.failure?.message },
      convergeApply: { phase: convergeApply.phase, message: convergeApply.failure?.message },
    });
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
    if (exitCode !== 0) throw new Error([stdout, stderr].filter(Boolean).join("\n"));
    const output = Bun.file(outputPath);
    if (!(await output.exists())) throw new Error("missing bundled native RPC caller");

    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "provider-proxy-caller",
            type: "worker",
            compatibilityDate: "2026-08-17",
            env: {
              EXECUTOR: miniflareServiceBinding("worker", "provider-proxy-executor", "Executor"),
              SELF: miniflareServiceBinding("worker", "provider-proxy-caller", "Caller"),
            },
            manifest: {
              mainModule: "caller.js",
              modules: { "caller.js": { type: "esm", contents: await output.text() } },
            },
          },
        },
        {
          config: {
            name: "provider-proxy-executor",
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
      const bindings = await runtime.getBindings<Record<string, unknown>>("provider-proxy-caller");
      const result = await (bindings.SELF as { probe(): Promise<string> }).probe();
      expect(JSON.parse(result)).toEqual({
        apply: { phase: "failed", message: "native-apply-context-v1" },
        convergeApply: { phase: "failed", message: "native-converge-context-v1" },
      });
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
