import type { RetainedDirectOwnerSessionData } from "./auth.ts";
import type { RpAuthorityRecord } from "./credential-authority-class.ts";
import { readSharedAuthVerifiedPrincipalInput } from "./shared-auth-session.ts";
import type { PrincipalAnchor, SharedPrincipalBinding } from "./shared-principal-authority.ts";
import {
  assertWorkerRequestBackingOrigin,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedCredentialInputs,
  readWorkerRequestRetainedRpCapture,
  readWorkerRequestRetainedRpPrincipalBindingInputs,
  type WorkerRequestFinancialInputs,
  type WorkerRequestRetainedRpData,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

/** Redacted observation failure, never positive absence or permission to resend. */
export class WorkerRequestFinancialAuthOriginalUnavailable extends Error {
  readonly code = "unavailable" as const;
  constructor() {
    super("worker_request_financial_auth_original_unavailable");
    this.name = "WorkerRequestFinancialAuthOriginalUnavailable";
  }
}

export type WorkerRequestCredentialOriginalData =
  | RetainedDirectOwnerSessionData
  | {
      readonly backend: "shared-rp-session";
      readonly record: RpAuthorityRecord;
      readonly current: WorkerRequestRetainedRpData["current"];
    };

/** Original RP verification + matching retained DATA, not a qualified human. */
export interface WorkerRequestRpVerifiedBindingOriginalData {
  readonly anchor: PrincipalAnchor;
  readonly binding: SharedPrincipalBinding;
}

function unavailable(): never {
  throw new WorkerRequestFinancialAuthOriginalUnavailable();
}
function ownMethod(receiver: object, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(receiver, name);
  if (!d || !("value" in d) || typeof d.value !== "function") return unavailable();
  return d.value;
}

/**
 * Reuses actual original readers; accepts no row, schema/target strings, Clock,
 * Sql, family selector, callback or claimed authority. The second reader needs
 * TWO distinct originals: owning RP verified-principal input and final-touch
 * credential capture. Neither a token nor an existing Principal is a human
 * issuer. Output remains historical DATA while native103/Clock/human origin
 * qualification is absent. This is not FinancialAuthConsumerPort.
 */
export function createWorkerRequestFinancialAuthOriginalReaders(connection: WorkerRequestSql) {
  try {
    assertWorkerRequestBackingOrigin(connection);
    const inputs = readWorkerRequestFinancialInputs(connection);
    const consumers = readWorkerRequestConsumers(connection);
    const methods = [
      [inputs.sql, "query"],
      [inputs.sql, "run"],
      [inputs.sql, "batch"],
      [consumers.accounts, "captureAuthenticatedToken"],
      [consumers.accounts, "inspectAuthenticatedTokenCapture"],
      [consumers.accounts, "captureRetainedDirectOwnerSession"],
      [consumers.accounts, "readRetainedDirectOwnerSessionCapture"],
      [consumers.sharedAuth, "observeFinalWorkspaceOrganization"],
      [consumers.sharedAuth, "finalSessionSelection"],
    ] as const;
    const captured = methods.map(([receiver, name]) => ownMethod(receiver, name));
    const assertOriginal = () => {
      assertWorkerRequestBackingOrigin(connection);
      if (
        readWorkerRequestFinancialInputs(connection) !== inputs ||
        readWorkerRequestConsumers(connection) !== consumers ||
        methods.some(([receiver, name], i) => ownMethod(receiver, name) !== captured[i])
      )
        return unavailable();
    };
    const readRpOriginal = (original: unknown) => {
      assertOriginal();
      const selected = readSharedAuthVerifiedPrincipalInput(consumers.sharedAuth, original);
      assertOriginal();
      return selected;
    };
    assertOriginal();
    return Object.freeze({
      /** Retained credential metadata, not a live grant; no bearer is returned. */
      readCredentialOriginalData(original: unknown): WorkerRequestCredentialOriginalData | null {
        try {
          assertOriginal();
          const held = readWorkerRequestRetainedCredentialInputs(connection, original);
          assertOriginal();
          if (!held) return null;
          if (held.inputs !== inputs) return unavailable();
          const data = held.credentialOriginal;
          return data.backend === "auth-token"
            ? data
            : Object.freeze({
                backend: data.backend,
                record: data.record,
                current: data.current,
              });
        } catch {
          return unavailable();
        }
      },
      /**
       * Distinct verified RP input is required; credential-only and fresh callback
       * observations cannot stand in for the missing human issuer/session chain.
       * Retired rows remain historical; final same-primary admission is separate.
       */
      async readRpVerifiedPrincipalBindingOriginalData(
        originalVerifiedRpInput: unknown,
        originalRpCredential: unknown,
      ): Promise<WorkerRequestRpVerifiedBindingOriginalData | null> {
        try {
          assertOriginal();
          if (originalVerifiedRpInput === originalRpCredential) return null;
          const verified = readRpOriginal(originalVerifiedRpInput);
          if (!verified || verified.phase !== "existing-session") return null;
          const credential = readWorkerRequestRetainedRpCapture(connection, originalRpCredential);
          assertOriginal();
          if (!credential) return null;
          const { identity, workspace, sessionObservation: s } = verified;
          const r = credential.record;
          if (
            r.origin.principalId !== s.principalId ||
            r.rp.sessionDigest !== s.digest ||
            r.rp.sessionCreatedAt !== s.createdAt ||
            r.rp.workspaceId !== s.sessionWorkspaceId ||
            r.rp.enrolledSessionVersion > s.readVersion ||
            s.readVersion > s.resolvedVersion ||
            s.resolvedVersion > credential.current.version ||
            r.rp.issuer !== identity.issuer ||
            r.rp.clientId !== identity.clientId ||
            r.rp.subject !== identity.subject ||
            r.rp.accountId !== identity.accountId ||
            r.rp.issuerSessionId !== identity.sessionId ||
            r.rp.authTime !== identity.authTime ||
            workspace.id !== credential.selectedScope.workspaceId
          )
            return null;
          const retained = await readWorkerRequestRetainedRpPrincipalBindingInputs(
            connection,
            originalRpCredential,
          );
          assertOriginal();
          if (
            readRpOriginal(originalVerifiedRpInput) !== verified ||
            readWorkerRequestRetainedRpCapture(connection, originalRpCredential) !== credential
          )
            return unavailable();
          if (!retained) return null;
          if (retained.inputs !== inputs || retained.credentialOriginal !== credential)
            return unavailable();
          return Object.freeze({ anchor: retained.anchor, binding: retained.binding });
        } catch {
          // SQL unknown / origin mutation never becomes positive absence.
          return unavailable();
        }
      },
    });
  } catch {
    return unavailable();
  }
}

declare const authenticatedRpUserBindingBrand: unique symbol;

/** An actual verified RP user plus matching retained Root binding original.
 * Neither a human classification enum nor an admission/consent grant.
 */
export interface WorkerRequestAuthenticatedRpUserBindingOriginal {
  readonly [authenticatedRpUserBindingBrand]: true;
}

export interface WorkerRequestAuthenticatedRpUserBindingInputs {
  readonly inputs: WorkerRequestFinancialInputs;
  readonly anchor: PrincipalAnchor;
  readonly binding: SharedPrincipalBinding;
  /** Retained original registration metadata, not its own qualification. */
  readonly registrationOriginal: {
    readonly ref: RpAuthorityRecord["rp"]["registrationRef"];
    readonly digest: RpAuthorityRecord["rp"]["registrationDigest"];
  };
}

const authenticatedRpUserBindingOrigins = new WeakMap<
  object,
  {
    readonly connection: WorkerRequestSql;
    readonly verified: unknown;
    readonly credential: unknown;
    readonly readVerified: ReturnType<typeof readSharedAuthVerifiedPrincipalInput>;
    readonly credentialData: WorkerRequestRetainedRpData;
    readonly selected: WorkerRequestAuthenticatedRpUserBindingInputs;
  }
>();

/**
 * Root source-owned capture, not a constructor from DTOs. Both accepted inputs
 * are original objects authenticated by the actual owning RP/request readers.
 * The selected Clock stays the same captured callable in inputs; its source
 * policy/enrollment qualification must still come through the native ingress.
 */
export async function captureWorkerRequestAuthenticatedRpUserBindingOriginal(
  connection: WorkerRequestSql,
  originalVerifiedRpInput: unknown,
  originalRpCredential: unknown,
): Promise<WorkerRequestAuthenticatedRpUserBindingOriginal | null> {
  try {
    assertWorkerRequestBackingOrigin(connection);
    const inputs = readWorkerRequestFinancialInputs(connection);
    const consumers = readWorkerRequestConsumers(connection);
    const verified = readSharedAuthVerifiedPrincipalInput(
      consumers.sharedAuth,
      originalVerifiedRpInput,
    );
    const credential = readWorkerRequestRetainedRpCapture(connection, originalRpCredential);
    if (!verified || !credential) return null;
    const selected = await createWorkerRequestFinancialAuthOriginalReaders(
      connection,
    ).readRpVerifiedPrincipalBindingOriginalData(originalVerifiedRpInput, originalRpCredential);
    assertWorkerRequestBackingOrigin(connection);
    if (
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestConsumers(connection) !== consumers ||
      readSharedAuthVerifiedPrincipalInput(consumers.sharedAuth, originalVerifiedRpInput) !==
        verified ||
      readWorkerRequestRetainedRpCapture(connection, originalRpCredential) !== credential
    )
      return unavailable();
    if (
      !selected ||
      selected.anchor.state !== "active" ||
      selected.anchor.terminal !== null ||
      selected.binding.state !== "active" ||
      selected.binding.terminal !== null
    )
      return null;
    const data = Object.freeze({
      inputs,
      anchor: selected.anchor,
      binding: selected.binding,
      registrationOriginal: Object.freeze({
        ref: credential.record.rp.registrationRef,
        digest: credential.record.rp.registrationDigest,
      }),
    });
    const capture = Object.freeze({}) as WorkerRequestAuthenticatedRpUserBindingOriginal;
    authenticatedRpUserBindingOrigins.set(capture, {
      connection,
      verified: originalVerifiedRpInput,
      credential: originalRpCredential,
      readVerified: verified,
      credentialData: credential,
      selected: data,
    });
    return capture;
  } catch {
    return unavailable();
  }
}

/**
 * Separate original user-binding reader: token/credential handles, Actor, copies
 * and foreign factories cannot select an entry. The returned Clock/Sql/realm are
 * existing original graph values, never a new source-policy or native103 claim.
 */
export function readWorkerRequestAuthenticatedRpUserBindingOriginal(
  connection: WorkerRequestSql,
  capture: unknown,
): WorkerRequestAuthenticatedRpUserBindingInputs | null {
  try {
    assertWorkerRequestBackingOrigin(connection);
    if (!capture || typeof capture !== "object") return null;
    const held = authenticatedRpUserBindingOrigins.get(capture);
    if (!held || held.connection !== connection) return null;
    const inputs = readWorkerRequestFinancialInputs(connection);
    const consumers = readWorkerRequestConsumers(connection);
    if (
      inputs !== held.selected.inputs ||
      readSharedAuthVerifiedPrincipalInput(consumers.sharedAuth, held.verified) !==
        held.readVerified ||
      readWorkerRequestRetainedRpCapture(connection, held.credential) !== held.credentialData
    )
      return unavailable();
    assertWorkerRequestBackingOrigin(connection);
    return held.selected;
  } catch {
    return unavailable();
  }
}
