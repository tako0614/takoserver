import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";

const API = "/apis/forms.takoform.com/v2";
const HOST = "api.example.test";
const CHILD_SOURCE = `
import { readFileSync } from "node:fs";
const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) throw new Error("unexpected command");
function identity() {
  const config = readFileSync(configPath, "utf8");
  const port = /address = "\\*:(\\d+)"/u.exec(config)?.[1];
  const generation = /\\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  const token = /\\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  if (!port || !generation || !token) throw new Error("invalid rendered config");
  return { port: Number(port), generation, token };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: identity().port, fetch(request) {
  const current = identity();
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
      url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
      request.headers.get("x-takoserver-selfhost-runtime-config") === current.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": current.generation } });
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
`;

type Event = {
  stage: "listening" | "startup_error" | "tick_error";
  port?: number;
  pid?: number;
  restored?: string[];
  code?: string;
};

async function startHost(
  root: string,
  binary: string,
  organizationId: string,
  manifestSha: string,
  fileSha: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-worker-composition-server.ts"),
      root,
      binary,
      organizationId,
      manifestSha,
      fileSha,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const events: Event[] = [];
  const reader = child.stdout.getReader();
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)) as Event);
        buffer = buffer.slice(end + 1);
      }
    }
  })();
  async function close() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await stderr;
    reader.releaseLock();
  }
  async function event(stage: Event["stage"]): Promise<Event> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const found = events.find((item) => item.stage === stage);
      if (found) return found;
      const failure = events.find((item) => item.stage === "startup_error");
      if (failure) throw new Error(`Host startup refused: ${failure.code}`);
      if (child.exitCode !== null) throw new Error(`Host exited before ${stage}: ${await stderr}`);
      await Bun.sleep(10);
    }
    throw new Error(`Host did not emit ${stage}`);
  }
  try {
    const listening = await event("listening");
    if (!listening.port || !listening.pid) throw new Error("Host omitted listener identity");
    return { close, event, port: listening.port, pid: listening.pid, restored: listening.restored };
  } catch (error) {
    await close();
    throw error;
  }
}

async function request(
  port: number,
  key: string,
  path: string,
  method = "GET",
  body?: unknown,
  replayKey?: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      host: HOST,
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(replayKey ? { "idempotency-key": replayKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function settled(port: number, key: string, operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const response = await request(port, key, `${API}/operations/${operationId}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as { status: string; effect: string };
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") throw new Error("Worker operation failed");
    await Bun.sleep(10);
  }
  throw new Error("Worker operation did not settle");
}

for (const checkpoint of ["retired", "retiring"] as const) {
  test(`normal buildApp HTTP restores the same accepted Worker graph after Host SIGKILL at ${checkpoint} checkpoint`, async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-restart-"));
    const binary = join(root, "bun-workerd-stand-in.js");
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const childSource =
        checkpoint === "retiring"
          ? CHILD_SOURCE.replace(
              'process.on("SIGTERM", () => server.stop(true));',
              'process.on("SIGTERM", () => {});',
            )
          : CHILD_SOURCE;
      await writeFile(binary, `#!${process.execPath}\n${childSource}`, { mode: 0o700 });
      await chmod(binary, 0o700);
      const database = new Database(join(root, "control.sqlite"));
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const accounts = createAccounts({
        sql,
        identity: {
          async verify({ assertion }: { assertion: string }) {
            return {
              providerSubject: assertion,
              email: `${assertion}@example.test`,
              displayName: assertion,
            };
          },
        },
      });
      const signedIn = await accounts.signIn({ provider: "google", assertion: "worker-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Worker Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "worker writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      database.close();
      const objects = createFileObjectStore({ root: join(root, "objects") });
      const file = new TextEncoder().encode("<main>restart-held asset</main>");
      const fileSha = (await bytesDigest(file)).slice(7);
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          files: [
            {
              path: "index.html",
              url: "https://artifacts.example.test/v2-worker/index.html",
              sha256: fileSha,
              mediaType: "text/html",
            },
          ],
        }),
      );
      const manifestSha = (await bytesDigest(manifest)).slice(7);
      await objects.create("v2-worker/manifest", manifest);
      await objects.create("v2-worker/index.html", file);
      first = await startHost(root, binary, organization.id, manifestSha, fileSha);
      const initial = first;
      expect(initial.restored).toEqual([]);
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          initial.port,
          key.secret,
          `${API}/resources`,
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-restart-worker`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(initial.port, key.secret, accepted.id);
        return accepted;
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const asset = await create(STATIC_ASSET_BUNDLE_FORM_URL, "asset", {
        artifact: {
          url: "https://artifacts.example.test/v2-worker/manifest.json",
          sha256: manifestSha,
        },
      });
      const version = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: worker.resourceUid },
        handlers: [],
        assets: {
          bundle: { resourceUid: asset.resourceUid },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      });
      const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.resourceUid },
      });
      const firstServe = await request(
        first.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}`,
      );
      expect(firstServe.status).toBe(200);
      const firstConfigIdentity = await firstServe.text();
      expect(firstConfigIdentity).toMatch(/^[0-9a-f]{64}$/u);
      const firstPid = first.pid;
      const ownerKey = createHash("sha256").update(worker.resourceUid).digest("hex");
      const statePath = join(root, "v2-worker-owners", ownerKey, "runtime-owner.json");
      type OwnerState = {
        incarnations: {
          operationId: string;
          status: string;
          receipt: unknown;
          processIdentity: LinuxProcessIdentity | null;
          executionCopiesReleased: boolean;
        }[];
      };
      let ownerState: OwnerState | null = null;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        ownerState = JSON.parse(await readFile(statePath, "utf8")) as OwnerState;
        const atCheckpoint =
          checkpoint === "retired"
            ? ownerState.incarnations.some((record) => record.status === "retired") &&
              ownerState.incarnations.every(
                (record) => record.status === "active" || record.status === "retired",
              )
            : ownerState.incarnations.some((record) => record.status === "retiring") &&
              ownerState.incarnations.some((record) => record.status === "active");
        if (atCheckpoint) break;
        await Bun.sleep(10);
      }
      if (
        !ownerState ||
        (checkpoint === "retired"
          ? !ownerState.incarnations.some((record) => record.status === "retired") ||
            ownerState.incarnations.some(
              (record) => record.status !== "active" && record.status !== "retired",
            )
          : !ownerState.incarnations.some((record) => record.status === "retiring"))
      ) {
        throw new Error(`old incarnation did not reach the ${checkpoint} checkpoint`);
      }
      if (checkpoint === "retired") {
        for (const retired of ownerState.incarnations.filter(
          (record) => record.status === "retired",
        )) {
          expect(retired.receipt).not.toBeNull();
          expect(retired.executionCopiesReleased).toBe(true);
        }
      }
      if (checkpoint === "retiring") {
        const pending = ownerState.incarnations.find((record) => record.status === "retiring");
        if (!pending) throw new Error("retiring incarnation missing");
        expect(pending.receipt).toBeNull();
        const retirementReceipt = join(
          root,
          "v2-worker-owners",
          ownerKey,
          "incarnations",
          pending.operationId,
          "groups",
          ownerKey,
          "retirement.json",
        );
        expect(await lstat(retirementReceipt).catch(() => null)).toBeNull();
      }
      const priorChildren = ownerState.incarnations.flatMap((record) =>
        record.processIdentity ? [record.processIdentity] : [],
      );
      if (priorChildren.length === 0) throw new Error("child identity was not persisted");
      await first.close();
      first = undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (await Promise.all(priorChildren.map(linuxProcessLiveness))).every(
            (item) => item === "stale",
          )
        )
          break;
        await Bun.sleep(10);
      }
      expect(await Promise.all(priorChildren.map(linuxProcessLiveness))).toEqual(
        priorChildren.map(() => "stale"),
      );
      second = await startHost(root, binary, organization.id, manifestSha, fileSha);
      expect(second.pid).not.toBe(firstPid);
      expect(second.restored).toEqual([worker.resourceUid]);
      const served = await request(
        second.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}`,
      );
      expect(served.status).toBe(200);
      const restoredConfigIdentity = await served.text();
      expect(restoredConfigIdentity).toMatch(/^[0-9a-f]{64}$/u);
      // The accepted graph identity stays exact across Host replacement;
      // per-process private readiness credentials are not this public digest.
      expect(restoredConfigIdentity).toBe(firstConfigIdentity);
      const endpointRead = await request(
        second.port,
        key.secret,
        `${API}/resources/${endpoint.resourceUid}`,
      );
      expect(endpointRead.status).toBe(200);
      expect(await endpointRead.json()).toMatchObject({
        uid: endpoint.resourceUid,
        output: { url: expect.stringMatching(/^https:\/\/worker-/u) },
      });
      expect(
        (await request(second.port, key.secret, `${API}/operations/${deployment.id}`)).status,
      ).toBe(200);
      await second.close();
      second = undefined;
      await rm(join(root, "v2-worker-owners", ownerKey), { recursive: true, force: true });
      await expect(startHost(root, binary, organization.id, manifestSha, fileSha)).rejects.toThrow(
        "missing_serving_owner",
      );
    } finally {
      await second?.close();
      await first?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
