import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/apis/forms.takoform.com/v2";
const KEY = "restart-create-key-0001";
const INPUT = {
  form: "https://forms.example/restart-fixture/1",
  space: "fixture",
  name: "restart-fixture",
  spec: { value: "first" },
};
type Event = { stage: string; port?: number; operationId?: string };

async function start(root: string, stage: string, offset = 0) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "helpers/takoform-v2-restart-server.ts"),
      join(root, "host.sqlite"),
      join(root, "backend.sqlite"),
      stage,
      String(offset),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const events: Event[] = [];
  let buffer = "";
  const reader = child.stdout.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, index)) as Event);
        buffer = buffer.slice(index + 1);
      }
    }
  })();
  async function event(name: string): Promise<Event> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const found = events.find((entry) => entry.stage === name);
      if (found) return found;
      if (events.some((entry) => entry.stage === "executor_error"))
        throw new Error("fixture executor failed");
      if (child.exitCode !== null) throw new Error(`fixture exited: ${await errors}`);
      await Bun.sleep(10);
    }
    throw new Error(`fixture did not reach ${name}`);
  }
  async function kill() {
    child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
  }
  try {
    const ready = await event("listening");
    return { child, event, kill, origin: `http://127.0.0.1:${ready.port}` };
  } catch (error) {
    await kill();
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
  return await fetch(`${origin}${ROOT}${path}`, {
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

async function settled(origin: string, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(origin, `/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as {
      id: string;
      resourceUid: string;
      generation: number;
      status: string;
    };
    if (operation.status === "succeeded" || operation.status === "failed") return operation;
    await Bun.sleep(10);
  }
  throw new Error("fixture operation did not settle");
}

for (const stage of ["after_accept", "after_dispatch", "after_effect"]) {
  test(`v2 HTTP recovers after real process death ${stage}, without duplicate or orphan fixture effects`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "takoform-v2-restart-"));
    let first: Awaited<ReturnType<typeof start>> | undefined;
    let restarted: Awaited<ReturnType<typeof start>> | undefined;
    try {
      first = await start(directory, stage);
      const lostResponse = request(first.origin, "/resources", "POST", INPUT, KEY).catch(
        () => null,
      );
      const interrupted = await first.event(stage);
      if (!interrupted.operationId) throw new Error("fault point omitted its operation identity");
      const firstPid = first.child.pid;
      await first.kill();
      first = undefined;
      await lostResponse;

      // Preserve both DBs and advance the test clock beyond the old claim.
      restarted = await start(directory, "none", 120_000);
      expect(restarted.child.pid).not.toBe(firstPid);
      const replay = await request(restarted.origin, "/resources", "POST", INPUT, KEY);
      expect([200, 202]).toContain(replay.status);
      const accepted = (await replay.json()) as { id: string; resourceUid: string };
      expect(accepted.id).toBe(interrupted.operationId);
      const created = await settled(restarted.origin, accepted.id);
      expect(created.status).toBe("succeeded");
      expect(created.generation).toBe(1);
      const resource = await (
        await request(restarted.origin, `/resources/${accepted.resourceUid}`)
      ).json();
      expect(resource).toMatchObject({
        generation: 1,
        observedGeneration: 1,
        spec: { value: "first" },
      });

      const update = await request(
        restarted.origin,
        `/resources/${accepted.resourceUid}`,
        "PUT",
        { spec: { value: "second" } },
        "restart-update-key-0001",
        1,
      );
      expect([200, 202]).toContain(update.status);
      const updatedId = ((await update.json()) as { id: string }).id;
      expect((await settled(restarted.origin, updatedId)).status).toBe("succeeded");
      const updated = await (
        await request(restarted.origin, `/resources/${accepted.resourceUid}`)
      ).json();
      expect(updated).toMatchObject({
        generation: 2,
        observedGeneration: 2,
        observed: { value: "second" },
      });

      const remove = await request(
        restarted.origin,
        `/resources/${accepted.resourceUid}`,
        "DELETE",
        undefined,
        "restart-delete-key-0001",
        2,
      );
      expect([200, 202]).toContain(remove.status);
      const removedId = ((await remove.json()) as { id: string }).id;
      expect((await settled(restarted.origin, removedId)).status).toBe("succeeded");
      const deleteReplay = await request(
        restarted.origin,
        `/resources/${accepted.resourceUid}`,
        "DELETE",
        undefined,
        "restart-delete-key-0001",
        2,
      );
      expect(deleteReplay.status).toBe(200);
      expect(await deleteReplay.json()).toMatchObject({
        id: removedId,
        status: "succeeded",
        generation: 3,
      });
      const list = await (await request(restarted.origin, "/resources")).json();
      expect(list).toEqual({ items: [], nextCursor: null });
      const backend = (await (await fetch(`${restarted.origin}/__fixture`)).json()) as {
        resources: unknown[];
        receipts: { action: string }[];
      };
      expect(backend.resources).toEqual([]);
      expect(backend.receipts.map((receipt) => receipt.action).sort()).toEqual([
        "create",
        "delete",
        "update",
      ]);
    } finally {
      if (first) await first.kill();
      if (restarted) await restarted.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
