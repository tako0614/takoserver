import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";

const API = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/manifest.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";
type Event = { stage: string; port?: number; operationId?: string };

async function start(
  root: string,
  stage: "dispatch" | "normal",
  manifestSha256: string,
  fileSha256: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "helpers/takoform-v2-migration-set-restart-worker.ts"),
      root,
      stage,
      manifestSha256,
      fileSha256,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const events: Event[] = [];
  const reader = child.stdout.getReader();
  let buffer = "";
  let readingError: unknown;
  const reading = (async () => {
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
  })().catch((error: unknown) => {
    readingError = error;
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
    reader.releaseLock();
  }
  async function event(name: string): Promise<Event> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const found = events.find((value) => value.stage === name);
      if (found) return found;
      if (readingError) throw new Error(`fixture output failed before ${name}`);
      if (events.some((value) => value.stage === "executor_error")) {
        throw new Error("fixture executor failed");
      }
      if (child.exitCode !== null)
        throw new Error(`fixture exited before ${name}: ${await errors}`);
      await Bun.sleep(10);
    }
    throw new Error(`fixture did not reach ${name}`);
  }
  try {
    const listening = await event("listening");
    if (!listening.port) throw new Error("fixture omitted port");
    return { child, event, close, origin: `http://127.0.0.1:${listening.port}` };
  } catch (error) {
    await close();
    throw error;
  }
}

async function request(
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  generation?: number,
) {
  return fetch(`${origin}${API}${path}`, {
    method,
    headers: {
      authorization: "Bearer test-only",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      ...(generation ? { "takoform-expected-generation": String(generation) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
}

async function terminal(origin: string, id: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(origin, `/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as {
      id: string;
      status: string;
      resourceUid: string;
    };
    if (operation.status === "succeeded" || operation.status === "failed") return operation;
    await Bun.sleep(10);
  }
  throw new Error("fixture Operation did not settle");
}

test("real HTTP Host restarts after verified custody and finishes read, update, delete without source", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-migration-set-restart-"));
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const sqlBytes = new TextEncoder().encode("CREATE TABLE not_applied (id INTEGER);\n");
    const fileSha256 = (await bytesDigest(sqlBytes)).slice(7);
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [
          {
            path: "migrations/0001.sql",
            url: FILE_URL,
            sha256: fileSha256,
            mediaType: "application/sql",
          },
        ],
      }),
    );
    const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
    const objects = createFileObjectStore({ root: join(root, "objects") });
    await objects.put("fixture/manifest", manifestBytes);
    await objects.put("fixture/0001", sqlBytes);
    const input = {
      form: SQLITE_MIGRATION_SET_FORM_URL,
      space: "default",
      name: "migration-set",
      spec: { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } },
    };

    first = await start(root, "dispatch", manifestSha256, fileSha256);
    const createdResponse = await request(
      first.origin,
      "/resources",
      "POST",
      input,
      "os-restart-create-key-0001",
    );
    expect(createdResponse.status).toBe(202);
    const created = (await createdResponse.json()) as { id: string; resourceUid: string };
    const verified = await first.event("verified");
    expect(verified.operationId).toBe(created.id);
    const firstPid = first.child.pid;
    await first.close();
    first = undefined;

    await objects.delete("fixture/manifest");
    await objects.delete("fixture/0001");
    expect(await objects.get("fixture/manifest")).toBeNull();
    expect(await objects.get("fixture/0001")).toBeNull();

    second = await start(root, "normal", manifestSha256, fileSha256);
    expect(second.child.pid).not.toBe(firstPid);
    expect((await terminal(second.origin, created.id)).status).toBe("succeeded");
    const replay = await request(
      second.origin,
      "/resources",
      "POST",
      input,
      "os-restart-create-key-0001",
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: created.id, resourceUid: created.resourceUid });
    const resourceResponse = await request(second.origin, `/resources/${created.resourceUid}`);
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toMatchObject({
      uid: created.resourceUid,
      generation: 1,
      observedGeneration: 1,
      observed: { manifestSha256, fileCount: 1, totalBytes: sqlBytes.byteLength },
      output: {},
    });

    const update = await request(
      second.origin,
      `/resources/${created.resourceUid}`,
      "PUT",
      { spec: input.spec },
      "os-restart-update-key-0001",
      1,
    );
    expect(update.status).toBe(202);
    const updateId = ((await update.json()) as { id: string }).id;
    expect((await terminal(second.origin, updateId)).status).toBe("succeeded");
    expect(
      await (await request(second.origin, `/resources/${created.resourceUid}`)).json(),
    ).toMatchObject({
      uid: created.resourceUid,
      generation: 2,
      observedGeneration: 2,
    });

    const deletion = await request(
      second.origin,
      `/resources/${created.resourceUid}`,
      "DELETE",
      undefined,
      "os-restart-delete-key-0001",
      2,
    );
    expect(deletion.status).toBe(202);
    const deletionId = ((await deletion.json()) as { id: string }).id;
    expect((await terminal(second.origin, deletionId)).status).toBe("succeeded");
    expect((await request(second.origin, `/resources/${created.resourceUid}`)).status).toBe(410);
    await second.close();
    second = undefined;

    const db = new Database(join(root, "control.sqlite"));
    try {
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'not_applied'").get(),
      ).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM tf_v2_migration_set_owners").get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
