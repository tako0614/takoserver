import { expect, test } from "bun:test";
import { createWorkerEntry } from "../src/entry-worker.ts";

const message = "Host is quiesced for the Auth103 source registration transition";

function quiescentEnvironment(mode: string, extra: Record<string, unknown> = {}) {
  let effects = 0;
  const env = {
    TAKOSERVER_SCHEMA_MAINTENANCE_MODE: mode,
    ...extra,
  } as Parameters<ReturnType<typeof createWorkerEntry>["fetch"]>[1];
  for (const name of ["STATE_DB", "OBJECTS", "PUBLIC_ORIGIN", "WORKER_VERSION"] as const) {
    Object.defineProperty(env, name, {
      get(): never {
        effects++;
        throw new Error("quiescence reached application inputs");
      },
    });
  }
  return { env, effects: () => effects };
}

async function error(response: Response) {
  return (await response.json()) as {
    error: { code: string; message: string; details: { reason: string } };
  };
}

test("Auth103 quiescence returns the exact existing maintenance envelope before any HTTP App input", async () => {
  const entry = createWorkerEntry();
  const f = quiescentEnvironment("pre-auth103-quiesced");
  for (const route of ["/healthz", "/.well-known/takoserver", "/auth/oidc/session"]) {
    const response = await entry.fetch(
      new Request(`https://quiesced.example.invalid${route}`),
      f.env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await error(response);
    expect(body.error.code).toBe("backend_unavailable");
    expect(body.error.message).toBe(message);
    expect(body.error.details.reason).toBe("runtime-configuration");
  }
  expect(f.effects()).toBe(0);
});

test("Auth103 quiescence stops scheduled settlement before App or native inputs", async () => {
  const entry = createWorkerEntry();
  const f = quiescentEnvironment("pre-auth103-quiesced");
  await entry.scheduled({}, f.env);
  expect(f.effects()).toBe(0);
});

test("Auth103 quiescence does not bypass conflicting maintenance mode guards", async () => {
  const entry = createWorkerEntry();
  const f = quiescentEnvironment("pre-auth103-quiesced", {
    TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "pre-0043-quiesced",
  });
  const response = await entry.fetch(
    new Request("https://quiesced.example.invalid/healthz"),
    f.env,
  );
  expect(response.status).toBe(503);
  expect((await error(response)).error.message).not.toBe(message);
  await expect(entry.scheduled({}, f.env)).rejects.toThrow(
    "schema maintenance and artifact blob I/O modes conflict",
  );
  expect(f.effects()).toBe(0);
});

test("an unrecognized Auth103 mode is never treated as registered or quiesced", async () => {
  const entry = createWorkerEntry();
  const f = quiescentEnvironment("pre-auth103-quiesced-extra");
  const response = await entry.fetch(
    new Request("https://quiesced.example.invalid/healthz"),
    f.env,
  );
  expect(response.status).toBe(503);
  expect((await error(response)).error.message).not.toBe(message);
  await expect(entry.scheduled({}, f.env)).rejects.toThrow(
    "TAKOSERVER_SCHEMA_MAINTENANCE_MODE is invalid",
  );
  expect(f.effects()).toBe(0);
});

for (const [mode, expected] of [
  ["pre-0058-quiesced", "Host is quiesced for the 0058 schema maintenance transition"],
  ["pre-v2-0088-quiesced", "Host is quiesced for the v2 0088 schema maintenance transition"],
  [
    "pre-wallet-usd-micros-quiesced",
    "Host is quiesced for the wallet USD-micros schema maintenance transition",
  ],
] as const) {
  test(`existing ${mode} response and no-effect scheduling remain unchanged`, async () => {
    const entry = createWorkerEntry();
    const f = quiescentEnvironment(mode);
    const response = await entry.fetch(
      new Request("https://quiesced.example.invalid/healthz"),
      f.env,
    );
    expect(response.status).toBe(503);
    expect((await error(response)).error.message).toBe(expected);
    await entry.scheduled({}, f.env);
    expect(f.effects()).toBe(0);
  });
}
