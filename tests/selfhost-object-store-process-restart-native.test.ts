import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = `tsb-${"d".repeat(40)}`;
const FOREIGN_BUCKET = `tsb-${"e".repeat(40)}`;
const KEY = "restart/receipt.bin";
const SELECTED_BYTES = "the committed multipart part survives a process boundary";
const CHILD_DEADLINE_MS = 28_000;
const CHILD_KILL_WAIT_MS = 1_500;

const producerSource = `
import { Database } from "bun:sqlite";
import { migrateSqlite } from ${JSON.stringify(new URL("../src/migrate-sqlite.ts", import.meta.url).href)};
import { createSelfhostObjectStore } from ${JSON.stringify(new URL("../src/selfhost-object-store.ts", import.meta.url).href)};
import { createSqliteSql } from ${JSON.stringify(new URL("../src/sql-sqlite.ts", import.meta.url).href)};

const root = process.env.OBJECT_ROOT;
const databasePath = process.env.DATABASE_PATH;
const bucket = process.env.BUCKET;
const key = process.env.OBJECT_KEY;
const selectedBytes = process.env.SELECTED_BYTES;
if (!root || !databasePath || !bucket || !key || !selectedBytes) throw new Error("missing fixture input");

const database = new Database(databasePath);
try {
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const uploadStore = createSelfhostObjectStore({ sql, root });
  const upload = await uploadStore.createMultipartUpload(bucket, key);
  let injectCommittedAckLoss = true;
  let injectReadbackLoss = false;
  const lostAckSql = {
    async query(statement, params) {
      if (injectReadbackLoss && statement.includes("SELECT size, etag FROM selfhost_object_upload_parts")) {
        injectReadbackLoss = false;
        throw new Error("injected readback loss");
      }
      return await sql.query(statement, params);
    },
    async run(statement, params) {
      const result = await sql.run(statement, params);
      if (injectCommittedAckLoss && statement.includes("INSERT INTO selfhost_object_upload_parts")) {
        injectCommittedAckLoss = false;
        injectReadbackLoss = true;
        throw new Error("injected lost caller acknowledgement after SQL commit");
      }
      return result;
    },
    batch(statements) {
      return sql.batch(statements);
    },
  };
  let observedCode;
  try {
    await createSelfhostObjectStore({ sql: lostAckSql, root }).uploadPart(
      bucket,
      key,
      upload.uploadId,
      1,
      new Blob([selectedBytes]).stream(),
      { contentLength: new TextEncoder().encode(selectedBytes).byteLength },
    );
  } catch (error) {
    observedCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  }
  if (observedCode !== "backend_unavailable") throw new Error("producer did not observe the injected acknowledgement loss");
  console.log(JSON.stringify({ pid: process.pid, uploadId: upload.uploadId, ackLossSimulated: true }));
} finally {
  database.close();
}
`;

const consumerSource = `
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrateSqlite } from ${JSON.stringify(new URL("../src/migrate-sqlite.ts", import.meta.url).href)};
import { createSelfhostObjectStore } from ${JSON.stringify(new URL("../src/selfhost-object-store.ts", import.meta.url).href)};
import { createSqliteSql } from ${JSON.stringify(new URL("../src/sql-sqlite.ts", import.meta.url).href)};

const root = process.env.OBJECT_ROOT;
const databasePath = process.env.DATABASE_PATH;
const bucket = process.env.BUCKET;
const foreignBucket = process.env.FOREIGN_BUCKET;
const key = process.env.OBJECT_KEY;
const selectedBytes = process.env.SELECTED_BYTES;
const uploadId = process.env.UPLOAD_ID;
const producerPid = Number(process.env.PRODUCER_PID);
if (!root || !databasePath || !bucket || !foreignBucket || !key || !selectedBytes || !uploadId) {
  throw new Error("missing fixture input");
}
if (!Number.isInteger(producerPid) || producerPid === process.pid) throw new Error("consumer PID is not distinct");

const database = new Database(databasePath);
try {
  migrateSqlite(database);
  const store = createSelfhostObjectStore({ sql: createSqliteSql(database), root });
  const expectedEtag = createHash("sha256").update(selectedBytes).digest("hex");
  const partDirectory = join(root, bucket, "u", uploadId);
  const persistedPartPath = join(partDirectory, "1-" + expectedEtag);
  const persistedPart = await readFile(persistedPartPath);
  if (persistedPart.toString("utf8") !== selectedBytes) throw new Error("persisted part bytes differ from selected bytes");
  const countPartFiles = async () => (await readdir(partDirectory)).length;
  const filesBeforeReplay = await countPartFiles();
  if (filesBeforeReplay !== 1) throw new Error("unexpected part file count before replay");

  let foreignBucketRefused = false;
  try {
    await store.uploadPart(
      foreignBucket,
      key,
      uploadId,
      1,
      new Blob([selectedBytes]).stream(),
      { contentLength: new TextEncoder().encode(selectedBytes).byteLength },
    );
  } catch (error) {
    foreignBucketRefused = error && typeof error === "object" && "code" in error && error.code === "upload_not_found";
  }
  if (!foreignBucketRefused) throw new Error("foreign bucket scope was not refused");

  let foreignKeyRefused = false;
  try {
    await store.completeMultipartUpload(bucket, key + "-foreign", uploadId, [{ etag: expectedEtag, partNumber: 1 }]);
  } catch (error) {
    foreignKeyRefused = error && typeof error === "object" && "code" in error && error.code === "upload_not_found";
  }
  if (!foreignKeyRefused) throw new Error("foreign upload scope was not refused");

  const replayReceipts = [];
  for (let replay = 0; replay < 3; replay += 1) {
    replayReceipts.push(await store.uploadPart(
      bucket,
      key,
      uploadId,
      1,
      new Blob([selectedBytes]).stream(),
      { contentLength: new TextEncoder().encode(selectedBytes).byteLength },
    ));
    if (await countPartFiles() !== filesBeforeReplay) throw new Error("same-part replay accumulated files");
  }
  if (replayReceipts.some((receipt) => receipt.etag !== expectedEtag || receipt.partNumber !== 1)) {
    throw new Error("same-part replay returned a different receipt");
  }

  const completed = await store.completeMultipartUpload(bucket, key, uploadId, [replayReceipts[0]]);
  const object = await store.get(bucket, key);
  if (!object) throw new Error("completed object is missing");
  const actualBytes = await new Response(object.body).text();
  if (actualBytes !== selectedBytes || completed.size !== new TextEncoder().encode(selectedBytes).byteLength) {
    throw new Error("completed object bytes differ from selected bytes");
  }
  const partDirectoryRemoved = await stat(partDirectory).then(() => false, () => true);
  if (!partDirectoryRemoved) throw new Error("completed upload retained part files");
  console.log(JSON.stringify({
    pid: process.pid,
    producerPid,
    distinctPids: true,
    persistedBytesMatch: true,
    replayCount: replayReceipts.length,
    replayFileCountStable: true,
    completedGetBytesMatch: true,
    partDirectoryRemoved,
    foreignBucketRefused,
    foreignUploadScopeRefused: foreignKeyRefused,
  }));
} finally {
  database.close();
}
`;

interface ChildResult {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly terminationConfirmed: boolean;
}

async function runChild(
  source: string,
  env: Record<string, string>,
  timeoutMs = CHILD_DEADLINE_MS,
): Promise<ChildResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", source],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  type ExitResult =
    | { readonly kind: "exited"; readonly exitCode: number }
    | { readonly kind: "unknown" };
  const exited: Promise<ExitResult> = child.exited.then(
    (exitCode) => ({ kind: "exited", exitCode }),
    () => ({ kind: "unknown" }),
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const first = await Promise.race([exited, deadline]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);

  const timedOut = first.kind === "timeout";
  let terminationConfirmed = first.kind === "exited";
  let exitCode = first.kind === "exited" ? first.exitCode : null;
  if (timedOut) {
    // This handle owns only the exact subprocess created above; never signal a
    // discovered PID, process group, or any neighboring service.
    child.kill("SIGKILL");
    let killWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const killWait = new Promise<{ readonly kind: "wait-timeout" }>((resolve) => {
      killWaitTimer = setTimeout(() => resolve({ kind: "wait-timeout" }), CHILD_KILL_WAIT_MS);
    });
    const stopped = await Promise.race([exited, killWait]);
    if (killWaitTimer !== undefined) clearTimeout(killWaitTimer);
    if (stopped.kind === "exited") {
      terminationConfirmed = true;
      exitCode = stopped.exitCode;
    } else {
      terminationConfirmed = false;
    }
  }

  // Do not drain pipes while termination is unknown: an unconfirmed child may
  // still hold them open, and its sandbox must remain untouched in that case.
  if (!terminationConfirmed) {
    return {
      pid: child.pid,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut,
      terminationConfirmed: false,
    };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    pid: child.pid,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    timedOut,
    terminationConfirmed: true,
  };
}

test("file-backed self-host multipart recovery works across two exited Bun processes", async () => {
  const deadlineProbe = await runChild(
    'console.log("deadline-probe-ready"); await Bun.sleep(30_000);',
    {},
    1_000,
  );
  expect(deadlineProbe.timedOut).toBe(true);
  expect(deadlineProbe.terminationConfirmed).toBe(true);
  expect(deadlineProbe.stdout).toContain("deadline-probe-ready");

  const sandbox = await mkdtemp(join(tmpdir(), "takoserver-object-process-restart-"));
  const root = join(sandbox, "objects");
  const databasePath = join(sandbox, "control.sqlite");
  const commonEnv = {
    OBJECT_ROOT: root,
    DATABASE_PATH: databasePath,
    BUCKET,
    FOREIGN_BUCKET,
    OBJECT_KEY: KEY,
    SELECTED_BYTES,
    TMPDIR: sandbox,
  };
  let preserveSandbox = false;
  try {
    const producer = await runChild(producerSource, commonEnv);
    if (!producer.terminationConfirmed) {
      preserveSandbox = true;
      throw new Error(
        `producer timeout; exact child termination unknown; fixture preserved at ${sandbox}`,
      );
    }
    if (producer.timedOut)
      throw new Error(`producer exceeded ${CHILD_DEADLINE_MS}ms and was terminated`);
    expect(producer.exitCode, producer.stderr).toBe(0);
    const producerEvidence = JSON.parse(producer.stdout) as {
      readonly pid: number;
      readonly uploadId: string;
      readonly ackLossSimulated: boolean;
    };
    expect(producerEvidence.ackLossSimulated).toBe(true);
    expect(producerEvidence.uploadId).toMatch(/^[0-9a-f]{32}$/u);

    // runChild waits for producer exit before the independent consumer opens
    // this same file-backed database and object root.
    const consumer = await runChild(consumerSource, {
      ...commonEnv,
      UPLOAD_ID: producerEvidence.uploadId,
      PRODUCER_PID: String(producerEvidence.pid),
    });
    if (!consumer.terminationConfirmed) {
      preserveSandbox = true;
      throw new Error(
        `consumer timeout; exact child termination unknown; fixture preserved at ${sandbox}`,
      );
    }
    if (consumer.timedOut)
      throw new Error(`consumer exceeded ${CHILD_DEADLINE_MS}ms and was terminated`);
    expect(consumer.exitCode, consumer.stderr).toBe(0);
    const consumerEvidence = JSON.parse(consumer.stdout) as {
      readonly pid: number;
      readonly producerPid: number;
      readonly distinctPids: boolean;
      readonly persistedBytesMatch: boolean;
      readonly replayCount: number;
      readonly replayFileCountStable: boolean;
      readonly completedGetBytesMatch: boolean;
      readonly partDirectoryRemoved: boolean;
      readonly foreignBucketRefused: boolean;
      readonly foreignUploadScopeRefused: boolean;
    };
    expect(consumerEvidence.pid).not.toBe(consumerEvidence.producerPid);
    expect(consumerEvidence.distinctPids).toBe(true);
    expect(consumerEvidence.persistedBytesMatch).toBe(true);
    expect(consumerEvidence.replayCount).toBe(3);
    expect(consumerEvidence.replayFileCountStable).toBe(true);
    expect(consumerEvidence.completedGetBytesMatch).toBe(true);
    expect(consumerEvidence.partDirectoryRemoved).toBe(true);
    expect(consumerEvidence.foreignBucketRefused).toBe(true);
    expect(consumerEvidence.foreignUploadScopeRefused).toBe(true);
  } finally {
    if (!preserveSandbox) await rm(sandbox, { recursive: true, force: true });
  }
});
