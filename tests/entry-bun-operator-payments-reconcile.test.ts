/**
 * The Bun entry serves the operator reconcile route exactly where the reconcile
 * pass runs and an operator key can authorize it, and nowhere else.
 */
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";

const ORIGIN = "https://operator-reconcile-entry.takoserver.test";
const ENTRY = join(import.meta.dir, "..", "src", "entry-bun.ts");
const PATH = "/v1/operator/payments/reconcile";

function baseEnvironment(home: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    CI: "1",
    NO_COLOR: "1",
    PORT: String(port),
    TAKOSERVER_DATA_ROOT: join(home, "data"),
    TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x74)),
  };
}

async function unusedPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

async function ready(child: ReturnType<typeof Bun.spawn>, port: number): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.status === 200) return true;
    } catch {
      // The listener may not have bound yet.
    }
    await Bun.sleep(50);
  }
  return false;
}

/** Boots the Bun entry with `extra`, answers `probe`, and always stops it. */
async function withHost(
  extra: Record<string, string>,
  probe: (post: (body?: unknown) => Promise<{ status: number; code?: string }>) => Promise<void>,
): Promise<void> {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "operator-reconcile-entry-")));
  const port = await unusedPort();
  const child = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
    cwd: base,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...baseEnvironment(base, port), ...extra },
  });
  try {
    if (!(await ready(child, port))) {
      throw new Error(`Bun entry did not become ready: ${await new Response(child.stderr).text()}`);
    }
    await probe(async (body) => {
      const response = await fetch(`http://127.0.0.1:${port}${PATH}`, {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const parsed = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      return {
        status: response.status,
        ...(parsed?.error?.code ? { code: parsed.error.code } : {}),
      };
    });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
      if (code === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    await rm(base, { recursive: true, force: true });
  }
}

test("without Stripe the Bun entry does not serve the route", async () => {
  // A fresh machine mints an operator key, so only the missing pass gates it.
  await withHost({}, async (post) => {
    expect(await post({ assertion: "not.checked" })).toEqual({ status: 404, code: "not_found" });
  });
}, 90_000);

test("without an operator key the Bun entry does not serve the route", async () => {
  // A configured identity provider suppresses the generated operator key.
  await withHost(
    { STRIPE_SECRET_KEY: "sk_test_entry_probe", GOOGLE_CLIENT_ID: "entry-probe.apps.test" },
    async (post) => {
      expect(await post({ assertion: "not.checked" })).toEqual({
        status: 404,
        code: "not_found",
      });
    },
  );
}, 90_000);

test("with Stripe and an operator key the Bun entry serves and verifies the route", async () => {
  await withHost({ STRIPE_SECRET_KEY: "sk_test_entry_probe" }, async (post) => {
    expect(await post()).toEqual({ status: 400, code: "invalid_argument" });
    // Refused by the operator verifier before Stripe could be asked.
    expect(await post({ assertion: "not.an-assertion" })).toEqual({
      status: 401,
      code: "unauthenticated",
    });
  });
}, 90_000);
