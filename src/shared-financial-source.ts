import { isFinancialMoneyFencedBatch } from "./financial-0104-money-fence.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import {
  type Clock,
  type Row,
  type Sql,
  SqlError,
  type SqlParam,
  type SqlStatement,
} from "./ports.ts";
import {
  FinancialSourceAbiError,
  type FinancialSourceReceiverAbi,
  financialSourceReceiptRef,
  parseFinancialSourceReadRequest,
  verifyFinancialSourceApplyRequest,
} from "./shared-financial-source-abi.ts";
import {
  canonicalFinancialSourceJson,
  type FinancialSourceDigest,
  type FinancialSourceEvent,
  type FinancialSourceReceipt,
  type FinancialSourceRegistration,
  financialReceiptMatches,
  financialSourceDigest,
  financialSourceEventDigest,
  financialSourceRef,
  parseFinancialSourceEvent,
  parseFinancialSourceReceipt,
  parseFinancialSourceRegistration,
} from "./shared-financial-source-contract.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";

/** Owned immutable evidence, fetched from the one composition-selected peer. */
export interface SharedFinancialSourceImmutableEvidence {
  readonly qualificationRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly genesisQualificationRef: string;
  readonly registration: FinancialSourceRegistration;
  readonly event: FinancialSourceEvent;
}

/**
 * Injection boundary only. A callable or matching descriptor is not peer
 * authentication. The owning authenticated transport adapter is mandatory
 * before mounting this internal store; no entry in this module mounts it.
 */
export interface SharedFinancialSourceEvidenceReader {
  readImmutableEvent(eventRef: string): Promise<SharedFinancialSourceImmutableEvidence | null>;
}

export interface SharedFinancialSourceReceiver {
  applySourceEvent(event: FinancialSourceEvent): Promise<FinancialSourceReceipt>;
  readSourceEventReceipt(eventRef: string): Promise<FinancialSourceReceipt | null>;
}

export class SharedFinancialSourceError extends Error {
  constructor(
    readonly code: "invalid_event" | "source_conflict" | "unavailable",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "SharedFinancialSourceError";
  }
}

function fail(code: SharedFinancialSourceError["code"], options?: ErrorOptions): never {
  throw new SharedFinancialSourceError(code, options);
}

interface RetainedEvent {
  readonly event: FinancialSourceEvent;
  readonly receipt: FinancialSourceReceipt;
}

/**
 * Unmounted internal storage core, disabled by the absence of an entry adapter.
 * It supplies no payer, caller, enrollment or Customer authority. The realm
 * must be the existing genuine same-Sql/client capability; registration and
 * component genesis must already have been enrolled by their actual owner.
 */
export interface SharedFinancialSourceReceiverOptions {
  readonly sql: Sql;
  /** Observation metadata only; no expiry, ordering or authority policy. */
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly writerEpoch: string;
  readonly registration: FinancialSourceRegistration;
  /** Opaque original enrollment pin; this module invents no registration hash domain. */
  readonly registrationDigest: FinancialSourceDigest;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly qualificationRef: string;
  readonly evidence: SharedFinancialSourceEvidenceReader;
}

export function createSharedFinancialSourceReceiver(
  options: SharedFinancialSourceReceiverOptions,
): SharedFinancialSourceReceiver {
  const {
    sql,
    clock,
    client,
    realm,
    writerEpoch,
    registrationDigest,
    receiverRef,
    targetRef,
    qualificationRef,
  } = options;
  const evidenceReader = options.evidence;
  const readEvidence = evidenceReader?.readImmutableEvent;
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  const registration = parseFinancialSourceRegistration(options.registration);
  if (
    typeof clock !== "function" ||
    !financialSourceDigest(writerEpoch) ||
    !financialSourceDigest(registrationDigest) ||
    ![receiverRef, targetRef, qualificationRef].every(financialSourceRef) ||
    !registration.receivers.some(
      (receiver) => receiver.receiverRef === receiverRef && receiver.targetRef === targetRef,
    ) ||
    typeof readEvidence !== "function"
  )
    fail("unavailable");
  const registrationJson = canonicalFinancialSourceJson(registration);
  const { registrationRef, incarnation, genesisDigest } = registration;
  const accountId = realm.accountId,
    billingAuthority = realm.billingAuthority;
  // Capture the selected method once; a caller-owned options slot cannot swap
  // the evidence peer after an await.
  const readImmutableEvent = (
    eventRef: string,
  ): Promise<SharedFinancialSourceImmutableEvidence | null> =>
    Reflect.apply(readEvidence, evidenceReader, [eventRef]);

  // Fixed owning predicates only. No callback or caller-supplied SQL can turn
  // remote currentness into atomicity; these recheck the actual local primary.
  // Freeze and permit are the Financial 0104 receiver money fences inside
  // Root's permit-framed Money writer, so no money_cutover_* table is named.
  const currentRegistration = `r.registration_ref = ? AND r.incarnation = ?
    AND r.receiver_ref = ? AND r.target_ref = ?
    AND r.genesis_digest = ? AND r.registration_digest = ?
    AND r.registration_json = ? AND r.qualification_ref = ? AND r.retired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM financial_source_registrations other
      WHERE other.registration_ref = r.registration_ref AND other.incarnation <> r.incarnation
        AND other.retired_at IS NULL)
    AND EXISTS (SELECT 1 FROM stripe_mode_realm WHERE singleton = 1 AND mode = 'test')
    AND EXISTS (SELECT 1 FROM stripe_billing_account_realms
      WHERE singleton = 1 AND account_id = ? AND mode = 'test' AND billing_authority = ?)`;
  const currentParams: readonly SqlParam[] = Object.freeze([
    registrationRef,
    incarnation,
    receiverRef,
    targetRef,
    genesisDigest,
    registrationDigest,
    registrationJson,
    qualificationRef,
    accountId,
    billingAuthority,
  ]);

  function matchesEnrollment(row: Row | undefined): boolean {
    return (
      row !== undefined &&
      row.registration_ref === registrationRef &&
      row.incarnation === incarnation &&
      row.receiver_ref === receiverRef &&
      row.target_ref === targetRef &&
      row.genesis_digest === genesisDigest &&
      row.registration_digest === registrationDigest &&
      row.registration_json === registrationJson &&
      row.qualification_ref === qualificationRef
    );
  }

  async function receiptReference(
    event: FinancialSourceEvent,
    eventDigest: FinancialSourceDigest,
  ): Promise<string> {
    return financialSourceReceiptRef({
      registrationRef,
      receiverRef,
      targetRef,
      eventRef: event.eventRef,
      eventDigest,
      incarnation: event.incarnation,
      sequence: event.sequence,
      state: event.kind === "close" ? "admission-closed" : "advanced",
    });
  }

  /** Historical reads deliberately do not require current head sequence or a live registration. */
  async function retained(eventRef: string): Promise<RetainedEvent | null> {
    try {
      const enrollment = await sql.query(
        "SELECT * FROM financial_source_registrations WHERE registration_ref = ? AND incarnation = ?",
        [registrationRef, incarnation],
      );
      if (enrollment.length !== 1 || !matchesEnrollment(enrollment[0])) fail("unavailable");
      const rows = await sql.query(
        `SELECT q.*, e.event_json AS original_event_json, e.event_digest AS original_event_digest,
          e.registration_ref AS original_registration_ref, e.incarnation AS original_incarnation,
          e.affected_ref AS original_affected_ref, e.sequence AS original_sequence,
          h.affected_ref AS retained_head
        FROM financial_source_receipts q
        LEFT JOIN financial_source_events e ON e.event_ref = q.event_ref
        LEFT JOIN financial_source_heads h ON h.registration_ref = q.registration_ref
          AND h.incarnation = q.incarnation AND h.affected_ref = q.affected_ref
        WHERE q.event_ref = ? AND q.registration_ref = ? AND q.incarnation = ?
          AND q.receiver_ref = ? AND q.target_ref = ?`,
        [eventRef, registrationRef, incarnation, receiverRef, targetRef],
      );
      if (rows.length === 0) {
        const orphan = await sql.query(
          `SELECT 1 FROM financial_source_events WHERE event_ref = ? AND registration_ref = ? AND incarnation = ?
           UNION ALL SELECT 1 FROM financial_source_heads
            WHERE last_event_ref = ? AND registration_ref = ? AND incarnation = ? LIMIT 1`,
          [eventRef, registrationRef, incarnation, eventRef, registrationRef, incarnation],
        );
        if (orphan.length !== 0) fail("unavailable");
        return null;
      }
      if (rows.length !== 1) fail("unavailable");
      const row = rows[0];
      if (
        !row ||
        typeof row.original_event_json !== "string" ||
        typeof row.receipt_json !== "string"
      )
        fail("unavailable");
      const event = parseFinancialSourceEvent(JSON.parse(row.original_event_json));
      const receipt = parseFinancialSourceReceipt(JSON.parse(row.receipt_json));
      const digest = await financialSourceEventDigest(event);
      if (
        event.eventRef !== eventRef ||
        event.registrationRef !== registrationRef ||
        event.incarnation !== incarnation ||
        canonicalFinancialSourceJson(event) !== row.original_event_json ||
        canonicalFinancialSourceJson(receipt) !== row.receipt_json ||
        !financialReceiptMatches(event, digest, receipt) ||
        receipt.receiptRef !== (await receiptReference(event, digest)) ||
        row.receipt_ref !== receipt.receiptRef ||
        row.event_digest !== digest ||
        row.original_event_digest !== digest ||
        row.original_registration_ref !== registrationRef ||
        row.original_incarnation !== incarnation ||
        row.original_affected_ref !== event.affectedRef ||
        row.original_sequence !== event.sequence ||
        row.affected_ref !== event.affectedRef ||
        row.retained_head !== event.affectedRef ||
        row.sequence !== event.sequence ||
        row.state !== receipt.state ||
        row.all_rows_match !== 1
      )
        fail("unavailable");
      return { event, receipt };
    } catch (error) {
      if (error instanceof SharedFinancialSourceError) throw error;
      fail("unavailable", { cause: error });
    }
  }

  function original(result: RetainedEvent, eventJson: string): FinancialSourceReceipt {
    if (canonicalFinancialSourceJson(result.event) !== eventJson) fail("source_conflict");
    return result.receipt;
  }

  async function applySourceEvent(input: FinancialSourceEvent): Promise<FinancialSourceReceipt> {
    let event: FinancialSourceEvent;
    try {
      event = Object.freeze(parseFinancialSourceEvent(input));
    } catch (error) {
      fail("invalid_event", { cause: error });
    }
    if (event.registrationRef !== registrationRef || event.incarnation !== incarnation)
      fail("source_conflict");
    const eventJson = canonicalFinancialSourceJson(event);
    const eventDigest = await financialSourceEventDigest(event);
    const prior = await retained(event.eventRef);
    if (prior) return original(prior, eventJson);

    let instant: string;
    try {
      const observed = clock();
      if (!(observed instanceof Date))
        throw new TypeError("Invalid Financial source observation clock");
      instant = Date.prototype.toISOString.call(observed);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant))
        throw new TypeError("Financial source observation clock is outside the SQL time range");
    } catch (error) {
      fail("unavailable", { cause: error });
    }

    let genesisQualificationRef: string;
    try {
      const evidence = JSON.parse(
        canonicalFinancialSourceJson(await readImmutableEvent(event.eventRef)),
      ) as SharedFinancialSourceImmutableEvidence | null;
      const evidenceFields = [
        "qualificationRef",
        "receiverRef",
        "targetRef",
        "genesisQualificationRef",
        "registration",
        "event",
      ];
      if (
        !evidence ||
        evidence.qualificationRef !== qualificationRef ||
        evidence.receiverRef !== receiverRef ||
        Object.keys(evidence).length !== evidenceFields.length ||
        Object.keys(evidence).some((key) => !evidenceFields.includes(key)) ||
        evidence.targetRef !== targetRef ||
        !financialSourceRef(evidence.genesisQualificationRef) ||
        canonicalFinancialSourceJson(parseFinancialSourceRegistration(evidence.registration)) !==
          registrationJson ||
        canonicalFinancialSourceJson(parseFinancialSourceEvent(evidence.event)) !== eventJson
      )
        fail("source_conflict");
      genesisQualificationRef = evidence.genesisQualificationRef;
    } catch (error) {
      if (error instanceof SharedFinancialSourceError) throw error;
      fail("unavailable", { cause: error });
    }
    const state = event.kind === "close" ? "admission-closed" : "advanced";
    const receipt: FinancialSourceReceipt = {
      v: 1,
      eventRef: event.eventRef,
      eventDigest,
      receiptRef: await receiptReference(event, eventDigest),
      incarnation,
      sequence: event.sequence,
      state,
    };
    // The captured Clock supplies observational persistence metadata only;
    // never an event identity, lease, expiry, ordering policy or authority.
    const statements: readonly SqlStatement[] = [
      {
        sql: `INSERT INTO financial_source_events
          (event_ref, registration_ref, incarnation, affected_ref, sequence, previous_digest,
           event_digest, kind, evidence_ref, event_json, applied_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM financial_source_registrations r JOIN financial_source_heads h
            ON h.registration_ref = r.registration_ref AND h.incarnation = r.incarnation
          WHERE ${currentRegistration} AND h.affected_ref = ? AND h.state = 'active'
            AND h.genesis_qualification_ref = ? AND h.sequence = ? AND h.event_digest = ?`,
        params: [
          event.eventRef,
          registrationRef,
          incarnation,
          event.affectedRef,
          event.sequence,
          event.previousDigest,
          eventDigest,
          event.kind,
          event.evidenceRef,
          eventJson,
          instant,
          ...currentParams,
          event.affectedRef,
          genesisQualificationRef,
          event.sequence - 1,
          event.previousDigest,
        ],
      },
      {
        sql: `UPDATE financial_source_heads SET sequence = ?, event_digest = ?,
          state = ?, last_event_ref = ?, updated_at = max(updated_at, created_at, ?)
          WHERE registration_ref = ? AND incarnation = ? AND affected_ref = ? AND state = 'active'
            AND genesis_qualification_ref = ? AND sequence = ? AND event_digest = ?
            AND EXISTS (SELECT 1 FROM financial_source_registrations r WHERE ${currentRegistration})
            AND EXISTS (SELECT 1 FROM financial_source_events e WHERE e.event_ref = ?
              AND e.registration_ref = ? AND e.incarnation = ? AND e.affected_ref = ?
              AND e.sequence = ? AND e.previous_digest = ? AND e.event_digest = ? AND e.event_json = ?)`,
        params: [
          event.sequence,
          eventDigest,
          event.kind === "close" ? "closed" : "active",
          event.eventRef,
          instant,
          registrationRef,
          incarnation,
          event.affectedRef,
          genesisQualificationRef,
          event.sequence - 1,
          event.previousDigest,
          ...currentParams,
          event.eventRef,
          registrationRef,
          incarnation,
          event.affectedRef,
          event.sequence,
          event.previousDigest,
          eventDigest,
          eventJson,
        ],
      },
      {
        // No WHERE/IGNORE/JS-ready bit: a skipped event or head must abort the
        // actual transaction, including an otherwise valid earlier event INSERT.
        sql: `INSERT INTO financial_source_receipts
          (event_ref, receipt_ref, registration_ref, incarnation, affected_ref, receiver_ref, target_ref,
           sequence, event_digest, state, receipt_json, created_at, all_rows_match)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN changes() = 1 AND EXISTS (
            SELECT 1 FROM financial_source_events e
            JOIN financial_source_heads h ON h.registration_ref = e.registration_ref
              AND h.incarnation = e.incarnation AND h.affected_ref = e.affected_ref
            JOIN financial_source_registrations r ON r.registration_ref = e.registration_ref AND r.incarnation = e.incarnation
            WHERE ${currentRegistration} AND e.event_ref = ? AND e.affected_ref = ? AND e.sequence = ?
              AND e.previous_digest = ? AND e.event_digest = ? AND e.kind = ? AND e.evidence_ref = ? AND e.event_json = ?
              AND h.sequence = e.sequence AND h.event_digest = e.event_digest AND h.last_event_ref = e.event_ref
              AND h.genesis_qualification_ref = ? AND h.state = ?
          ) THEN 1 ELSE 0 END)`,
        params: [
          event.eventRef,
          receipt.receiptRef,
          registrationRef,
          incarnation,
          event.affectedRef,
          receiverRef,
          targetRef,
          event.sequence,
          eventDigest,
          state,
          canonicalFinancialSourceJson(receipt),
          instant,
          ...currentParams,
          event.eventRef,
          event.affectedRef,
          event.sequence,
          event.previousDigest,
          eventDigest,
          event.kind,
          event.evidenceRef,
          eventJson,
          genesisQualificationRef,
          event.kind === "close" ? "closed" : "active",
        ],
      },
    ];
    // Every statement writes a 0104 money-fenced receiver table; nothing else is built.
    if (!isFinancialMoneyFencedBatch(statements)) fail("unavailable");
    try {
      await sql.batch(statements);
    } catch (error) {
      let committed: RetainedEvent | null;
      try {
        committed = await retained(event.eventRef);
      } catch (readError) {
        fail("unavailable", {
          cause: new AggregateError(
            [error, readError],
            "Financial source batch outcome is unreadable",
          ),
        });
      }
      if (committed) return original(committed, eventJson);
      if (error instanceof SqlError && error.code === "constraint")
        fail("source_conflict", { cause: error });
      fail("unavailable", { cause: error });
    }
    const committed = await retained(event.eventRef);
    if (!committed) fail("unavailable");
    return original(committed, eventJson);
  }

  return Object.freeze({
    applySourceEvent,
    async readSourceEventReceipt(eventRef: string) {
      if (!financialSourceRef(eventRef)) fail("invalid_event");
      return (await retained(eventRef))?.receipt ?? null;
    },
  });
}

/**
 * The closed external ABI over this actual primary store. It constructs its
 * own core from the same captured options; no injected replacement store or
 * outward receipt rewrite can stand in for a committed original receipt.
 * This factory still mounts no entry and provides no peer authentication.
 */
export function createSharedFinancialSourceReceiverAbi(
  options: SharedFinancialSourceReceiverOptions,
): FinancialSourceReceiverAbi {
  const registration = parseFinancialSourceRegistration(options.registration);
  const core = createSharedFinancialSourceReceiver({ ...options, registration });
  const { registrationRef } = registration;

  function externalError(error: unknown): never {
    if (error instanceof FinancialSourceAbiError) throw error;
    if (error instanceof SharedFinancialSourceError) {
      const code =
        error.code === "invalid_event"
          ? "invalid-request"
          : error.code === "source_conflict"
            ? "conflict"
            : "unavailable";
      throw new FinancialSourceAbiError(code, { cause: error });
    }
    throw new FinancialSourceAbiError("unavailable", { cause: error });
  }

  return Object.freeze({
    async applySourceEvent(input: unknown) {
      try {
        // The verifier detaches the envelope and recomputes its event digest
        // before even a primary read, including accepted-event replay.
        const request = await verifyFinancialSourceApplyRequest(input);
        if (request.event.registrationRef !== registrationRef)
          throw new FinancialSourceAbiError("unregistered-source");
        return await core.applySourceEvent(request.event);
      } catch (error) {
        externalError(error);
      }
    },
    async readSourceEventReceipt(input: unknown) {
      try {
        const request = parseFinancialSourceReadRequest(input);
        if (request.registrationRef !== registrationRef)
          throw new FinancialSourceAbiError("unregistered-source");
        const receipt = await core.readSourceEventReceipt(request.eventRef);
        if (receipt === null) return undefined;
        if (receipt.eventDigest !== request.eventDigest)
          throw new FinancialSourceAbiError("conflict");
        return receipt;
      } catch (error) {
        externalError(error);
      }
    },
  });
}
