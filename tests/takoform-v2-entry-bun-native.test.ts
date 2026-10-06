import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode, bytesDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";

const OPT_IN = process.env.TAKOSERVER_V2_ENTRY_NATIVE === "1";
const PUBLIC_ORIGIN = "https://v2-entry.takoserver.test";
const PUBLIC_HOST = "v2-entry.takoserver.test";
const V2 = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/migration-manifest.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";
const MANIFEST_KEY = "operator-held/v2/manifest";
const FILE_KEY = "operator-held/v2/0001.sql";
const CURSOR_KEY = base64UrlEncode(new Uint8Array(32).fill(0x74));

type Child = ReturnType<typeof Bun.spawn>;
type Json = Record<string, unknown>;

function fixtureConfig(heldArtifacts?: readonly Json[]) {
  return JSON.stringify({
    documentation: "https://docs.example.test/takoform-v2",
    authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
    ...(heldArtifacts === undefined
      ? {}
      : {
          sqliteMigrationSet: {
            targetKey: "native-entry-local-sqlite-v1",
            heldArtifacts,
          },
        }),
  });
}

function requestAt(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", PUBLIC_HOST);
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
}

async function jsonAt(
  port: number,
  method: string,
  path: string,
  wantedStatus: number,
  body?: Json,
  headers: Record<string, string> = {},
): Promise<Json> {
  const response = await requestAt(port, path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== wantedStatus) {
    await response.arrayBuffer();
    throw new Error(`native v2 request returned ${response.status}, expected ${wantedStatus}`);
  }
  return (await response.json()) as Json;
}

async function choosePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not reserve a port");
  return port;
}

async function startHost(root: string, port: number, config: string): Promise<Child> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
      CI: "1",
      NO_COLOR: "1",
      PORT: String(port),
      TAKOSERVER_DATA_ROOT: root,
      TAKOSERVER_DB: join(root, "control.sqlite"),
      TAKOSERVER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: config,
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    },
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("normal Bun entry exited during startup");
      try {
        const ready = await requestAt(port, "/_takoserver/health/ready");
        await ready.arrayBuffer();
        if (ready.status === 200) return child;
      } catch {
        // The listener may not have bound yet.
      }
      await Bun.sleep(100);
    }
    throw new Error("normal Bun entry readiness deadline exceeded");
  } catch (error) {
    await stopHost(child);
    throw error;
  }
}

async function stopHost(child: Child | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const graceful = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (graceful !== null) return;
  child.kill("SIGKILL");
  await Promise.race([child.exited, Bun.sleep(3_000)]);
  throw new Error("normal Bun entry did not stop gracefully");
}

async function settled(port: number, token: string, operationId: string): Promise<Json> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const operation = await jsonAt(port, "GET", `${V2}/operations/${operationId}`, 200, undefined, {
      authorization: `Bearer ${token}`,
    });
    if (operation.status === "succeeded") return operation;
    if (operation.status === "failed") throw new Error("native v2 operation failed");
    await Bun.sleep(250);
  }
  throw new Error("native v2 operation settlement deadline exceeded");
}

test.skipIf(!OPT_IN)(
  "normal Bun entry serves v2 SQLite Migration Set over loopback behind a configured HTTPS authority",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-v2-entry-native-"));
    const port = await choosePort();
    let bootstrap: Child | null = null;
    let serving: Child | null = null;
    let cleanupFailed = false;
    try {
      // The first real entry creates the owner through control HTTP. Once its
      // opaque organization ID exists, the operator can grant held bytes to it.
      bootstrap = await startHost(root, port, fixtureConfig());
      const privateJwk = await readFile(join(root, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk,
        claims: {
          purpose: "sign-in",
          aud: PUBLIC_ORIGIN,
          provider: "google",
          subject: "v2-native-owner",
          email: "v2-native-owner@localhost",
          displayName: "V2 Native Owner",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await jsonAt(port, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      const sessionToken = String(session.sessionToken);
      const created = await jsonAt(
        port,
        "POST",
        "/v1/organizations",
        201,
        { name: "V2 native migration owner" },
        { authorization: `Bearer ${sessionToken}` },
      );
      const organizationId = String((created.organization as Json).id);
      const key = await jsonAt(
        port,
        "POST",
        `/v1/organizations/${organizationId}/api-keys`,
        201,
        { name: "v2 native writer", scopes: ["resources:write"], expiresInSeconds: 600 },
        { authorization: `Bearer ${sessionToken}` },
      );
      const secret = String(key.secret);
      await stopHost(bootstrap);
      bootstrap = null;

      const fileBytes = new TextEncoder().encode("CREATE TABLE must_not_execute (id INTEGER);\n");
      const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          files: [
            { path: "0001.sql", url: FILE_URL, sha256: fileSha256, mediaType: "application/sql" },
          ],
        }),
      );
      const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
      const objects = createFileObjectStore({ root });
      expect(
        await objects.create(MANIFEST_KEY, manifestBytes, { contentType: "application/json" }),
      ).not.toBeNull();
      expect(
        await objects.create(FILE_KEY, fileBytes, { contentType: "application/sql" }),
      ).not.toBeNull();
      const grants = [{ principal: `org:${organizationId}`, space: organizationId }];
      serving = await startHost(
        root,
        port,
        fixtureConfig([
          { url: MANIFEST_URL, sha256: manifestSha256, objectKey: MANIFEST_KEY, grants },
          { url: FILE_URL, sha256: fileSha256, objectKey: FILE_KEY, grants },
        ]),
      );
      expect((await requestAt(port, "/.well-known/takoform/v1")).status).toBe(404);
      expect((await requestAt(port, "/.well-known/takoform/v2")).status).toBe(200);
      const auth = { authorization: `Bearer ${secret}` };
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(SQLITE_MIGRATION_SET_FORM_URL)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({ supported: true });

      const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
      const create = await jsonAt(
        port,
        "POST",
        `${V2}/resources`,
        202,
        { form: SQLITE_MIGRATION_SET_FORM_URL, space: organizationId, name: "schema", spec },
        { ...auth, "idempotency-key": "native-entry-create-0001" },
      );
      const resourceUid = String(create.resourceUid);
      expect(await settled(port, secret, String(create.id))).toMatchObject({ effect: "complete" });
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${resourceUid}`, 200, undefined, auth),
      ).toMatchObject({ uid: resourceUid, generation: 1, observed: { manifestSha256 } });

      // Reading and same-spec update use SQL custody after the source is gone.
      expect(await objects.delete(MANIFEST_KEY)).toBe(true);
      expect(await objects.delete(FILE_KEY)).toBe(true);
      const update = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${resourceUid}`,
        202,
        { spec },
        {
          ...auth,
          "idempotency-key": "native-entry-update-0001",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, secret, String(update.id))).toMatchObject({ effect: "complete" });
      const deletion = await jsonAt(
        port,
        "DELETE",
        `${V2}/resources/${resourceUid}`,
        202,
        undefined,
        {
          ...auth,
          "idempotency-key": "native-entry-delete-0001",
          "takoform-expected-generation": "2",
        },
      );
      expect(await settled(port, secret, String(deletion.id))).toMatchObject({
        effect: "complete",
      });
      const gone = await requestAt(port, `${V2}/resources/${resourceUid}`, { headers: auth });
      expect(gone.status).toBe(410);
      await gone.arrayBuffer();
    } finally {
      const stops = await Promise.allSettled([stopHost(serving), stopHost(bootstrap)]);
      cleanupFailed = stops.some((result) => result.status === "rejected");
      await rm(root, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) throw new Error("native v2 child cleanup failed");
  },
  180_000,
);
