import { afterEach, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { SqlParam, SqlStatement } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type { D1StatementLike } from "../src/sql-d1.ts";
import {
  createWorkerRequestSql,
  type WorkerRequestDatabase,
} from "../src/worker-request-composition.ts";
import { createHostedBillingRealmTestDatabase } from "./helpers/hosted-billing-realm-fixture.ts";

// Runs only in a dedicated child: mock.module("cloudflare:workers") is process-wide,
// and another file's earlier mock without `env` would otherwise satisfy the import.
const child = process.env.AUTH103_NATIVE_PLATFORM_FINANCIAL_PROOF_CHILD === "1";
if (child) {
  // Mechanical component only: a synthetic module-load ACCOUNTS_FINANCIAL_PROOF value
  // and local SQLite primary. No deployed RPC, Accounts origin or genuine proof follows.
  const WRITER = `sha256:${"a".repeat(64)}`;
  const platformEnv: Record<string, unknown> = {};
  mock.module("cloudflare:workers", () => ({ env: platformEnv }));
  const close = new Set<() => void>();
  afterEach(() => {
    for (const done of close) done();
    close.clear();
  });

  async function nativeDatabase(): Promise<WorkerRequestDatabase> {
    const database = await createHostedBillingRealmTestDatabase();
    close.add(() => database.db.close());
    for (const ddl of [
      MONEY_CUTOVER_FREEZE_DDL,
      MONEY_CUTOVER_PERMIT_DDL,
      MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
      MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
      moneyFenceInstallSql("0094"),
    ])
      database.db.exec(ddl);
    await database.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [WRITER]);
    return {
      prepare() {
        throw new Error("native proof fixture used the root binding");
      },
      async batch() {
        throw new Error("native proof fixture batched on the root binding");
      },
      withSession() {
        const originals = new WeakMap<D1StatementLike, SqlStatement>();
        return {
          prepare(sql) {
            const statement: D1StatementLike = {
              bind(...params: readonly SqlParam[]) {
                originals.set(statement, { sql, params });
                return statement;
              },
              async all() {
                const original = originals.get(statement);
                if (!original) throw new Error("fixture statement ownership differs");
                const result = await database.sql.run(original.sql, original.params);
                return { success: true, results: result.rows, meta: { changes: result.changes } };
              },
            };
            originals.set(statement, { sql });
            return statement;
          },
          async batch() {
            throw new Error("native proof fixture permits no batch");
          },
        };
      },
    };
  }

  const connect = (database: WorkerRequestDatabase) =>
    createWorkerRequestSql({
      database,
      writerEpoch: WRITER,
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    });

  // Each variant is a fresh module instance, so each captures its own module-load binding.
  type PlatformOrigin = typeof import("../src/auth103-native-platform-origin.ts");
  const loadPlatform = (variant: string): Promise<PlatformOrigin> =>
    import(`../src/auth103-native-platform-origin.ts?${variant}`);

  const reference = {
    v: 1,
    proofRef: "synthetic:proof-original",
    challengeRef: "challenge-1",
  } as const;

  test("module-load prove/load/current forward one unchanged input and fail closed on drift", async () => {
    const database = await nativeDatabase();
    const calls: { readonly name: string; readonly self: unknown; readonly args: unknown[] }[] = [];
    const binding = {
      prove(...args: unknown[]) {
        calls.push({ name: "prove", self: this, args });
        return Promise.resolve({ proofRef: reference.proofRef });
      },
      loadFinancialIdentityProof(...args: unknown[]) {
        calls.push({ name: "load", self: this, args });
        return Promise.resolve({ loaded: true });
      },
      verifyCurrentFinancialIdentityProof(...args: unknown[]) {
        calls.push({ name: "current", self: this, args });
        return Promise.resolve({ current: true });
      },
    };
    platformEnv.STATE_DB = database;
    platformEnv.ACCOUNTS_FINANCIAL_PROOF = binding;
    const platform = await loadPlatform("stable");
    const connection = await connect(database);
    const receiver = platform.readAuth103NativeFinancialProofReceiver(
      connection,
      "unused-commit",
    ) as (Record<string, (input: unknown) => Promise<unknown>> & object) | null;
    if (!receiver) throw new Error("native proof receiver missing");
    expect(Object.isFrozen(receiver)).toBe(true);
    expect(Object.keys(receiver)).toEqual([
      "prove",
      "loadFinancialIdentityProof",
      "verifyCurrentFinancialIdentityProof",
    ]);
    const load = receiver.loadFinancialIdentityProof;
    const current = receiver.verifyCurrentFinancialIdentityProof;
    if (!load || !current) throw new Error("native proof reference methods missing");
    const proveInput = { accessToken: "synthetic-token-never-logged", challengeRef: "challenge-1" };
    expect(await receiver.prove?.(proveInput)).toEqual({ proofRef: reference.proofRef });
    expect(calls.shift()).toEqual({ name: "prove", self: binding, args: [proveInput] });
    expect(await load(reference)).toEqual({ loaded: true });
    expect(await current(reference)).toEqual({ current: true });
    expect(calls).toEqual([
      { name: "load", self: binding, args: [reference] },
      { name: "current", self: binding, args: [reference] },
    ]);
    expect(calls[0]?.args[0]).toBe(reference);

    const original = binding.verifyCurrentFinancialIdentityProof;
    binding.verifyCurrentFinancialIdentityProof = (...args: unknown[]) =>
      original.apply(binding, args);
    await expect(current(reference)).rejects.toMatchObject({ code: "unavailable" });
    binding.verifyCurrentFinancialIdentityProof = original;
    platformEnv.ACCOUNTS_FINANCIAL_PROOF = { ...binding };
    await expect(load(reference)).rejects.toMatchObject({ code: "unavailable" });
    platformEnv.ACCOUNTS_FINANCIAL_PROOF = binding;
    const prototype = Object.getPrototypeOf(binding);
    Object.setPrototypeOf(binding, { ...prototype });
    await expect(load(reference)).rejects.toMatchObject({ code: "unavailable" });
    Object.setPrototypeOf(binding, prototype);
    const foreign = await connect(await nativeDatabase());
    expect(() =>
      platform.readAuth103NativeFinancialProofReceiver(foreign, "unused-commit"),
    ).toThrow();
    expect(calls).toHaveLength(2);
  });

  test("a binding without load/current exposes prove only", async () => {
    const database = await nativeDatabase();
    platformEnv.STATE_DB = database;
    platformEnv.ACCOUNTS_FINANCIAL_PROOF = {
      prove: () => Promise.resolve({ proofRef: reference.proofRef }),
    };
    const platform = await loadPlatform("prove-only");
    const receiver = platform.readAuth103NativeFinancialProofReceiver(
      await connect(database),
      "unused-commit",
    );
    expect(receiver && Object.keys(receiver)).toEqual(["prove"]);
  });

  test("a throwing load/current read leaves prove available", async () => {
    const database = await nativeDatabase();
    platformEnv.STATE_DB = database;
    platformEnv.ACCOUNTS_FINANCIAL_PROOF = {
      prove: () => Promise.resolve({ proofRef: reference.proofRef }),
      get loadFinancialIdentityProof(): never {
        throw new Error("synthetic load read failure");
      },
      get verifyCurrentFinancialIdentityProof(): never {
        throw new Error("synthetic current read failure");
      },
    };
    const platform = await loadPlatform("throwing-optional");
    const receiver = platform.readAuth103NativeFinancialProofReceiver(
      await connect(database),
      "unused-commit",
    );
    expect(receiver && Object.keys(receiver)).toEqual(["prove"]);
  });

  test("a dynamic RPC stub invokes only the first module-load callable", async () => {
    const database = await nativeDatabase();
    const reads: string[] = [];
    const invoked: string[] = [];
    const target: Record<string, unknown> = {};
    const stub = new Proxy(target, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        const read = `${key}#${reads.filter((name) => name.startsWith(`${key}#`)).length + 1}`;
        reads.push(read);
        return (input: unknown) => {
          invoked.push(read);
          return Promise.resolve({ read, input });
        };
      },
    });
    platformEnv.STATE_DB = database;
    platformEnv.ACCOUNTS_FINANCIAL_PROOF = stub;
    const platform = await loadPlatform("dynamic");
    const receiver = platform.readAuth103NativeFinancialProofReceiver(
      await connect(database),
      "unused-commit",
    ) as Record<string, (input: unknown) => Promise<unknown>> | null;
    const load = receiver?.loadFinancialIdentityProof;
    if (!load) throw new Error("dynamic load missing");
    expect(await load(reference)).toEqual({
      read: "loadFinancialIdentityProof#1",
      input: reference,
    });
    expect(await load(reference)).toEqual({
      read: "loadFinancialIdentityProof#1",
      input: reference,
    });
    expect(invoked).toEqual(["loadFinancialIdentityProof#1", "loadFinancialIdentityProof#1"]);
    target.loadFinancialIdentityProof = () => Promise.resolve("shadow");
    await expect(load(reference)).rejects.toMatchObject({ code: "unavailable" });
    expect(invoked).toHaveLength(2);
  });
} else {
  test("runs the native platform financial proof adapter in an isolated child", async () => {
    const childProcess = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "test",
        "--timeout",
        "30000",
        fileURLToPath(import.meta.url),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, AUTH103_NATIVE_PLATFORM_FINANCIAL_PROOF_CHILD: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    });
    const [exit, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ]);
    expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
      exit: 0,
      diagnostics: "",
    });
    expect(stderr).toContain("4 pass");
    expect(stderr).toContain("0 fail");
  }, 100_000);
}
