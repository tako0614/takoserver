import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Sql } from "../src/ports.ts";
import {
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createSelfhostDataPlanes, serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";

const TOKEN = "closing-plane-secret-000";
const GRANT = {
  secret: TOKEN,
  kv: {},
  sql: { DB: "close-db", DB2: "close-db-two" },
  queue: {},
  objects: {},
} as const;

const unusedControlSql: Sql = {
  async query() {
    return [];
  },
  async run() {
    return { rows: [], changes: 0 };
  },
  async batch() {
    return [];
  },
};

function descriptorsFor(path: string): string[] {
  const descriptorRoot = "/proc/self/fd";
  return readdirSync(descriptorRoot).flatMap((descriptor) => {
    try {
      const target = readlinkSync(join(descriptorRoot, descriptor));
      return target === path ? [descriptor] : [];
    } catch {
      return [];
    }
  });
}

async function sql(
  address: string,
  statement: { readonly sql: string; readonly params?: readonly unknown[] },
  binding = "DB",
): Promise<Response> {
  const body = JSON.stringify({
    protocol: SELFHOST_DATA_PLANE_PROTOCOL,
    binding,
    op: "execute",
    statement,
  });
  return await fetch(`http://${address}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer close.v1.${TOKEN}`,
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
}

test("stopping the self-host data plane closes its SQLite handles and preserves every database", async () => {
  const root = mkdtempSync(join(tmpdir(), "takoserver-data-plane-close-"));
  const path = resolve(join(root, "close-db.sqlite"));
  const secondPath = resolve(join(root, "close-db-two.sqlite"));
  const seeded = new Database(path);
  seeded.exec(
    "CREATE TABLE retained (value TEXT NOT NULL); " +
      "INSERT INTO retained (value) VALUES ('seeded-before-close')",
  );
  seeded.close();
  const secondSeeded = new Database(secondPath);
  secondSeeded.exec(
    "CREATE TABLE retained (value TEXT NOT NULL); " +
      "INSERT INTO retained (value) VALUES ('second-seeded-before-close')",
  );
  secondSeeded.close();
  const served = serveSelfhostDataPlanes({
    sql: unusedControlSql,
    grant: async (script, versionId) => (script === "close" && versionId === "v1" ? GRANT : null),
    databasePath: (name) => join(root, `${name}.sqlite`),
    objectRoot: join(root, "objects"),
  });

  try {
    expect(
      (
        await sql(served.address, {
          sql: "INSERT INTO retained (value) VALUES (?)",
          params: ["survives-close"],
        })
      ).status,
    ).toBe(200);
    expect(descriptorsFor(path)).toHaveLength(1);
    expect(
      (
        await sql(
          served.address,
          {
            sql: "INSERT INTO retained (value) VALUES (?)",
            params: ["second-survives-close"],
          },
          "DB2",
        )
      ).status,
    ).toBe(200);
    expect(descriptorsFor(secondPath)).toHaveLength(1);

    const stopping = served.stop(true);
    expect(served.stop(true)).toBe(stopping);
    await stopping;
    await served.stop(true);

    expect(descriptorsFor(path)).toEqual([]);
    expect(descriptorsFor(secondPath)).toEqual([]);
    const reopened = new Database(path);
    try {
      expect(reopened.query("SELECT value FROM retained").all()).toEqual([
        { value: "seeded-before-close" },
        { value: "survives-close" },
      ]);
    } finally {
      reopened.close();
    }
    const secondReopened = new Database(secondPath);
    try {
      expect(secondReopened.query("SELECT value FROM retained").all()).toEqual([
        { value: "second-seeded-before-close" },
        { value: "second-survives-close" },
      ]);
    } finally {
      secondReopened.close();
    }
  } finally {
    await served.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("close is bounded by pending bodies and fences late SQLite handle allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "takoserver-data-plane-drain-"));
  const path = resolve(join(root, "close-db.sqlite"));
  const seeded = new Database(path);
  seeded.exec(
    "CREATE TABLE retained (value TEXT NOT NULL); " +
      "INSERT INTO retained (value) VALUES ('seeded-before-close')",
  );
  seeded.close();
  const planes = createSelfhostDataPlanes({
    sql: unusedControlSql,
    grant: async (script, versionId) => (script === "close" && versionId === "v1" ? GRANT : null),
    databasePath: (name) => join(root, `${name}.sqlite`),
    objectRoot: join(root, "objects"),
  });
  let releaseBody: (() => void) | undefined;

  try {
    expect(descriptorsFor(path)).toEqual([]);
    const priorBody = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "execute",
      statement: {
        sql: "INSERT INTO retained (value) VALUES (?)",
        params: ["before-close"],
      },
    });
    const priorRequest = new Request(`http://plane.invalid${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer close.v1.${TOKEN}`,
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(priorBody).byteLength),
      },
      body: priorBody,
    });
    const priorResponse = await planes.routes(priorRequest, new URL(priorRequest.url));
    expect(priorResponse?.status).toBe(200);
    expect(await priorResponse?.json()).toMatchObject({ ok: true });
    expect(descriptorsFor(path)).toHaveLength(1);
    const statement = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "execute",
      statement: {
        sql: "INSERT INTO retained (value) VALUES (?)",
        params: ["accepted-before-close"],
      },
    });
    const bytes = new TextEncoder().encode(statement);
    const split = Math.max(1, Math.floor(bytes.byteLength / 2));
    const bodyRemainder = new Promise<void>((resolveBody) => {
      releaseBody = () => resolveBody();
    });
    let bodyReadWaiting!: () => void;
    const bodyReaderWaiting = new Promise<void>((resolveWaiting) => {
      bodyReadWaiting = resolveWaiting;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
      },
      async pull(controller) {
        bodyReadWaiting();
        await bodyRemainder;
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });
    const pendingRequest = new Request(`http://plane.invalid${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer close.v1.${TOKEN}`,
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
      },
      body,
    });
    const pendingRoute = planes.routes(pendingRequest, new URL(pendingRequest.url));
    await bodyReaderWaiting;

    const closing = planes.close();
    expect(planes.close()).toBe(closing);
    await closing;
    expect(descriptorsFor(path)).toEqual([]);
    releaseBody?.();
    const response = await pendingRoute;
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: false, error: { code: "backend_unavailable" } });

    expect(descriptorsFor(path)).toEqual([]);
    const reopened = new Database(path);
    try {
      expect(reopened.query("SELECT value FROM retained").all()).toEqual([
        { value: "seeded-before-close" },
        { value: "before-close" },
      ]);
    } finally {
      reopened.close();
    }
    await planes.close();
  } finally {
    releaseBody?.();
    await planes.close();
    rmSync(root, { recursive: true, force: true });
  }
});
