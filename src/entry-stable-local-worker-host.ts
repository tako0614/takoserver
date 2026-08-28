import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { createTakoformHost } from "./takoform/host.ts";
import { createJavaScriptWorkerModuleInspector } from "./takoform/worker-module-inspector.ts";
import {
  createStableLocalS3Resolver,
  createStableLocalWorkerComposition,
  loadProviderEraTestCatalog,
} from "./worker-stable-local-composition.ts";

const STABLE_API_PATH = "/apis/forms.takoform.com/v1";
const STABLE_DISCOVERY_PATH = "/.well-known/takoform/v1";
const WORKER_KINDS = [
  "ModuleWorker",
  "WorkerBundle",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
] as const;

export interface StableLocalWorkerHost {
  readonly endpoint: string;
  readonly diagnosticRuntimeEndpoint: string;
  readonly space: string;
  readonly classification: "test-only-local-network-adapter";
  close(): Promise<void>;
}

/**
 * Starts a disposable stable-v1 Host and one-worker loopback runtime.
 *
 * This is deliberately not a production composition and does not prove public
 * WorkerEndpoint admission. It exists so a real Provider 3 binary can upload
 * bytes, apply the exact five-Form Edge worker chain, read the ordinary
 * WorkerEndpoint output, and send real HTTP traffic to those bytes without
 * relabeling the retained v1beta1 self-host backend as stable.
 */
export async function startStableLocalWorkerHost(input: {
  readonly takoformRepositoryRoot: string;
  readonly token: string;
  readonly space?: string;
  readonly port?: number;
}): Promise<StableLocalWorkerHost> {
  if (input.token.length < 16 || input.token.length > 4_096) {
    throw new Error("stable local Host token must contain 16-4096 characters");
  }
  const space = input.space ?? "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(space)) {
    throw new Error("stable local Host Space is invalid");
  }

  const catalog = await loadProviderEraTestCatalog(input.takoformRepositoryRoot);
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createMemoryObjectStore();
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock: () => new Date(),
    randomId: () => crypto.randomUUID(),
  });
  const dataRoot = await mkdtemp(join(tmpdir(), "takoserver-stable-local-host-"));

  let route = async (_request: Request): Promise<Response> =>
    new Response("stable local Host is starting\n", { status: 503 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    fetch: (request) => route(request),
  });
  const endpoint = new URL(server.url).origin;
  const composition = createStableLocalWorkerComposition({
    catalog,
    artifacts,
    dataRoot,
  });
  const forms = WORKER_KINDS.map((kind) => composition.form(kind));
  const host = createTakoformHost({
    sql,
    objects,
    artifacts,
    forms,
    driver: composition.driver,
    standardServiceResolver: createStableLocalS3Resolver(),
    workerModuleInspector: createJavaScriptWorkerModuleInspector(),
    authenticate: async (request) =>
      request.headers.get("authorization") === `Bearer ${input.token}`
        ? { tenantId: "org_stable_local", principalId: "provider3_local_e2e" }
        : null,
  });

  route = async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === STABLE_DISCOVERY_PATH) {
      return Response.json({
        api_versions: ["forms.takoform.com/v1"],
        features: {
          service_forms: true,
          exact_form_ref: true,
          optimistic_concurrency: true,
          idempotent_lifecycle: true,
          operations: true,
          artifact_upload: true,
          support_profiles: true,
        },
        endpoints: { api: `${endpoint}${STABLE_API_PATH}` },
      });
    }
    if (url.pathname === STABLE_API_PATH || url.pathname.startsWith(`${STABLE_API_PATH}/`)) {
      const response = (await host.handle(request)) ?? notFound();
      if (response.status >= 400) {
        console.error(
          JSON.stringify({
            event: "takoserver.stable_local_host.refused",
            method: request.method,
            path: url.pathname,
            status: response.status,
            body: await response.clone().text(),
          }),
        );
      }
      return response;
    }
    return await composition.dispatchPublished(request);
  };

  let closed = false;
  return {
    endpoint,
    diagnosticRuntimeEndpoint: endpoint,
    space,
    classification: "test-only-local-network-adapter",
    async close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      database.close();
      await composition.dispose();
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

function notFound(): Response {
  return Response.json(
    {
      error: {
        code: "not_found",
        message: "not found",
        requestId: "req_local",
      },
    },
    { status: 404 },
  );
}
