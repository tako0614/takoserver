import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";
const SENTINEL = "fixture-configured-secret-sentinel";

type Event = {
  stage: "listening" | "startup_error" | "tick_error";
  port?: number;
  pid?: number;
  restored?: string[];
  code?: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startHost(
  root: string,
  workerdBinary: string,
  organizationId: string,
  manifestSha: string,
  codeSha: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-worker-secret-server.ts"),
      root,
      workerdBinary,
      organizationId,
      manifestSha,
      codeSha,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
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
    await errors;
    reader.releaseLock();
  }
  try {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const listening = events.find((event) => event.stage === "listening");
      if (listening?.port && listening.pid) {
        return { close, port: listening.port, pid: listening.pid, restored: listening.restored };
      }
      const failure = events.find((event) => event.stage === "startup_error");
      if (failure) throw new Error(`configured Worker Host refused: ${failure.code}`);
      if (child.exitCode !== null)
        throw new Error("configured Worker Host exited before listening");
      await Bun.sleep(10);
    }
    throw new Error("configured Worker Host did not listen");
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
      host: "api.example.test",
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
    if (operation.status === "failed") throw new Error("configured Worker operation failed");
    await Bun.sleep(10);
  }
  throw new Error("configured Worker operation did not settle");
}

test.skipIf(binary === null)(
  "normal Host restart reopens the same configured Worker secret from Resource-owned custody",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-secret-restart-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "secret-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({ actor, name: "Secret Worker Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "secret worker writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      database.close();
      const objects = createFileObjectStore({ root: join(root, "objects") });
      const code = new TextEncoder().encode(
        "export default { fetch(_request, env) { return new Response(env.TOKEN + ':' + env.LABEL); } };\n",
      );
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: "https://artifacts.example.test/v2-secret/index.mjs",
              sha256: sha256(code),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      await objects.create("v2-secret/manifest", manifest);
      await objects.create("v2-secret/module", code);
      const manifestSha = sha256(manifest);
      const codeSha = sha256(code);
      first = await startHost(root, binary as string, organization.id, manifestSha, codeSha);
      expect(first.restored).toEqual([]);
      const initial = first;
      const create = async (form: string, name: string, spec: unknown, privateInputs?: unknown) => {
        const response = await request(
          initial.port,
          key.secret,
          `${API}/resources`,
          "POST",
          {
            form,
            space: organization.id,
            name,
            spec,
            ...(privateInputs === undefined ? {} : { privateInputs }),
          },
          `create-${name}-restart-secret`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(initial.port, key.secret, accepted.id);
        return accepted;
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: {
          url: "https://artifacts.example.test/v2-secret/bundle.json",
          sha256: manifestSha,
        },
      });
      const version = await create(
        WORKER_VERSION_FORM_URL,
        "version",
        {
          worker: { resourceUid: worker.resourceUid },
          bundle: { resourceUid: bundle.resourceUid },
          handlers: ["fetch"],
          vars: { LABEL: "public-label" },
          requiredSensitiveVars: ["TOKEN"],
        },
        { TOKEN: SENTINEL },
      );
      await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.resourceUid },
      });
      const before = await request(
        initial.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}`,
      );
      expect(before.status).toBe(200);
      expect((await before.text()) === `${SENTINEL}:public-label`).toBe(true);
      const ownerKey = createHash("sha256").update(worker.resourceUid).digest("hex");
      const state = JSON.parse(
        await readFile(join(root, "v2-worker-owners", ownerKey, "runtime-owner.json"), "utf8"),
      ) as { incarnations: { processIdentity: LinuxProcessIdentity | null }[] };
      const priorChildren = state.incarnations.flatMap((record) =>
        record.processIdentity ? [record.processIdentity] : [],
      );
      expect(priorChildren.length).toBeGreaterThan(0);
      const firstPid = initial.pid;
      await first.close();
      first = undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (await Promise.all(priorChildren.map(linuxProcessLiveness))).every(
            (result) => result === "stale",
          )
        )
          break;
        await Bun.sleep(10);
      }
      expect(await Promise.all(priorChildren.map(linuxProcessLiveness))).toEqual(
        priorChildren.map(() => "stale"),
      );
      second = await startHost(root, binary as string, organization.id, manifestSha, codeSha);
      expect(second.pid).not.toBe(firstPid);
      expect(second.restored).toEqual([worker.resourceUid]);
      const after = await request(
        second.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}`,
      );
      expect(after.status).toBe(200);
      expect((await after.text()) === `${SENTINEL}:public-label`).toBe(true);
      const publicVersion = await request(
        second.port,
        key.secret,
        `${API}/resources/${version.resourceUid}`,
      );
      expect(publicVersion.status).toBe(200);
      expect(JSON.stringify(await publicVersion.json()).includes(SENTINEL)).toBe(false);
    } finally {
      await second?.close();
      await first?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
