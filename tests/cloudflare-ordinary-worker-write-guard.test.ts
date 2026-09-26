import { describe, expect, test } from "bun:test";
import {
  type ApplyInput,
  type ProviderOffering,
  providerFailureProvesNoMutation,
} from "../src/provider-port.ts";
import {
  CLOUDFLARE_TAKOFORM_HANDLER_KINDS,
  CloudflareProvider,
  type CloudflareProviderOptions,
} from "../src/providers/cloudflare.ts";

const WORKER_KINDS = [
  "ModuleWorker",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
  "WorkerCustomDomain",
  "WorkerCronTrigger",
  "QueueConsumer",
] as const;

function offering(kind: string, legacy = false): ProviderOffering {
  return {
    id: `test.${kind}`,
    kind: legacy ? "worker_script" : `takoform.${kind}`,
    displayName: kind,
    form: {
      apiVersion: "edge.forms.takoform.com",
      kind,
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "update", "delete", "observe"],
  };
}

function input(kind: string, legacy = false): ApplyInput {
  return {
    operationId: `operation-${kind}`,
    offering: offering(kind, legacy),
    identity: { tenantRef: "tenant-test", space: "default", name: "worker", uid: "worker-test" },
    spec: {},
  };
}

function recorder(extra: Partial<CloudflareProviderOptions> = {}) {
  const calls: string[] = [];
  const provider = new CloudflareProvider({
    accountId: "account-test",
    offerings: WORKER_KINDS.map((kind) => offering(kind)),
    artifacts: {
      async manifest() {
        calls.push("artifact manifest");
        return null;
      },
      async blob() {
        calls.push("artifact blob");
        return null;
      },
    },
    runtimeInputs: {
      async acquire() {
        calls.push("runtime input acquire");
        throw new Error("the write guard must run before acquiring runtime inputs");
      },
      async recover() {
        calls.push("runtime input recover");
        throw new Error("the write guard must run before recovering runtime inputs");
      },
    },
    authorize: () => {
      calls.push("authorize");
      return "Bearer test-only";
    },
    fetch: async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ success: true, errors: [], result: {} });
    },
    ...extra,
  });
  return { provider, calls };
}

describe("ordinary Cloudflare Worker write boundary", () => {
  for (const selection of [
    {},
    { workerEndpointSuffix: "test.workers.dev" },
    { workerBackend: { kind: "ordinary-workers", workerEndpointSuffix: "test.workers.dev" } },
    { workerBackend: { kind: "ordinary-workers", allowDevelopmentWorkerWrites: false } },
  ] satisfies Partial<CloudflareProviderOptions>[]) {
    test(`refuses every Worker write without development opt-in: ${JSON.stringify(selection)}`, async () => {
      const { provider, calls } = recorder(selection);
      for (const candidate of [
        ...WORKER_KINDS.map((kind) => input(kind)),
        input("WorkerVersion", true),
      ]) {
        for (const previous of [undefined, { nativeId: "worker:legacy-worker", spec: {} }]) {
          const desired = { ...candidate, ...(previous ? { previous } : {}) };
          const modes =
            candidate.offering.kind === "takoform.WorkerVersion"
              ? (["initial"] as const)
              : ([undefined, "initial", "recovery"] as const);
          for (const operationMode of modes) {
            const ticket = await provider.apply({
              ...desired,
              ...(operationMode === undefined ? {} : { operationMode }),
            });
            expect(ticket).toMatchObject({
              phase: "failed",
              failure: {
                code: "denied",
                retryable: false,
                message: expect.stringContaining("ordinary Cloudflare Worker writes are disabled"),
              },
            });
          }
        }
      }
      expect(calls).toEqual([]);
    });
  }

  test("proves only an initial refusal mutation-free, never an older operation's recovery", async () => {
    const { provider, calls } = recorder();
    const desired = input("ModuleWorker");
    const initial = await provider.apply({ ...desired, operationMode: "initial" });
    expect(providerFailureProvesNoMutation(initial, desired.operationId)).toBe(true);
    expect(providerFailureProvesNoMutation(initial, "different-operation")).toBe(false);
    for (const ticket of [
      await provider.apply(desired),
      await provider.apply({ ...desired, operationMode: "recovery" }),
      await provider.recoverApply(desired),
      await provider.convergeApply(desired),
    ]) {
      expect(ticket).toMatchObject({ phase: "failed" });
      expect(providerFailureProvesNoMutation(ticket, desired.operationId)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test("requires an explicit development write opt-in even with an ordinary backend selection", async () => {
    const { provider, calls } = recorder({
      workerBackend: { kind: "ordinary-workers", allowDevelopmentWorkerWrites: true },
    });
    expect(
      await provider.apply({ ...input("ModuleWorker"), operationMode: "initial" }),
    ).toMatchObject({ phase: "succeeded" });
    expect(calls).toEqual([
      "authorize",
      expect.stringMatching(/^PUT \/client\/v4\/accounts\/account-test\/workers\/scripts\/tsw-/u),
    ]);
  });

  test("keeps non-Worker account resource creation enabled without development opt-in", async () => {
    const { provider, calls } = recorder({
      fetch: async (request) => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json({
          success: true,
          errors: [],
          result: { id: "kv-test", uuid: "database-test", queue_id: "queue-test" },
        });
      },
    });
    for (const kind of ["ObjectBucket", "EdgeKVNamespace", "SQLiteDatabase", "AtLeastOnceQueue"]) {
      expect(await provider.apply({ ...input(kind), operationMode: "initial" })).toMatchObject({
        phase: "succeeded",
      });
    }
    expect(calls.filter((call) => call !== "authorize")).toEqual([
      "POST /client/v4/accounts/account-test/r2/buckets",
      "POST /client/v4/accounts/account-test/storage/kv/namespaces",
      "POST /client/v4/accounts/account-test/d1/database",
      "POST /client/v4/accounts/account-test/queues",
    ]);
  });

  test("retains the public handler roster used by managed backend admission", () => {
    expect(CLOUDFLARE_TAKOFORM_HANDLER_KINDS).toEqual([
      "ModuleWorker",
      "EdgeKVNamespace",
      "SQLiteDatabase",
      "AtLeastOnceQueue",
      "ObjectBucket",
      "WorkerVersion",
      "WorkerDeployment",
      "WorkerEndpoint",
      "WorkerCustomDomain",
      "WorkerCronTrigger",
      "QueueConsumer",
    ]);
  });

  test("keeps legacy Worker observation and deletion available without write opt-in", async () => {
    let deleted = false;
    const { provider, calls } = recorder({
      fetch: async (request) => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === "DELETE") deleted = true;
        return deleted && request.method === "GET"
          ? new Response(null, { status: 404 })
          : Response.json({ success: true, errors: [], result: {} });
      },
    });
    const desired = input("WorkerVersion", true);
    const existing = { ...desired, nativeId: "worker:legacy-worker" };
    expect(await provider.observe(existing)).toMatchObject({ phase: "succeeded" });
    expect(await provider.delete(existing)).toMatchObject({ phase: "succeeded" });
    expect(await provider.recoverDelete(existing)).toMatchObject({ phase: "succeeded" });
    expect(calls.filter((call) => call !== "authorize")).toEqual([
      "GET /client/v4/accounts/account-test/workers/scripts/legacy-worker",
      "DELETE /client/v4/accounts/account-test/workers/scripts/legacy-worker",
      "GET /client/v4/accounts/account-test/workers/scripts/legacy-worker",
    ]);
  });
});
