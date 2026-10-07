import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/apis/forms.takoform.com/v2";
const KEY = "private-process-create-key-0001";
const BODY = {
  form: "https://forms.example/restart-fixture/1",
  space: "fixture",
  name: "restart-fixture",
  spec: { value: "public-value" },
  privateInputs: { password: "fixture-only-secret-値" },
};
type Event = { stage: string; port?: number; operationId?: string };

async function start(root: string, stage: string, clockOffset = 0) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "helpers/takoform-v2-restart-server.ts"),
      join(root, "host.sqlite"),
      join(root, "backend.sqlite"),
      stage,
      String(clockOffset),
      "private-inputs",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const events: Event[] = [];
  const reader = child.stdout.getReader();
  let buffer = "";
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
  })();
  async function event(name: string): Promise<Event> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const found = events.find((entry) => entry.stage === name);
      if (found) return found;
      if (events.some((entry) => entry.stage === "executor_error"))
        throw new Error("executor failed");
      if (child.exitCode !== null) throw new Error(`fixture exited: ${await errors}`);
      await Bun.sleep(10);
    }
    throw new Error(`fixture did not reach ${name}`);
  }
  async function kill(): Promise<void> {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
    reader.releaseLock();
  }
  try {
    const ready = await event("listening");
    if (!ready.port) throw new Error("missing fixture port");
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
  bearer = "test-only-rotated",
): Promise<Response> {
  return fetch(`${origin}${ROOT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
}

async function waitStatus(origin: string, id: string, wanted: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(origin, `/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as Record<string, unknown>;
    if (operation.status === wanted) return operation;
    await Bun.sleep(10);
  }
  throw new Error(`Operation did not enter ${wanted}`);
}

for (const scenario of [
  { stage: "after_accept", offset: 0, expected: "succeeded" },
  { stage: "after_accept", offset: 120_000, expected: "waiting_input" },
  { stage: "after_effect", offset: 120_000, expected: "succeeded" },
  { stage: "after_dispatch", offset: 120_000, expected: "reconciling" },
] as const) {
  test(`private v2 HTTP ${scenario.stage} + ${scenario.offset}ms survives a new Host PID as ${scenario.expected}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "v2-private-process-"));
    let first: Awaited<ReturnType<typeof start>> | undefined;
    let second: Awaited<ReturnType<typeof start>> | undefined;
    try {
      first = await start(directory, scenario.stage);
      const lostAck = request(first.origin, "/resources", "POST", BODY, KEY, "test-only").catch(
        () => null,
      );
      const interrupted = await first.event(scenario.stage);
      if (!interrupted.operationId) throw new Error("missing accepted Operation id");
      const firstPid = first.child.pid;
      await first.kill();
      first = undefined;
      await lostAck;

      second = await start(directory, "none", scenario.offset);
      expect(second.child.pid).not.toBe(firstPid);
      const replay = await request(second.origin, "/resources", "POST", BODY, KEY);
      expect([200, 202]).toContain(replay.status);
      const same = (await replay.json()) as { id: string; resourceUid: string };
      expect(same.id).toBe(interrupted.operationId);

      const state = await waitStatus(second.origin, same.id, scenario.expected);
      if (scenario.expected === "waiting_input") {
        expect(state).toMatchObject({
          inputRequired: { names: ["password"], reason: "expired" },
        });
        const replenished = await request(
          second.origin,
          `/operations/${same.id}/private-inputs`,
          "PUT",
          { privateInputs: BODY.privateInputs },
        );
        expect(replenished.status).toBe(200);
        expect(await replenished.json()).toMatchObject({ id: same.id, status: "queued" });
        expect(await waitStatus(second.origin, same.id, "succeeded")).toMatchObject({
          id: same.id,
          effect: "complete",
        });
      }
      const backend = (await (await fetch(`${second.origin}/__fixture`)).json()) as {
        resources: unknown[];
        receipts: unknown[];
      };
      if (scenario.expected === "reconciling") {
        expect(backend.receipts).toHaveLength(0);
        expect(backend.resources).toHaveLength(0);
      } else {
        expect(backend.receipts).toHaveLength(1);
        expect(backend.resources).toHaveLength(1);
      }
    } finally {
      if (first) await first.kill();
      if (second) await second.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
