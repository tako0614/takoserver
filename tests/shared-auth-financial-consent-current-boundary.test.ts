import { describe, expect, it, mock } from "bun:test";
import { fileURLToPath } from "node:url";
import { base64UrlEncode, canonicalDigest } from "../src/json.ts";
import {
  createSharedAuthFinancialActionConsentCaptureKey,
  createSharedAuthFinancialActionConsentCaptureKeyData,
} from "../src/shared-auth-financial-consent-contract.ts";
import {
  parseSharedAuthFinancialConfirmationSubmissionCandidate,
  renderSharedAuthFinancialPreparedConsentView,
  SharedAuthFinancialConfirmationSubmissionError,
} from "../src/shared-auth-financial-consent-request.ts";
import { prepareSharedAuthFinancialConsentPendingFromObservation } from "../src/shared-auth-financial-consent-store.ts";
import { graphFixture, snapshot } from "./consent-request-graph-fixture.ts";
import { syntheticV4Original } from "./consent-v4-fixture.ts";

// The child process records the actual RP source callsite arguments. Its
// Financial module is a mechanical sentinel, not a genuine Root/R1 producer.
const callsiteChild = process.env.RP_R1_HANDLER_CALLSITE_CHILD === "1";
const calls: {
  connection: unknown;
  request: unknown;
  workspaceId: unknown;
  challengeRef: unknown;
}[] = [];
let factories = 0;
let onRead: (() => void) | undefined;
let sentinelResult: unknown = {};
if (callsiteChild) {
  mock.module(
    fileURLToPath(new URL("../src/shared-financial-retained-r1.ts", import.meta.url)),
    () => ({
      readFinancialActionConsentR1RequestCaptures() {
        throw new Error("synthetic child has no genuine Root captures");
      },
      createFinancialActionConsentR1Reader(
        connection: unknown,
        request: unknown,
        workspaceId: unknown,
      ) {
        factories++;
        return {
          readRetainedActionConsentR1(challengeRef: unknown) {
            calls.push({ connection, request, workspaceId, challengeRef });
            onRead?.();
            return Promise.resolve(sentinelResult);
          },
        };
      },
    }),
  );
}
const { createSharedAuthFinancialConsentRequestHandler } = await import(
  "../src/shared-auth-financial-consent.ts"
);

const transactionRef = `rpfc_${"a".repeat(43)}`;
const selection = Object.freeze({
  transactionRef,
  challengeRef: "challenge-original",
  requestFingerprint: `sha256:${"b".repeat(64)}`,
});

function request(body: string, method = "POST", contentType = "application/x-www-form-urlencoded") {
  return new Request("https://example.test/auth/financial-confirmation", {
    method,
    headers: { "content-type": contentType },
    ...(method === "GET" ? {} : { body }),
  });
}

async function rejects(body: string, expected = selection) {
  const original = request(body);
  await expect(
    parseSharedAuthFinancialConfirmationSubmissionCandidate(original, expected),
  ).rejects.toBeInstanceOf(SharedAuthFinancialConfirmationSubmissionError);
  expect(original.bodyUsed).toBe(true);
}

describe("RP confirmation submission DATA boundary", () => {
  it("keeps the fixed v2 capture-key preimage across old and new pure DATA entrypoints", async () => {
    const f = await graphFixture();
    const action = JSON.parse(new TextDecoder().decode(f.input.pending.action_original_bytes));
    const full = await syntheticV4Original(
      f.input.pending,
      f.input.credential,
      f.input.currentSession.version,
      f.input.command.key.consentRef,
    );
    const oldKey = await createSharedAuthFinancialActionConsentCaptureKey(full.original);
    const tupleKey = await createSharedAuthFinancialActionConsentCaptureKeyData({
      challengeRef: f.input.pending.challenge_ref,
      actionKind: action.kind,
      actionReference: action.reference,
      actionRequestFingerprint: f.input.pending.request_fingerprint,
    });
    expect(tupleKey).toBe(oldKey);
  });
  it("refuses a caller-shaped GET observation before pending29 write", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    await expect(
      prepareSharedAuthFinancialConsentPendingFromObservation(
        f.connection,
        request("", "GET"),
        f.input.pending.workspace_id,
        {},
        f.input.pending,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(snapshot(f.db)).toEqual(before);
    expect(f.native.batchCalls).toBe(0);
  });
  it("renders exact action and UTF-8 terms as escaped GET DATA with only the fixed POST fields", async () => {
    const terms = "<script>alert(\"terms\")</script> & 'quoted'";
    const rendered = await renderSharedAuthFinancialPreparedConsentView({
      transactionRef,
      action: { reference: "ref<script>", kind: "topup" },
      termsOriginalUtf8Base64url: base64UrlEncode(new TextEncoder().encode(terms)),
    });
    expect(rendered.html).toContain("&lt;script&gt;alert(&quot;terms&quot;)&lt;/script&gt;");
    expect(rendered.html).toContain("ref&lt;script&gt;");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain('<form method="post">');
    expect(rendered.html).not.toContain(" action=");
    expect(rendered.html.match(/name="[^"]+"/gu)).toEqual([
      'name="confirmation_transaction"',
      'name="approve"',
    ]);
    expect(rendered.disclosureRef).toBe(
      await canonicalDigest(["rp-financial-consent-prepared-view-v1", rendered.html]),
    );
  });
  it("consumes exactly the original POST body and returns only detached syntax DATA", async () => {
    const original = request(`approve=yes&confirmation_transaction=${transactionRef}`);
    const result = await parseSharedAuthFinancialConfirmationSubmissionCandidate(
      original,
      selection,
    );
    expect(result).toEqual({ state: "confirmation-submission-data", ...selection });
    expect(original.bodyUsed).toBe(true);
    await expect(
      parseSharedAuthFinancialConfirmationSubmissionCandidate(original, selection),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConfirmationSubmissionError);
  });

  it("refuses changed, missing, repeated and extra form fields", async () => {
    await rejects(`approve=no&confirmation_transaction=${transactionRef}`);
    await rejects(`approve=yes&confirmation_transaction=${transactionRef}x`);
    await rejects(`approve=yes&approve=yes&confirmation_transaction=${transactionRef}`);
    await rejects(`approve=yes&confirmation_transaction=${transactionRef}&current=true`);
    await rejects(`approve=yes`);
  });

  it("refuses wrong method, content type, oversized and accessor selection before authority", async () => {
    await expect(
      parseSharedAuthFinancialConfirmationSubmissionCandidate(request("", "GET"), selection),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConfirmationSubmissionError);
    await expect(
      parseSharedAuthFinancialConfirmationSubmissionCandidate(
        request(
          `approve=yes&confirmation_transaction=${transactionRef}`,
          "POST",
          "application/json",
        ),
        selection,
      ),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConfirmationSubmissionError);
    await rejects(
      `approve=yes&confirmation_transaction=${transactionRef}&padding=${"x".repeat(8192)}`,
    );
    const accessor = Object.defineProperty({ ...selection }, "transactionRef", {
      get() {
        throw new Error("selection getter must not run");
      },
      enumerable: true,
    });
    await expect(
      parseSharedAuthFinancialConfirmationSubmissionCandidate(
        request(`approve=yes&confirmation_transaction=${transactionRef}`),
        accessor,
      ),
    ).rejects.toBeInstanceOf(SharedAuthFinancialConfirmationSubmissionError);
  });
});

describe("RP unexpired local DATA boundary", () => {
  it("reads the immutable proof before R1 and refuses a missing Root port without a write", async () => {
    const f = await graphFixture({}, true);
    const before = snapshot(f.db);
    const effects = f.effects();
    const original = request(`approve=yes&confirmation_transaction=${transactionRef}`);
    const handler = createSharedAuthFinancialConsentRequestHandler(f.connection);
    await expect(
      handler.verifyCurrentActionConsent(original, {
        workspaceId: f.input.pending.workspace_id,
        consentProofRef: f.input.command.key.consentRef,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      f.native.calls.some(
        ({ sql, params }) =>
          sql.includes("WHERE consent_ref=? LIMIT 2") &&
          params[0] === f.input.command.key.consentRef,
      ),
    ).toBe(true);
    expect(original.bodyUsed).toBe(false);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.effects()).toEqual(effects);
  });

  it("refuses R1 presentation without the actual Root port, with no body read or write", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const effects = f.effects();
    const original = request("", "GET");
    const handler = createSharedAuthFinancialConsentRequestHandler(f.connection);
    await expect(
      handler.readFinancialR1PresentationData(
        original,
        f.input.pending.workspace_id,
        f.input.pending.challenge_ref,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(original.bodyUsed).toBe(false);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.effects()).toEqual(effects);
  });

  it("refuses missing genuine Root origin without a second body read or consent write", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const effects = f.effects();
    const body = request(`approve=yes&confirmation_transaction=${transactionRef}`);
    const handler = createSharedAuthFinancialConsentRequestHandler(f.connection);
    await expect(
      handler.readUnexpiredLocalData(body, {
        workspaceId: f.input.pending.workspace_id,
        consentProofRef: f.input.command.key.consentRef,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      handler.verifyCurrentActionConsent(body, {
        workspaceId: f.input.pending.workspace_id,
        consentProofRef: f.input.command.key.consentRef,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(body.bodyUsed).toBe(false);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.effects()).toEqual(effects);
  });
});

if (callsiteChild) {
  it("passes the original connection, Request, Workspace and R1 challenge to the factory", async () => {
    const f = await graphFixture({}, true);
    const original = request(`approve=yes&confirmation_transaction=${transactionRef}`);
    const handler = createSharedAuthFinancialConsentRequestHandler(f.connection);
    const proofRef = f.input.command.key.consentRef;
    const challengeRef = f.input.pending.challenge_ref;
    expect(proofRef).not.toBe(challengeRef);
    calls.length = 0;
    await expect(
      handler.verifyCurrentActionConsent(original, {
        workspaceId: f.input.pending.workspace_id,
        consentProofRef: proofRef,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toEqual([
      {
        connection: f.connection,
        request: original,
        workspaceId: f.input.pending.workspace_id,
        challengeRef,
      },
    ]);
    expect(calls[0]?.connection).toBe(f.connection);
    expect(calls[0]?.request).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(f.native.batchCalls).toBe(0);

    const g = await graphFixture();
    const action = JSON.parse(new TextDecoder().decode(g.input.pending.action_original_bytes));
    const challenge = JSON.parse(
      new TextDecoder().decode(g.input.pending.challenge_original_bytes),
    );
    const terms = g.input.pending.terms_original_bytes;
    sentinelResult = {
      original: { challengeRef: g.input.pending.challenge_ref, c0: { challenge } },
      actionIdentity: { action, requestFingerprint: g.input.pending.request_fingerprint },
      selectedTerms: {
        ref: "synthetic-terms-ref",
        digest: g.input.pending.terms_digest_original,
        bodyUtf8Base64url: Buffer.from(terms).toString("base64url"),
        bodyByteLength: terms.byteLength,
      },
      r1ReceiptRef: "synthetic-r1-receipt",
      c0ReceiptRef: "synthetic-c0-receipt",
      fullCommandJson: '{"synthetic":"fixed-r1-command"}',
    };
    const get = request("", "GET");
    const presentation = createSharedAuthFinancialConsentRequestHandler(g.connection);
    calls.length = 0;
    const beforeFactories = factories;
    const shown = await presentation.readFinancialR1PresentationData(
      get,
      g.input.pending.workspace_id,
      g.input.pending.challenge_ref,
    );
    expect(shown.state).toBe("financial-r1-presentation-data");
    expect(shown.transactionRef).toMatch(/^rpfc_[A-Za-z0-9_-]{43}$/u);
    const key = await createSharedAuthFinancialActionConsentCaptureKeyData({
      challengeRef: g.input.pending.challenge_ref,
      actionKind: action.kind,
      actionReference: action.reference,
      actionRequestFingerprint: g.input.pending.request_fingerprint,
    });
    const digest = key.slice("sha256:".length);
    expect(shown.transactionRef).toBe(
      `rpfc_${base64UrlEncode(Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16)))}`,
    );
    expect(shown.requestFingerprint).toBe(g.input.pending.request_fingerprint);
    expect(factories - beforeFactories).toBe(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.connection).toBe(g.connection);
      expect(call.request).toBe(get);
    }
    expect(get.bodyUsed).toBe(false);
    expect(g.native.batchCalls).toBe(0);

    const preparedGet = request("", "GET");
    calls.length = 0;
    await expect(
      presentation.prepareFinancialR1ConsentView(
        preparedGet,
        g.input.pending.workspace_id,
        g.input.pending.challenge_ref,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toBe(preparedGet);
    expect(preparedGet.bodyUsed).toBe(false);
    expect(g.native.batchCalls).toBe(0);

    const driftedGet = request("", "GET");
    calls.length = 0;
    onRead = () => {
      g.replaceGraph();
    };
    await expect(
      presentation.readFinancialR1PresentationData(
        driftedGet,
        g.input.pending.workspace_id,
        g.input.pending.challenge_ref,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    onRead = undefined;
    expect(calls).toEqual([
      {
        connection: g.connection,
        request: driftedGet,
        workspaceId: g.input.pending.workspace_id,
        challengeRef: g.input.pending.challenge_ref,
      },
    ]);
    expect(calls[0]?.connection).toBe(g.connection);
    expect(calls[0]?.request).toBe(driftedGet);
    expect(driftedGet.bodyUsed).toBe(false);
    expect(g.native.batchCalls).toBe(0);
  });
} else {
  it("checks R1 handler callsite arguments in an isolated synthetic child", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "test",
        "--timeout",
        "30000",
        "--bail=1",
        fileURLToPath(import.meta.url),
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, RP_R1_HANDLER_CALLSITE_CHILD: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
      exit: 0,
      diagnostics: "",
    });
    expect(stderr).toContain("0 fail");
    expect(stderr).toContain(
      "(pass) passes the original connection, Request, Workspace and R1 challenge to the factory",
    );
  }, 100_000);
}
