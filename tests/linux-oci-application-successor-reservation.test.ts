import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

const reservations = "tf_v2_container_application_successors";
const insert = `INSERT INTO main.${reservations}`;

function replyToLiveInit(nativeId: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.defineProperties(new childProcess.ChildProcess(), {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  stdin.once("data", () => {
    const body = Buffer.from(
      JSON.stringify({
        kind: "linux-oci-parent-live-init@1",
        nativeId,
        namespaceDevice: "4",
        namespaceInode: "5",
        barrier: "unproven",
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    stdout.write(Buffer.concat([length, body]));
    stdout.emit("end");
    stderr.emit("end");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

async function withOriginal(
  check: (fixture: Awaited<ReturnType<typeof preparedOriginal>>) => Promise<void>,
) {
  const fixture = await preparedOriginal();
  try {
    await check(fixture);
    expect(fixture.f.network).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
}

async function preparedOriginal() {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  let fresh: ReturnType<typeof f.reconstructParent> | undefined;
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    const operation = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: operation.id,
      status: "succeeded",
      effect: "complete",
    });
    await f.composition.close();
    const original = f.recordedCreate();
    const selector = { resourceUid: operation.resourceUid, incarnationId: original.incarnationId };
    const signal = new AbortController().signal;
    fresh = f.reconstructParent();
    const raw = spyOn(childProcess, "spawn");
    const readLiveInit = bundle.readOriginalLinuxOciLiveInit;
    type Read = Parameters<typeof readLiveInit>;
    let custody: Read[0] | undefined;
    let core: Read[1] | undefined;
    const capture = spyOn(bundle, "readOriginalLinuxOciLiveInit").mockImplementationOnce(
      (...args) => {
        [custody, core] = args;
        return readLiveInit(...args);
      },
    );
    try {
      raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
      expect(await fresh.readCurrentLiveInit(selector, signal)).toMatchObject({
        nativeId: original.claimId,
      });
    } finally {
      capture.mockRestore();
    }
    if (!core || !custody) throw Error("genuine fresh Core and custody not captured");
    return {
      f,
      core,
      custody,
      fresh,
      selector,
      signal,
      raw,
      original,
      async expand() {
        await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);
      },
      async close() {
        await fresh?.close();
        await f.cleanup();
      },
    };
  } catch (error) {
    await fresh?.close();
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

test("authentic H0 and the still-current original peer reserve one opaque epoch", async () => {
  await withOriginal(
    async ({ f, core, custody, fresh, selector, signal, raw, original, expand }) => {
      const count = raw.mock.calls.length;
      await expect(
        core.reserveOriginalApplicationSuccessor(selector, custody, signal),
      ).rejects.toThrow();
      await expand();
      await expect(fresh.readCurrentLiveInit(selector, signal)).rejects.toThrow();
      await expect(core.reserveOriginalApplicationSuccessor(selector, {}, signal)).rejects.toThrow(
        /parent_custody/,
      );
      const closeRows = await f.sql.query(
        "SELECT close_document FROM tf_v2_container_shutdown_io_closes",
      );
      if (closeRows.length !== 1 || typeof closeRows[0]?.close_document !== "string")
        throw Error("missing genuine shutdown receipt");
      const predecessor = closeRows[0].close_document;
      const read = f.sql.query.bind(f.sql);
      const corrupt = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        if (
          !statement.startsWith(
            "SELECT close_document FROM main.tf_v2_container_shutdown_io_closes",
          )
        )
          return read(statement, params);
        const envelope = JSON.parse(predecessor);
        envelope.ciphertext = "A".repeat(envelope.ciphertext.length);
        return [{ close_document: JSON.stringify(envelope) }];
      });
      try {
        await expect(
          core.reserveOriginalApplicationSuccessor(selector, custody, signal),
        ).rejects.toThrow();
      } finally {
        corrupt.mockRestore();
      }
      expect(raw.mock.calls.length).toBe(count);
      expect(await f.sql.query(`SELECT * FROM ${reservations}`)).toEqual([]);
      raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
      const reservation = await core.reserveOriginalApplicationSuccessor(selector, custody, signal);
      expect(Object.isFrozen(reservation)).toBe(true);
      expect(Object.getPrototypeOf(reservation)).toBeNull();
      expect(Reflect.ownKeys(reservation)).toEqual([]);
      expect(raw.mock.calls.length).toBe(count + 1);
      expect(raw.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        f.physicalBinary,
        ["--parent-peer-read-live-init"],
      ]);
      expect(
        await f.sql.query(
          `SELECT epoch,claim_id,native_id,predecessor_close_document,close_document FROM ${reservations}`,
        ),
      ).toEqual([
        {
          epoch: 1,
          claim_id: original.claimId,
          native_id: original.claimId,
          predecessor_close_document: predecessor,
          close_document: null,
        },
      ]);
      expect(
        await f.sql.query("SELECT close_document FROM tf_v2_container_shutdown_io_closes"),
      ).toEqual(closeRows);
      await expect(
        core.reserveOriginalApplicationSuccessor(selector, custody, signal),
      ).rejects.toThrow();
      expect(raw.mock.calls.length).toBe(count + 1);
    },
  );
}, 20_000);

for (const fault of [
  "lost ACK",
  "abort",
  "stale START",
  "wrong readback",
  "closed creator",
  "schema changed before INSERT",
  "schema changed before readback",
  "late TEMP proof view",
] as const) {
  test(`application successor returns no reservation on ${fault}`, async () => {
    await withOriginal(async ({ f, core, custody, fresh, selector, raw, original, expand }) => {
      await expand();
      const controller = new AbortController();
      const count = raw.mock.calls.length;
      const run = f.sql.run.bind(f.sql);
      const missingWrite =
        fault === "stale START" ||
        fault === "schema changed before INSERT" ||
        fault === "late TEMP proof view";
      const addForeignTrigger = () =>
        run(
          `CREATE TRIGGER tf_v2_container_fixture_drift AFTER UPDATE ON ${reservations}
          BEGIN SELECT 1; END`,
        );
      const query = f.sql.query.bind(f.sql);
      const readback =
        fault === "wrong readback"
          ? spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
              const rows = await query(statement, params);
              if (!statement.startsWith("SELECT epoch,owner_token,predecessor_close_document"))
                return rows;
              expect(rows).toHaveLength(1);
              return rows.map((row) => ({ ...row, owner_token: "0".repeat(64) }));
            })
          : undefined;
      let writes = 0;
      const intercept = spyOn(f.sql, "run").mockImplementation(async (statement, params) => {
        if (!statement.startsWith(insert)) return run(statement, params);
        writes++;
        if (fault === "stale START") {
          expect(
            (
              await run(
                "UPDATE tf_v2_container_start_attempts SET state='exited',confirmed_exited_at_ms=confirmed_running_at_ms WHERE create_claim_id=? AND state='running'",
                [original.claimId],
              )
            ).changes,
          ).toBe(1);
        }
        if (fault === "schema changed before INSERT") await addForeignTrigger();
        if (fault === "late TEMP proof view")
          await run("CREATE TEMP VIEW tf_v2_resources AS SELECT * FROM main.tf_v2_resources");
        const ack = await run(statement, params);
        expect(ack.changes).toBe(missingWrite ? 0 : 1);
        if (fault === "lost ACK") throw Error("fixture reservation ACK lost after commit");
        if (fault === "abort") controller.abort();
        if (fault === "closed creator") {
          await fresh.close();
          expect(controller.signal.aborted).toBe(false);
        }
        if (fault === "schema changed before readback") await addForeignTrigger();
        return ack;
      });
      try {
        raw.mockReturnValueOnce(replyToLiveInit(original.claimId));
        await expect(
          core.reserveOriginalApplicationSuccessor(selector, custody, controller.signal),
        ).rejects.toThrow();
        expect(writes).toBe(1);
        expect(raw.mock.calls.length).toBe(count + 1);
        expect(await f.sql.query(`SELECT epoch, close_document FROM ${reservations}`)).toEqual(
          missingWrite ? [] : [{ epoch: 1, close_document: null }],
        );
        const freshSignal = new AbortController().signal;
        await expect(
          core.reserveOriginalApplicationSuccessor(selector, custody, freshSignal),
        ).rejects.toThrow();
        expect(writes).toBe(1);
        expect(raw.mock.calls.length).toBe(count + 1);
      } finally {
        intercept.mockRestore();
        readback?.mockRestore();
      }
    });
  }, 20_000);
}

test("a TEMP successor table never provides a reservation readback", async () => {
  await withOriginal(async ({ f, core, custody, selector, signal, raw, expand }) => {
    await expand();
    await f.sql.run(`CREATE TEMP TABLE ${reservations} (
      resource_uid TEXT, generation INTEGER, claim_id TEXT, native_id TEXT,
      epoch INTEGER, owner_token TEXT, predecessor_close_document TEXT, close_document TEXT
    )`);
    const calls = raw.mock.calls.length;
    // If a regressed path opens the reader, use only the existing raw mock.
    raw.mockReturnValueOnce(replyToLiveInit(f.recordedCreate().claimId));
    await expect(
      core.reserveOriginalApplicationSuccessor(selector, custody, signal),
    ).rejects.toThrow();
    expect(raw.mock.calls.length).toBe(calls);
    expect(await f.sql.query(`SELECT epoch FROM main.${reservations}`)).toEqual([]);
    expect(await f.sql.query(`SELECT epoch FROM temp.${reservations}`)).toEqual([]);
  });
}, 20_000);
