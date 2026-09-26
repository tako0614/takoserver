import { describe, expect, test } from "bun:test";
import { CloudflareState } from "../scripts/deploy/cloudflare-state.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  type IntegrationStorageDisposalProvider,
  type IntegrationStorageDisposalStateReader,
  runIntegrationStorageDisposal,
} from "../scripts/deploy/integration-storage-disposal.ts";
import type {
  IntegrationStorageD1Database,
  IntegrationStorageR2Bucket,
} from "../scripts/deploy/integration-storage-generation.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const COMMIT = "a".repeat(40);
const ACCOUNT = "c".repeat(32);
const DATABASE_ID = "00000000-0000-4000-8000-000000000051";
const DATABASE_NAME = "takoserver-runtime-staging";
const BUCKET_NAME = "takoserver-objects-staging";
const REVIEWER = "storage-reviewer";

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: ACCOUNT,
  workerName: "takoserver-api-integration",
  d1: { databaseName: DATABASE_NAME, databaseId: DATABASE_ID },
  r2: { bucketName: BUCKET_NAME },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "integration-current" },
} satisfies DeployTarget;

interface ProviderFixtureOptions {
  readonly initialDatabase?: IntegrationStorageD1Database | null;
  readonly databaseById?: IntegrationStorageD1Database | null;
  readonly initialBucket?: boolean;
  readonly deleteR2Error?: Error;
}

function providerFixture(options: ProviderFixtureOptions = {}): {
  readonly provider: IntegrationStorageDisposalProvider;
  readonly events: string[];
} {
  let databases: IntegrationStorageD1Database[] = [
    ...(options.initialDatabase === undefined
      ? [{ name: DATABASE_NAME, uuid: DATABASE_ID }]
      : options.initialDatabase === null
        ? []
        : [options.initialDatabase]),
  ];
  const databaseByIdOverride = options.databaseById;
  let buckets: IntegrationStorageR2Bucket[] =
    options.initialBucket === false ? [] : [{ name: BUCKET_NAME }];
  const events: string[] = [];
  return {
    events,
    provider: {
      listD1: async (name) => {
        events.push("read:d1-name");
        return databases.filter((database) => database.name === name);
      },
      getD1ById: async (id) => {
        events.push("read:d1-id");
        if (databaseByIdOverride !== undefined) return databaseByIdOverride;
        return databases.find((database) => database.uuid === id) ?? null;
      },
      listR2: async (name) => {
        events.push("read:r2-name");
        return buckets.filter((bucket) => bucket.name === name);
      },
      deleteR2: async (name) => {
        events.push(`delete:r2:${name}`);
        if (options.deleteR2Error !== undefined) throw options.deleteR2Error;
        buckets = buckets.filter((bucket) => bucket.name !== name);
      },
      deleteD1: async (id) => {
        events.push(`delete:d1:${id}`);
        databases = databases.filter((database) => database.uuid !== id);
      },
    },
  };
}

interface StateFixtureOptions {
  readonly scripts?: readonly string[];
  readonly settings?: unknown;
  readonly settingsFor?: (workerName: string) => unknown | Promise<unknown>;
  readonly deployments?:
    | readonly unknown[]
    | ((workerName: string) => readonly unknown[] | Promise<readonly unknown[]>);
  readonly version?: unknown;
  readonly failSettings?: boolean;
  readonly dispatchNamespaces?: readonly unknown[];
  readonly dispatchScripts?: readonly unknown[];
  readonly dispatchBindings?: unknown;
  readonly failDispatchInventory?: boolean;
}

function stateFixture(options: StateFixtureOptions = {}): IntegrationStorageDisposalStateReader {
  return {
    workerScripts: async () => options.scripts ?? ["sample-worker"],
    workerSettings: async (workerName) => {
      if (options.failSettings) throw new Error("settings unavailable");
      if (options.settingsFor !== undefined) return await options.settingsFor(workerName);
      return options.settings ?? { bindings: [] };
    },
    workerDeployments: async (workerName) => {
      const deployments = options.deployments ?? [];
      return typeof deployments === "function" ? await deployments(workerName) : deployments;
    },
    workerVersion: async () => options.version ?? { resources: { bindings: [] } },
    read: async (path) => {
      if (
        options.failDispatchInventory &&
        (path === "/workers/dispatch/namespaces" || path.endsWith("/scripts"))
      ) {
        throw new Error("dispatch inventory unavailable");
      }
      if (path === "/workers/dispatch/namespaces") return options.dispatchNamespaces ?? [];
      if (path.endsWith("/scripts")) return options.dispatchScripts ?? [];
      return options.dispatchBindings ?? [];
    },
  };
}

const processFixture = async (command: readonly string[]): Promise<CommandResult> => {
  const output =
    command.join(" ") === "git rev-parse HEAD"
      ? `${COMMIT}\n`
      : command.join(" ") === "git branch --show-current"
        ? "storage-disposal-test\n"
        : command.includes("status")
          ? ""
          : "";
  return { exitCode: 0, stdout: output, stderr: "" };
};

async function execute(
  provider: IntegrationStorageDisposalProvider,
  state: IntegrationStorageDisposalStateReader,
  options: {
    readonly action?: "status" | "apply";
    readonly target?: DeployTarget;
  } = {},
): Promise<Record<string, unknown>> {
  const action = options.action ?? "apply";
  return await runIntegrationStorageDisposal(
    { action, environment: "integration", commit: COMMIT },
    options.target ?? target,
    {
      provider,
      state,
      ...(action === "apply" ? { run: processFixture, review: REVIEWER } : {}),
    },
  );
}

describe("integration storage disposal", () => {
  test("rejects production and arbitrary storage targets before any provider call", async () => {
    const provider = providerFixture();
    const state = stateFixture();
    const foreign = {
      ...target,
      environment: "production",
      d1: { databaseName: "takoserver-runtime-production", databaseId: DATABASE_ID },
      r2: { bucketName: "takoserver-objects-production" },
    } as DeployTarget;
    const arbitrary = {
      ...target,
      d1: { databaseName: "takoserver-runtime-production", databaseId: DATABASE_ID },
    } as DeployTarget;

    for (const selected of [foreign, arbitrary]) {
      await expect(execute(provider.provider, state, { target: selected })).rejects.toBeInstanceOf(
        DeployError,
      );
    }
    expect(provider.events).toEqual([]);
  });

  test("refuses failed or incomplete current-Worker inventory without writes", async () => {
    for (const state of [
      stateFixture({ failSettings: true }),
      stateFixture({ settings: {} }),
      stateFixture({
        settings: { bindings: [] },
        deployments: [
          {
            id: "deployment-1",
            created_on: "2026-01-01T00:00:00.000Z",
            versions: [{ version_id: "version-1", percentage: 100 }],
          },
        ],
        version: { resources: {} },
      }),
      stateFixture({ failDispatchInventory: true }),
      stateFixture({
        dispatchNamespaces: [{ namespace_name: "tenant-workers", script_count: 1 }],
        dispatchScripts: [],
      }),
    ]) {
      const provider = providerFixture();
      await expect(execute(provider.provider, state)).rejects.toBeInstanceOf(DeployError);
      expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
    }
  });

  test("blocks disposal for a binding from a current dispatch Worker", async () => {
    const provider = providerFixture();
    const state = stateFixture({
      dispatchNamespaces: [{ namespace_name: "tenant-workers", script_count: 1 }],
      dispatchScripts: [{ id: "tenant-worker-1" }],
      dispatchBindings: [{ name: "OBJECTS", type: "r2_bucket", bucket_name: BUCKET_NAME }],
    });

    await expect(execute(provider.provider, state)).rejects.toMatchObject({ phase: "preflight" });
    expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
  });

  test("reads unpaginated dispatch endpoint envelopes without pagination metadata", async () => {
    const provider = providerFixture();
    const requests: URL[] = [];
    const apiPrefix = `/client/v4/accounts/${ACCOUNT}`;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "fixture-token",
      fetcher: async (request) => {
        const url = new URL(request.url);
        requests.push(url);
        const path = url.pathname.slice(apiPrefix.length);
        const result =
          path === "/workers/scripts"
            ? []
            : path === "/workers/dispatch/namespaces"
              ? [{ namespace_name: "tenant-workers", script_count: 1 }]
              : path === "/workers/dispatch/namespaces/tenant-workers/scripts"
                ? [{ id: "tenant-worker-1" }]
                : path ===
                    "/workers/dispatch/namespaces/tenant-workers/scripts/tenant-worker-1/bindings"
                  ? [{ name: "OBJECTS", type: "r2_bucket", bucket_name: BUCKET_NAME }]
                  : (() => {
                      throw new Error(`unexpected Cloudflare request ${path}`);
                    })();
        return new Response(JSON.stringify({ success: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(execute(provider.provider, state)).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("current Worker binding"),
    });
    expect(requests.map((url) => url.pathname.slice(apiPrefix.length))).toEqual([
      "/workers/scripts",
      "/workers/dispatch/namespaces",
      "/workers/dispatch/namespaces/tenant-workers/scripts",
      "/workers/dispatch/namespaces/tenant-workers/scripts/tenant-worker-1/bindings",
    ]);
    expect(requests.every((url) => !url.searchParams.has("page"))).toBe(true);
    expect(requests.every((url) => !url.searchParams.has("per_page"))).toBe(true);
    expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
  });

  test("settings bind storage even when the Worker has no deployment history", async () => {
    const provider = providerFixture();
    const state = stateFixture({
      settings: { bindings: [{ name: "DB", type: "d1", id: DATABASE_ID }] },
      deployments: [],
    });

    await expect(execute(provider.provider, state)).rejects.toMatchObject({ phase: "preflight" });
    expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
  });

  test("rechecks exact identities and deletes R2 before D1 with authoritative absence", async () => {
    const provider = providerFixture();
    const result = await execute(provider.provider, stateFixture());

    expect(provider.events.filter((event) => event.startsWith("delete:"))).toEqual([
      `delete:r2:${BUCKET_NAME}`,
      `delete:d1:${DATABASE_ID}`,
    ]);
    expect(result).toMatchObject({
      deletedR2: true,
      deletedD1: true,
      verifiedAbsence: true,
      outcome: "disposed",
    });
  });

  test("a nonempty-bucket/provider rejection stops before D1", async () => {
    const provider = providerFixture({ deleteR2Error: new Error("R2 bucket is not empty") });

    await expect(execute(provider.provider, stateFixture())).rejects.toMatchObject({
      phase: "mutation",
      message: expect.stringContaining("D1 was not attempted"),
    });
    expect(provider.events.filter((event) => event.startsWith("delete:"))).toEqual([
      `delete:r2:${BUCKET_NAME}`,
    ]);
  });

  test("an indeterminate R2 acknowledgement is not retried or followed by D1 deletion", async () => {
    const provider = providerFixture({ deleteR2Error: new Error("connection lost") });

    await expect(execute(provider.provider, stateFixture())).rejects.toMatchObject({
      phase: "mutation",
      message: expect.stringContaining("acknowledgement is indeterminate"),
    });
    expect(provider.events.filter((event) => event.startsWith("delete:"))).toEqual([
      `delete:r2:${BUCKET_NAME}`,
    ]);
  });

  test("already-absent exact identities are a no-op", async () => {
    const provider = providerFixture({ initialDatabase: null, initialBucket: false });
    const result = await execute(provider.provider, stateFixture());

    expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
    expect(result).toMatchObject({
      deletedR2: false,
      deletedD1: false,
      verifiedAbsence: true,
      outcome: "already-absent",
    });
  });

  test("does not treat the selected D1 id under another name as absent", async () => {
    const provider = providerFixture({
      initialDatabase: null,
      databaseById: { name: "takoserver-runtime-renamed", uuid: DATABASE_ID },
    });

    await expect(execute(provider.provider, stateFixture())).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("selected D1 id exists under a different database name"),
    });
    expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
  });

  test("refuses a same-name D1 collision and never adopts its different id", async () => {
    const provider = providerFixture({
      initialDatabase: {
        name: DATABASE_NAME,
        uuid: "00000000-0000-4000-8000-000000000052",
      },
      databaseById: null,
    });

    await expect(execute(provider.provider, stateFixture())).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("collides with a different database id"),
    });
    expect(provider.events.some((event) => event.startsWith("delete:"))).toBe(false);
  });

  test("status reports regular and dispatch inventory coverage without review data", async () => {
    const provider = providerFixture();
    const result = await execute(
      provider.provider,
      stateFixture({
        dispatchNamespaces: [{ namespace_name: "tenant-workers", script_count: 1 }],
        dispatchScripts: [{ id: "tenant-worker-1" }],
      }),
      { action: "status" },
    );

    expect(result).toMatchObject({
      workerInventory: {
        coverage: "current-regular-and-dispatch-workers",
        coverageExcludes: ["historical-worker-versions", "external-api-clients"],
        regularScripts: 1,
        dispatchNamespaces: 1,
        dispatchScripts: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain(REVIEWER);
    expect(result).not.toHaveProperty("token");
  });
});
