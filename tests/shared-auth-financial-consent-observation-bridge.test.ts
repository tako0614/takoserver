import { describe, expect, test } from "bun:test";
import { createSharedAuthFinancialConsentRequestHandler } from "../src/shared-auth-financial-consent.ts";
import {
  createSharedAuthFinancialConsentProofReferenceReader,
  persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData,
} from "../src/shared-auth-financial-consent-store.ts";
import {
  readSharedAuthFinancialRequestNativeObservationData,
  SharedAuthFinancialSourceUnavailable,
} from "../src/shared-auth-financial-source.ts";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";
import { graphFixture, snapshot } from "./consent-request-graph-fixture.ts";

const request = () =>
  new Request("https://rp.example.invalid/financial/consent", {
    method: "POST",
    body: "affirmative-body-is-not-a-capture",
  });

// The fixed Root port is absent from this synthetic fixture. These are only
// fail-closed tests; no fabricated port or session observation is accepted.
describe("unmounted RP observation to native batch bridge", () => {
  test("own handler connects one observation to the writer and fails without Root", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const effects = f.effects();
    const req = request();
    const handler = createSharedAuthFinancialConsentRequestHandler(f.connection);
    await expect(
      handler.persistObservedData(req, f.input.pending.workspace_id, {
        pending: f.input.pending,
        command: f.input.command,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(req.bodyUsed).toBe(false);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.effects()).toEqual(effects);
  });

  test("a caller-shaped observation cannot create a source original or write SQL", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const effects = f.effects();
    const calls = f.native.calls.length;
    const req = request();
    const forged = Object.freeze({
      state: "shared-auth-financial-request-native-observation-data",
      sampledAt: f.input.recordedAt,
      credential: f.input.credential,
      human: f.input.human,
      currentSession: f.input.currentSession,
    });
    expect(() =>
      readSharedAuthFinancialRequestNativeObservationData(
        f.connection,
        req,
        f.input.pending.workspace_id,
        forged,
      ),
    ).toThrow(SharedAuthFinancialSourceUnavailable);
    await expect(
      persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
        f.connection,
        req,
        f.input.pending.workspace_id,
        forged,
        { pending: f.input.pending, command: f.input.command },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(req.bodyUsed).toBe(false);
    expect(f.native.calls.length).toBe(calls);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.effects()).toEqual(effects);
  });

  test("another Request or selected Workspace cannot promote the same forged handle", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const forged = Object.freeze({});
    const first = request();
    const other = request();
    for (const [req, workspaceId] of [
      [first, f.input.pending.workspace_id],
      [other, f.input.pending.workspace_id],
      [first, "another-workspace"],
    ] as const) {
      await expect(
        persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
          f.connection,
          req,
          workspaceId,
          forged,
          { pending: f.input.pending, command: f.input.command },
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(req.bodyUsed).toBe(false);
    }
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("foreign connection and caller-supplied authority fields cannot reach the batch", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const foreign = {
      moneyGuard: "ready" as const,
      sql: f.connection.sql,
    } as WorkerRequestSql;
    await expect(
      persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
        foreign,
        request(),
        f.input.pending.workspace_id,
        Object.freeze({}),
        { pending: f.input.pending, command: f.input.command },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
        f.connection,
        request(),
        f.input.pending.workspace_id,
        Object.freeze({}),
        {
          pending: f.input.pending,
          command: f.input.command,
          recordedAt: f.input.recordedAt,
          currentness: { sql: "1", params: [] },
        } as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("failed bridge leaves historical proof lookup on its original key", async () => {
    const f = await graphFixture({}, true);
    const before = snapshot(f.db);
    await expect(
      persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
        f.connection,
        request(),
        f.input.pending.workspace_id,
        Object.freeze({}),
        { pending: f.input.pending, command: f.input.command },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    const proof = await createSharedAuthFinancialConsentProofReferenceReader(
      f.connection,
    ).readProofOriginalData(f.input.command.key.consentRef);
    expect(proof.consentProofRef).toBe(f.input.command.key.consentRef);
    expect(proof.original.command.commandBytes).toEqual(f.input.command.commandBytes);
    expect(proof.original.originalBytes).toEqual(f.input.command.originalBytes);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
  });
});
