import { canonicalJson, isSha256Digest } from "./json.ts";
import type { Clock, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import { normalizeSharedAppName } from "./shared-app-name.ts";

export type SharedAppEnvironment = "staging" | "production";
export type SharedAppProduct = "takoserver" | "takosumi-hosted";

/** Construct only from the existing authenticated business/resource authority. */
export interface TrustedSharedAppOwner {
  readonly organizationId: string;
  readonly product: SharedAppProduct;
}

export interface SharedAppPin extends TrustedSharedAppOwner {
  readonly environment: SharedAppEnvironment;
  readonly name: string;
  readonly reservationId: string;
  readonly incarnation: string;
  readonly generation: number;
}

export interface SharedAppAssignment extends SharedAppPin {
  readonly state: "reserved" | "active" | "released";
  readonly script: string | null;
  readonly releasedAt: number | null;
}

export interface SharedAppSelection extends SharedAppPin {
  readonly script: string;
}

/** Exact native row data, not a grant or a replacement for its owning SQL guards. */
export interface SharedAppNativeRouteRowPin {
  readonly providerId: string;
  readonly routeKind: "host" | "worker";
  readonly routeKey: string;
  readonly ownerNativeId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly state: "active" | "tombstone";
  readonly valueJson: string;
}

export interface SharedAppFormV2ReleasePin {
  readonly versionUid: string;
  readonly versionGeneration: number;
  readonly scriptName: string;
  readonly weight: number;
  readonly descriptorDigest: `sha256:${string}`;
  readonly providerEtag: string;
}

export interface SharedAppFormV2Binding {
  readonly kind: "form-v2@1";
  readonly endpoint: { readonly uid: string; readonly generation: number };
  readonly workerUid: string;
  readonly deployment: { readonly uid: string; readonly generation: number };
  readonly providerId: string;
  readonly targetKey: string;
  readonly nativeSourceOperationId: string;
  readonly hostRow: SharedAppNativeRouteRowPin;
  readonly workerRow: SharedAppNativeRouteRowPin;
  readonly releases: readonly SharedAppFormV2ReleasePin[];
}

export type SharedAppFormV2RouteAssignment = {
  readonly kind: "form-v2@1";
  readonly pin: SharedAppPin;
} & (
  | {
      readonly state: "active";
      readonly releasedAt: null;
      readonly binding: SharedAppFormV2Binding;
    }
  | { readonly state: "reserved"; readonly releasedAt: null; readonly binding: null }
  | { readonly state: "released"; readonly releasedAt: number; readonly binding: null }
);

export type SharedAppRouteAssignment =
  | { readonly kind: "scalar"; readonly value: SharedAppAssignment }
  | SharedAppFormV2RouteAssignment;

export type SharedAppRouteSelection =
  | { readonly kind: "scalar"; readonly value: SharedAppSelection }
  | {
      readonly kind: "form-v2@1";
      readonly pin: SharedAppPin;
      readonly binding: SharedAppFormV2Binding;
    };

export interface SharedAppFormV2AcceptedCommand {
  readonly kind: "endpoint" | "deployment";
  readonly action: "create" | "update" | "delete";
  readonly resourceUid: string;
  readonly generation: number;
  readonly operationId: string;
  readonly formUrl: string;
  readonly backendId: string;
  readonly targetKey: string;
}

export interface SharedAppFormV2EndpointBindingPin {
  readonly incarnation: string;
  readonly organizationId: string;
  readonly product: SharedAppProduct;
  readonly reservationId: string;
  readonly name: string;
  readonly endpointUid: string;
  readonly endpointGeneration: number;
  readonly formUrl: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly createOperationId: string;
  readonly currentOperationId: string;
}

/** The key also captures a genuinely missing predecessor, without inventing a native row. */
export interface SharedAppNativeRouteSnapshot {
  readonly providerId: string;
  readonly routeKind: "host" | "worker";
  readonly routeKey: string;
  readonly row: SharedAppNativeRouteRowPin | null;
}

export interface TrustedSharedAppFormV2RouteInput {
  readonly commandRef: string;
  readonly principal: string;
  readonly space: string;
  readonly expected: SharedAppRouteAssignment;
  readonly accepted: SharedAppFormV2AcceptedCommand;
  readonly endpointBinding: SharedAppFormV2EndpointBindingPin;
  readonly priorBinding: SharedAppFormV2Binding | null;
  readonly nextBinding: SharedAppFormV2Binding | null;
  readonly nativeBefore: readonly SharedAppNativeRouteSnapshot[];
  readonly nativeAfter: readonly SharedAppNativeRouteSnapshot[];
}

export interface SharedAppFormV2RouteOriginal
  extends TrustedSharedAppFormV2RouteInput,
    TrustedSharedAppOwner {
  readonly environment: SharedAppEnvironment;
  readonly action: "activate" | "advance" | "retire";
}

export interface SharedAppFormV2RouteReceipt {
  readonly original: SharedAppFormV2RouteOriginal;
  /** A historical outcome. Current serving still requires a fresh full-route fence. */
  readonly assignment: SharedAppFormV2RouteAssignment;
}

export interface SharedAppFormV2RouteEffects {
  readonly original: SharedAppFormV2RouteOriginal;
  readonly before: readonly SqlStatement[];
  readonly publicationGuard: SqlStatement;
  readonly after: readonly SqlStatement[];
}

/** Actual accepted v2 pins supplied only by the owning business/publication composition. */
export interface TrustedSharedAppRouteInput {
  readonly commandRef: string;
  readonly expected: SharedAppAssignment;
  readonly accepted: {
    readonly principal: string;
    readonly space: string;
    readonly endpointUid: string;
    readonly endpointGeneration: number;
    readonly workerUid: string;
    readonly deploymentUid: string;
    readonly deploymentGeneration: number;
    readonly sourceOperationId: string;
    readonly providerId: string;
    readonly targetKey: string;
    readonly script: string | null;
  };
}

/** Trusted parameterized SQL from the existing owner acceptance/publication predicates, never HTTP input. */
export interface TrustedSharedAppRouteGuards {
  readonly admission: {
    readonly sql: string;
    readonly params: readonly (string | number | null)[];
  };
  readonly publication: {
    readonly sql: string;
    readonly params: readonly (string | number | null)[];
  };
}

export interface SharedAppRouteOriginal extends TrustedSharedAppOwner {
  readonly environment: SharedAppEnvironment;
  readonly reservationId: string;
  readonly name: string;
  readonly action: "activate" | "advance" | "retire";
  readonly incarnation: string;
  readonly expectedGeneration: number;
  readonly expectedState: "reserved" | "active";
  readonly expectedScript: string | null;
  readonly acceptedScript: string | null;
  readonly commandRef: string;
  readonly endpointUid: string;
  readonly endpointGeneration: number;
  readonly workerUid: string;
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly sourceOperationId: string;
  readonly providerId: string;
  readonly targetKey: string;
}

export interface SharedAppRouteReceipt {
  readonly original: SharedAppRouteOriginal;
  /** Historical command outcome; use fresh readCurrent for current serving authority. */
  readonly assignment: SharedAppAssignment;
}

export interface SharedAppRouteEffects {
  readonly original: SharedAppRouteOriginal;
  readonly before: readonly SqlStatement[];
  /** AND this predicate into the ACTUAL owner route mutation, between before and after. */
  readonly publicationGuard: SqlStatement;
  readonly after: readonly SqlStatement[];
}

export interface SharedAppLegacyProjection {
  readonly sourceReference: string;
  readonly requestedName: string;
  readonly state: "prepared" | "bound" | "activated" | "expired" | "released";
  readonly releasedAt: number | null;
}

/** Read-only adoption inventory. It neither chooses collision winners nor writes legacy rows. */
export function planSharedAppLegacyAdoption(rows: readonly SharedAppLegacyProjection[]): {
  readonly candidates: readonly {
    readonly name: string;
    readonly original: SharedAppLegacyProjection;
  }[];
  readonly blocked: readonly {
    readonly sourceReference: string;
    readonly reason: "drain_only" | "collision";
  }[];
} {
  const candidates: { name: string; original: SharedAppLegacyProjection }[] = [];
  const blocked: { sourceReference: string; reason: "drain_only" | "collision" }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const sourceReference = opaque(row.sourceReference);
    if (seen.has(sourceReference)) fail("invalid_argument");
    seen.add(sourceReference);
    const original = Object.freeze({
      sourceReference,
      requestedName: row.requestedName,
      state: row.state,
      releasedAt: row.releasedAt,
    });
    let name: string;
    try {
      name = normalizeSharedAppName(row.requestedName);
    } catch {
      blocked.push({ sourceReference, reason: "drain_only" });
      continue;
    }
    if (
      !["prepared", "bound", "activated", "expired", "released"].includes(row.state) ||
      (row.releasedAt !== null && (!Number.isSafeInteger(row.releasedAt) || row.releasedAt < 0)) ||
      (row.state === "released") !== (row.releasedAt !== null)
    )
      fail("invalid_argument");
    candidates.push({ name, original });
  }
  const aliases = new Map<string, number>();
  for (const value of candidates) aliases.set(value.name, (aliases.get(value.name) ?? 0) + 1);
  return Object.freeze({
    candidates: Object.freeze(
      candidates
        .filter((value) => {
          if (aliases.get(value.name) === 1) return true;
          blocked.push({ sourceReference: value.original.sourceReference, reason: "collision" });
          return false;
        })
        .map((value) => Object.freeze(value)),
    ),
    blocked: Object.freeze(blocked.map((value) => Object.freeze(value))),
  });
}

export class SharedAppLedgerError extends Error {
  constructor(
    readonly code: "invalid_argument" | "conflict" | "unavailable" | "indeterminate",
    /** Retain this original command after an unknown write ACK; never mint a replacement. */
    readonly original?:
      | SharedAppRouteOriginal
      | SharedAppFormV2RouteOriginal
      | Readonly<
          TrustedSharedAppOwner & {
            readonly reservationId: string;
            readonly name: string;
            readonly action: "reserve" | "activate" | "release";
            readonly incarnation: string;
            readonly expectedGeneration: number | null;
            readonly acceptedScript: string | null;
          }
        >,
  ) {
    super(code);
    this.name = "SharedAppLedgerError";
  }
}

export interface SharedAppLedger {
  /** This is a trusted composition port, not an HTTP credential or caller-selected scope. */
  forTrustedOwner(owner: TrustedSharedAppOwner): {
    reserve(input: {
      readonly reservationId: string;
      readonly name: string;
    }): Promise<SharedAppAssignment>;
    /** Script pins come from authoritative accepted resource/Provider readback, never a public body. */
    activate(expected: SharedAppPin, acceptedScript: string): Promise<SharedAppAssignment>;
    /** These pure preparations NEVER commit. Compose before + actual guarded owner SQL + after in ONE batch. */
    prepareActivate(
      input: TrustedSharedAppRouteInput,
      guards: TrustedSharedAppRouteGuards,
    ): SharedAppRouteEffects;
    prepareAdvance(
      input: TrustedSharedAppRouteInput,
      guards: TrustedSharedAppRouteGuards,
    ): SharedAppRouteEffects;
    prepareRetire(
      input: TrustedSharedAppRouteInput,
      guards: TrustedSharedAppRouteGuards,
    ): SharedAppRouteEffects;
    readRouteCommand(commandRef: string): Promise<SharedAppRouteReceipt | null>;
    /** Readback only; unknown ACK never causes another write or native invocation. */
    settleRoute(
      original: SharedAppRouteOriginal,
      acknowledgment: "acknowledged" | "unknown",
    ): Promise<SharedAppRouteReceipt>;
    release(expected: SharedAppPin): Promise<SharedAppAssignment>;
    readOriginal(reservationId: string): Promise<SharedAppAssignment | null>;
    readOriginalRoute(reservationId: string): Promise<SharedAppRouteAssignment | null>;
    prepareFormV2Route(
      action: SharedAppFormV2RouteOriginal["action"],
      input: TrustedSharedAppFormV2RouteInput,
      guards: TrustedSharedAppRouteGuards,
    ): SharedAppFormV2RouteEffects;
    readFormV2RouteCommand(commandRef: string): Promise<SharedAppFormV2RouteReceipt | null>;
    settleFormV2Route(
      original: SharedAppFormV2RouteOriginal,
      acknowledgment: "acknowledged" | "unknown",
    ): Promise<SharedAppFormV2RouteReceipt>;
  };
  readCurrent(name: string): Promise<SharedAppSelection | null>;
  isCurrentBeforeDispatch(selected: SharedAppSelection): Promise<boolean>;
  isCurrentAfterDispatch(selected: SharedAppSelection): Promise<boolean>;
  readCurrentRoute(name: string): Promise<SharedAppRouteSelection | null>;
  isRouteCurrentBeforeDispatch(selected: SharedAppRouteSelection): Promise<boolean>;
  isRouteCurrentAfterDispatch(selected: SharedAppRouteSelection): Promise<boolean>;
}

/**
 * Unmounted source preparation. There is no DDL, public route, recovery bypass,
 * gateway activation or cache authority here. Each primary() call must open a
 * fresh primary session; the D1 composition supplies that capability.
 */
export function createSharedAppLedger(options: {
  readonly environment: SharedAppEnvironment;
  readonly primary: () => Sql;
  readonly clock?: Clock;
}): SharedAppLedger {
  const environment = environmentValue(options.environment);
  const primary = options.primary;
  const clock = options.clock ?? (() => new Date());
  const prefix = environment === "staging" ? "shared_app_staging" : "shared_app_production";
  const names = `${prefix}_names`;
  const assignments = `${prefix}_assignments`;
  const timestamp = (): number => {
    const value = clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) fail("unavailable");
    return value;
  };
  const original = async (
    owner: TrustedSharedAppOwner,
    reservationId: string,
  ): Promise<SharedAppAssignment | null> => {
    const rows = await primary().query(
      `SELECT * FROM ${assignments} WHERE organization_id = ? AND reservation_id = ? LIMIT 2`,
      [owner.organizationId, reservationId],
    );
    if (rows.length > 1) fail("unavailable");
    const row = rows[0];
    if (!row) return null;
    const value = assignment(row, environment);
    if (value.product !== owner.product) fail("conflict");
    return value;
  };
  const current = async (name: string): Promise<SharedAppSelection | null> => {
    const rows = await primary().query(
      `SELECT a.* FROM ${names} AS n LEFT JOIN ${assignments} AS a
         ON a.name = n.normalized_name AND a.incarnation = n.incarnation
        AND a.generation = n.generation AND a.state = n.state
       WHERE n.normalized_name = ? AND n.state = 'active' LIMIT 2`,
      [name],
    );
    if (rows.length > 1) fail("unavailable");
    if (!rows[0]) return null;
    const value = assignment(rows[0], environment);
    if (value.name !== name || value.state !== "active" || !value.script) fail("unavailable");
    return Object.freeze({ ...pin(value), script: value.script });
  };
  const recheck = async (selected: SharedAppSelection): Promise<boolean> => {
    const expected = selectedPin(selected, environment);
    const script = opaque(selected.script);
    return current(expected.name).then(
      (value) => value !== null && samePin(value, expected) && value.script === script,
    );
  };
  const originalRoute = async (
    owner: TrustedSharedAppOwner,
    reservationId: string,
  ): Promise<SharedAppRouteAssignment | null> => {
    const rows = await primary().query(
      `SELECT * FROM ${assignments} WHERE organization_id = ? AND reservation_id = ? LIMIT 2`,
      [owner.organizationId, reservationId],
    );
    if (rows.length > 1) fail("unavailable");
    if (!rows[0]) return null;
    const result = formAssignmentRow(rows[0], environment);
    if (formAssignmentPin(result).product !== owner.product) fail("conflict");
    return result;
  };
  const currentRoute = async (name: string): Promise<SharedAppRouteSelection | null> => {
    const rows = await primary().query(
      `SELECT a.* FROM ${names} AS n LEFT JOIN ${assignments} AS a
         ON a.name = n.normalized_name AND a.incarnation = n.incarnation
        AND a.generation = n.generation AND a.state = n.state
       WHERE n.normalized_name = ? AND n.state = 'active' AND n.released_at IS NULL LIMIT 2`,
      [name],
    );
    if (rows.length > 1) fail("unavailable");
    if (!rows[0]) return null;
    const result = formAssignmentRow(rows[0], environment);
    const selected = formAssignmentPin(result);
    if (selected.name !== name || formAssignmentState(result) !== "active") fail("unavailable");
    if (result.kind === "scalar") {
      if (!result.value.script) return fail("unavailable");
      return Object.freeze({
        kind: "scalar",
        value: Object.freeze({ ...pin(result.value), script: result.value.script }),
      });
    }
    if (result.state !== "active") return fail("unavailable");
    return Object.freeze({ kind: FORM_V2_ROUTE_KIND, pin: result.pin, binding: result.binding });
  };
  const recheckRoute = async (selected: SharedAppRouteSelection): Promise<boolean> => {
    const expected = formSelection(selected, environment);
    const name = expected.kind === "scalar" ? expected.value.name : expected.pin.name;
    const now = await currentRoute(name);
    return now !== null && formSame(expected, now);
  };
  return {
    async readCurrent(name) {
      // KV hits AND misses must reach this read. No hint can bypass it.
      return current(normalize(name));
    },
    isCurrentBeforeDispatch: recheck,
    isCurrentAfterDispatch: recheck,
    async readCurrentRoute(name) {
      return currentRoute(normalize(name));
    },
    isRouteCurrentBeforeDispatch: recheckRoute,
    isRouteCurrentAfterDispatch: recheckRoute,
    forTrustedOwner(input) {
      const owner = Object.freeze({
        organizationId: opaque(input.organizationId),
        product: productValue(input.product),
      });
      const ownedPin = (value: SharedAppPin): SharedAppPin => {
        const expected = selectedPin(value, environment);
        if (expected.organizationId !== owner.organizationId || expected.product !== owner.product)
          fail("conflict");
        return expected;
      };
      const read = (reservationId: string) => original(owner, opaque(reservationId));
      const routeHistory = `${prefix}_route_commands`;
      const readRouteCommand = async (
        commandRef: string,
      ): Promise<SharedAppRouteReceipt | null> => {
        const reference = opaque(commandRef);
        const rows = await primary().query(
          `SELECT * FROM ${routeHistory} WHERE organization_id = ? AND command_ref = ? LIMIT 2`,
          [owner.organizationId, reference],
        );
        if (rows.length > 1) fail("unavailable");
        if (!rows[0]) return null;
        const receipt = routeReceipt(rows[0], environment);
        if (receipt.original.product !== owner.product) fail("conflict");
        return receipt;
      };
      const readFormV2RouteCommand = async (
        commandRef: string,
      ): Promise<SharedAppFormV2RouteReceipt | null> => {
        const reference = formText(commandRef, 298);
        const rows = await primary().query(
          `SELECT * FROM ${routeHistory} WHERE organization_id = ? AND command_ref = ? LIMIT 2`,
          [owner.organizationId, reference],
        );
        if (rows.length > 1) fail("unavailable");
        if (!rows[0]) return null;
        const receipt = formReceipt(rows[0], environment);
        if (receipt.original.product !== owner.product) fail("conflict");
        return receipt;
      };
      const prepareRoute = (
        action: SharedAppRouteOriginal["action"],
        input: TrustedSharedAppRouteInput,
        guards: TrustedSharedAppRouteGuards,
      ): SharedAppRouteEffects => {
        // Capture every caller/owner pin, predicate and parameter synchronously, before any await.
        const command = routeOriginal(action, input, owner, environment);
        return routeEffects(command, guards, timestamp());
      };
      const mutate = async (
        expected: SharedAppPin,
        state: "active" | "released",
        script: string | null,
      ): Promise<SharedAppAssignment> => {
        const command = Object.freeze({
          ...owner,
          reservationId: expected.reservationId,
          name: expected.name,
          action: state === "active" ? ("activate" as const) : ("release" as const),
          incarnation: expected.incarnation,
          expectedGeneration: expected.generation,
          acceptedScript: script,
        });
        const before = await original(owner, expected.reservationId);
        const settled = (value: SharedAppAssignment | null): boolean =>
          value !== null &&
          value.name === expected.name &&
          value.incarnation === expected.incarnation &&
          value.generation === expected.generation + 1 &&
          value.state === state &&
          (state === "released" || value.script === script);
        if (before && settled(before)) return before;
        if (
          !before ||
          !samePin(before, expected) ||
          before.state === "released" ||
          (state === "active" && before.state !== "reserved")
        )
          fail("conflict");
        const now = timestamp();
        const releasedAt = state === "released" ? now : null;
        const nextScript = state === "released" ? before.script : script;
        const statements: readonly SqlStatement[] = [
          {
            sql: `UPDATE ${assignments} SET state = ?, script = ?, generation = generation + 1,
                    released_at = ?, updated_at = ?
                  WHERE organization_id = ? AND reservation_id = ? AND name = ?
                    AND incarnation = ? AND generation = ? AND state = ?
                    AND EXISTS (SELECT 1 FROM ${names} WHERE normalized_name = ?
                      AND incarnation = ? AND generation = ? AND state = ?)`,
            params: [
              state,
              nextScript,
              releasedAt,
              now,
              owner.organizationId,
              expected.reservationId,
              expected.name,
              expected.incarnation,
              expected.generation,
              before.state,
              expected.name,
              expected.incarnation,
              expected.generation,
              before.state,
            ],
          },
          {
            sql: `UPDATE ${names} SET state = ?, generation = generation + 1,
                    released_at = ?, updated_at = ?
                  WHERE normalized_name = ? AND incarnation = ? AND generation = ? AND state = ?
                    AND EXISTS (SELECT 1 FROM ${assignments} WHERE incarnation = ?
                      AND generation = ? AND state = ? AND released_at IS ? AND script IS ?)`,
            params: [
              state,
              releasedAt,
              now,
              expected.name,
              expected.incarnation,
              expected.generation,
              before.state,
              expected.incarnation,
              expected.generation + 1,
              state,
              releasedAt,
              nextScript,
            ],
          },
        ];
        try {
          await primary().batch(statements);
        } catch {
          // Do not repeat a write, reset state or change its original reference.
          const observed = await original(owner, expected.reservationId).catch(() => null);
          if (observed && settled(observed)) return observed;
          throw new SharedAppLedgerError("indeterminate", command);
        }
        const observed = await original(owner, expected.reservationId).catch(() => {
          throw new SharedAppLedgerError("indeterminate", command);
        });
        if (!observed || !settled(observed)) fail("conflict");
        return observed;
      };
      return {
        readOriginal: read,
        readOriginalRoute: (reservationId) => originalRoute(owner, opaque(reservationId)),
        prepareFormV2Route: (action, input, guards) =>
          formEffects(formOriginal(action, input, owner, environment), guards, timestamp()),
        readFormV2RouteCommand,
        async settleFormV2Route(input, acknowledgment) {
          // Snapshot the complete original before starting a fresh-primary read.
          const command = captureFormOriginal(input, owner, environment);
          if (acknowledgment !== "acknowledged" && acknowledgment !== "unknown")
            fail("invalid_argument");
          let receipt: SharedAppFormV2RouteReceipt | null;
          try {
            receipt = await readFormV2RouteCommand(command.commandRef);
          } catch (error) {
            if (error instanceof SharedAppLedgerError && error.code === "conflict") throw error;
            throw new SharedAppLedgerError("indeterminate", command);
          }
          if (receipt) {
            if (!formSame(receipt.original, command))
              throw new SharedAppLedgerError("conflict", command);
            return receipt;
          }
          if (acknowledgment === "unknown")
            throw new SharedAppLedgerError("indeterminate", command);
          throw new SharedAppLedgerError("conflict", command);
        },
        prepareActivate: (input, guards) => prepareRoute("activate", input, guards),
        prepareAdvance: (input, guards) => prepareRoute("advance", input, guards),
        prepareRetire: (input, guards) => prepareRoute("retire", input, guards),
        readRouteCommand,
        async settleRoute(input, acknowledgment) {
          const command = captureRouteOriginal(input, owner, environment);
          if (acknowledgment !== "acknowledged" && acknowledgment !== "unknown")
            fail("invalid_argument");
          let receipt: SharedAppRouteReceipt | null;
          try {
            receipt = await readRouteCommand(command.commandRef);
          } catch (error) {
            if (error instanceof SharedAppLedgerError && error.code === "conflict") throw error;
            throw new SharedAppLedgerError("indeterminate", command);
          }
          if (receipt) {
            if (!sameRouteOriginal(receipt.original, command)) fail("conflict");
            return receipt;
          }
          if (acknowledgment === "unknown")
            throw new SharedAppLedgerError("indeterminate", command);
          return fail("conflict");
        },
        async reserve(input) {
          // Snapshot all mutable caller objects before the first await.
          const incarnation = crypto.randomUUID().replaceAll("-", "");
          const command = Object.freeze({
            ...owner,
            reservationId: opaque(input.reservationId),
            name: normalize(input.name),
            action: "reserve" as const,
            incarnation,
            expectedGeneration: null,
            acceptedScript: null,
          });
          const existing = await original(owner, command.reservationId);
          const replay = (value: SharedAppAssignment): SharedAppAssignment => {
            if (value.name !== command.name || value.state === "released") fail("conflict");
            return value;
          };
          if (existing) return replay(existing);
          const now = timestamp();
          // A name belongs to one incarnation forever. Check retained assignment
          // history as well as the head, and never replace a released head.
          try {
            await primary().batch([
              {
                sql: `INSERT INTO ${assignments}
                    (incarnation, name, organization_id, product, reservation_id, generation,
                     state, script, released_at, created_at, updated_at)
                  SELECT ?, ?, ?, ?, ?, 1, 'reserved', NULL, NULL, ?, ?
                  WHERE NOT EXISTS (SELECT 1 FROM ${assignments}
                    WHERE organization_id = ? AND reservation_id = ?)
                    AND NOT EXISTS (SELECT 1 FROM ${names} WHERE normalized_name = ?)
                    AND NOT EXISTS (SELECT 1 FROM ${assignments} WHERE name = ?)`,
                params: [
                  incarnation,
                  command.name,
                  owner.organizationId,
                  owner.product,
                  command.reservationId,
                  now,
                  now,
                  owner.organizationId,
                  command.reservationId,
                  command.name,
                  command.name,
                ],
              },
              {
                sql: `INSERT INTO ${names} (normalized_name, incarnation, generation, state, released_at, updated_at)
                  SELECT name, incarnation, generation, state, NULL, updated_at FROM ${assignments}
                    WHERE incarnation = ?`,
                params: [incarnation],
              },
            ]);
          } catch {
            const observed = await original(owner, command.reservationId).catch(() => null);
            if (observed) return replay(observed);
            throw new SharedAppLedgerError("indeterminate", command);
          }
          const observed = await original(owner, command.reservationId).catch(() => {
            throw new SharedAppLedgerError("indeterminate", command);
          });
          if (!observed) fail("conflict");
          return replay(observed);
        },
        async activate(value, acceptedScript) {
          const expected = ownedPin(value);
          const script = opaque(acceptedScript);
          return mutate(expected, "active", script);
        },
        async release(value) {
          return mutate(ownedPin(value), "released", null);
        },
      };
    },
  };
}

function fail(code: SharedAppLedgerError["code"]): never {
  throw new SharedAppLedgerError(code);
}

function normalize(value: unknown): string {
  try {
    return normalizeSharedAppName(value);
  } catch {
    return fail("invalid_argument");
  }
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    fail("invalid_argument");
  return value;
}

function productValue(value: unknown): SharedAppProduct {
  if (value !== "takoserver" && value !== "takosumi-hosted") fail("invalid_argument");
  return value;
}

function environmentValue(value: unknown): SharedAppEnvironment {
  if (value !== "staging" && value !== "production") fail("invalid_argument");
  return value;
}

function selectedPin(value: SharedAppPin, environment: SharedAppEnvironment): SharedAppPin {
  if (
    value.environment !== environment ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    value.generation >= Number.MAX_SAFE_INTEGER ||
    !/^[0-9a-f]{32}$/u.test(value.incarnation)
  )
    fail("invalid_argument");
  return Object.freeze({
    environment,
    name: normalize(value.name),
    organizationId: opaque(value.organizationId),
    product: productValue(value.product),
    reservationId: opaque(value.reservationId),
    incarnation: value.incarnation,
    generation: value.generation,
  });
}

function pin(value: SharedAppPin): SharedAppPin {
  return {
    environment: value.environment,
    name: value.name,
    organizationId: value.organizationId,
    product: value.product,
    reservationId: value.reservationId,
    incarnation: value.incarnation,
    generation: value.generation,
  };
}

function samePin(left: SharedAppPin, right: SharedAppPin): boolean {
  return (
    left.environment === right.environment &&
    left.name === right.name &&
    left.organizationId === right.organizationId &&
    left.product === right.product &&
    left.reservationId === right.reservationId &&
    left.incarnation === right.incarnation &&
    left.generation === right.generation
  );
}

function assignment(row: Row, environment: SharedAppEnvironment): SharedAppAssignment {
  // Old installed schemas omit these fields. A tagged retired row is still not scalar.
  if (row.binding_kind != null || row.binding_json != null) fail("unavailable");
  const state = row.state;
  const script = row.script;
  const releasedAt = row.released_at;
  if (
    (state !== "reserved" && state !== "active" && state !== "released") ||
    (script !== null && typeof script !== "string") ||
    (state === "reserved" && script !== null) ||
    (state === "active" && script === null) ||
    (releasedAt !== null && (!Number.isSafeInteger(releasedAt) || Number(releasedAt) < 0)) ||
    (state === "released") !== (releasedAt !== null)
  )
    fail("unavailable");
  try {
    const value = selectedPin(
      {
        environment,
        name: row.name as string,
        organizationId: row.organization_id as string,
        product: row.product as SharedAppProduct,
        reservationId: row.reservation_id as string,
        incarnation: row.incarnation as string,
        generation: row.generation as number,
      },
      environment,
    );
    if (value.name !== row.name) fail("unavailable");
    return Object.freeze({
      ...value,
      state,
      script: script === null ? null : opaque(script),
      releasedAt: releasedAt as number | null,
    });
  } catch {
    return fail("unavailable");
  }
}

const ROUTE_COLUMNS = [
  ["organizationId", "organization_id"],
  ["product", "product"],
  ["reservationId", "reservation_id"],
  ["name", "name"],
  ["incarnation", "incarnation"],
  ["action", "action"],
  ["commandRef", "command_ref"],
  ["expectedGeneration", "prior_generation"],
  ["expectedState", "prior_state"],
  ["expectedScript", "prior_script"],
  ["acceptedScript", "next_script"],
  ["endpointUid", "endpoint_uid"],
  ["endpointGeneration", "endpoint_generation"],
  ["workerUid", "worker_uid"],
  ["deploymentUid", "deployment_uid"],
  ["deploymentGeneration", "deployment_generation"],
  ["sourceOperationId", "source_operation_id"],
  ["providerId", "provider_id"],
  ["targetKey", "target_key"],
] as const;

function routeOriginal(
  action: SharedAppRouteOriginal["action"],
  input: TrustedSharedAppRouteInput,
  owner: TrustedSharedAppOwner,
  environment: SharedAppEnvironment,
): SharedAppRouteOriginal {
  const expected = selectedPin(input.expected, environment);
  const state = input.expected.state;
  const previousScript = input.expected.script === null ? null : opaque(input.expected.script);
  const accepted = input.accepted;
  const script = accepted.script === null ? null : opaque(accepted.script);
  if (
    expected.organizationId !== owner.organizationId ||
    expected.product !== owner.product ||
    accepted.principal !== `org:${owner.organizationId}` ||
    accepted.space !== owner.organizationId
  )
    fail("conflict");
  if (
    !["activate", "advance", "retire"].includes(action) ||
    expected.generation >= Number.MAX_SAFE_INTEGER - 1 ||
    input.expected.releasedAt !== null ||
    (action === "activate"
      ? state !== "reserved" || previousScript !== null
      : state !== "active" || previousScript === null) ||
    (action === "retire" ? script !== null : script === null)
  )
    fail("invalid_argument");
  return Object.freeze({
    ...owner,
    environment,
    reservationId: expected.reservationId,
    name: expected.name,
    action,
    incarnation: expected.incarnation,
    expectedGeneration: expected.generation,
    expectedState: state as "reserved" | "active",
    expectedScript: previousScript,
    acceptedScript: script,
    commandRef: opaque(input.commandRef),
    endpointUid: opaque(accepted.endpointUid),
    endpointGeneration: routeGeneration(accepted.endpointGeneration),
    workerUid: opaque(accepted.workerUid),
    deploymentUid: opaque(accepted.deploymentUid),
    deploymentGeneration: routeGeneration(accepted.deploymentGeneration),
    sourceOperationId: opaque(accepted.sourceOperationId),
    providerId: opaque(accepted.providerId),
    targetKey: routeTargetKey(accepted.targetKey),
  });
}

function routeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER)
    fail("invalid_argument");
  return value;
}

function routeTargetKey(value: unknown): string {
  // Preserve the existing v2 owner token contract exactly; qualified target keys are not legacy128 IDs.
  if (typeof value !== "string" || value.length === 0 || value.length > 255)
    fail("invalid_argument");
  return value;
}

function captureRouteOriginal(
  command: SharedAppRouteOriginal,
  owner: TrustedSharedAppOwner,
  environment: SharedAppEnvironment,
): SharedAppRouteOriginal {
  return routeOriginal(
    command.action,
    {
      commandRef: command.commandRef,
      expected: {
        ...command,
        generation: command.expectedGeneration,
        state: command.expectedState,
        script: command.expectedScript,
        releasedAt: null,
      },
      accepted: {
        principal: `org:${command.organizationId}`,
        space: command.organizationId,
        endpointUid: command.endpointUid,
        endpointGeneration: command.endpointGeneration,
        workerUid: command.workerUid,
        deploymentUid: command.deploymentUid,
        deploymentGeneration: command.deploymentGeneration,
        sourceOperationId: command.sourceOperationId,
        providerId: command.providerId,
        targetKey: command.targetKey,
        script: command.acceptedScript,
      },
    },
    owner,
    environment,
  );
}

function sameRouteOriginal(left: SharedAppRouteOriginal, right: SharedAppRouteOriginal): boolean {
  return (
    left.environment === right.environment &&
    ROUTE_COLUMNS.every(([key]) => left[key] === right[key])
  );
}

function routeReceipt(row: Row, environment: SharedAppEnvironment): SharedAppRouteReceipt {
  if (row.form_v2_original_json != null) fail("unavailable");
  try {
    const raw: Record<string, unknown> = { environment };
    for (const [key, column] of ROUTE_COLUMNS) raw[key] = row[column];
    const owner = {
      organizationId: opaque(row.organization_id),
      product: productValue(row.product),
    };
    const original = captureRouteOriginal(
      raw as unknown as SharedAppRouteOriginal,
      owner,
      environment,
    );
    const state = original.action === "retire" ? "reserved" : "active";
    if (
      row.next_generation !== original.expectedGeneration + 1 ||
      row.next_state !== state ||
      !Number.isSafeInteger(row.created_at) ||
      Number(row.created_at) < 0
    )
      fail("unavailable");
    return Object.freeze({
      original,
      assignment: Object.freeze({
        environment,
        organizationId: original.organizationId,
        product: original.product,
        reservationId: original.reservationId,
        name: original.name,
        incarnation: original.incarnation,
        generation: original.expectedGeneration + 1,
        state,
        script: original.acceptedScript,
        releasedAt: null,
      }),
    });
  } catch {
    return fail("unavailable");
  }
}

const FORM_V2_ROUTE_KIND = "form-v2@1";
const FORM_V2_RAW_BYTES = 65_536;
const D1_STRING_ROW_BYTES = 2_000_000;
const D1_SQL_BYTES = 100_000;
const FORM_V2_OPERATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORM_V2_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FORM_V2_PIN_KEYS = [
  "environment",
  "name",
  "organizationId",
  "product",
  "reservationId",
  "incarnation",
  "generation",
] as const;
const FORM_V2_INPUT_KEYS = [
  "commandRef",
  "principal",
  "space",
  "expected",
  "accepted",
  "endpointBinding",
  "priorBinding",
  "nextBinding",
  "nativeBefore",
  "nativeAfter",
] as const;

/** Only bounded, own data properties enter a canonical typed original. */
function formRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_argument");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) fail("invalid_argument");
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("invalid_argument");
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function formRouteKind(value: unknown): "scalar" | "form-v2@1" {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_argument");
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    (descriptor.value !== "scalar" && descriptor.value !== FORM_V2_ROUTE_KIND)
  )
    fail("invalid_argument");
  return descriptor.value;
}

function formArray(value: unknown, maximum: number, minimum = 0): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail("invalid_argument");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("invalid_argument");
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}

function formText(value: unknown, maximum = D1_STRING_ROW_BYTES): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    new TextEncoder().encode(value).byteLength > D1_STRING_ROW_BYTES
  )
    fail("invalid_argument");
  return value;
}

function formUid(value: unknown): string {
  const text = formText(value, 128);
  if (!FORM_V2_UID.test(text)) fail("invalid_argument");
  return text;
}

function formOperation(value: unknown): string {
  const text = formText(value, 36);
  if (!FORM_V2_OPERATION.test(text)) fail("invalid_argument");
  return text;
}

function formGeneration(value: unknown): number {
  if (typeof value !== "number") fail("invalid_argument");
  return routeGeneration(value);
}

function formPinFields(
  value: Readonly<Record<string, unknown>>,
  environment: SharedAppEnvironment,
): SharedAppPin {
  const name = normalize(value.name);
  if (
    value.name !== name ||
    value.environment !== environment ||
    typeof value.incarnation !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.incarnation)
  )
    fail("invalid_argument");
  return Object.freeze({
    environment,
    name,
    organizationId: opaque(value.organizationId),
    product: productValue(value.product),
    reservationId: opaque(value.reservationId),
    incarnation: value.incarnation,
    generation: formGeneration(value.generation),
  });
}

function formPin(value: unknown, environment: SharedAppEnvironment): SharedAppPin {
  return formPinFields(formRecord(value, FORM_V2_PIN_KEYS), environment);
}

function formNativeRow(value: unknown): SharedAppNativeRouteRowPin {
  const row = formRecord(value, [
    "providerId",
    "routeKind",
    "routeKey",
    "ownerNativeId",
    "generation",
    "operationId",
    "state",
    "valueJson",
  ]);
  if (
    (row.routeKind !== "host" && row.routeKind !== "worker") ||
    (row.state !== "active" && row.state !== "tombstone")
  )
    fail("invalid_argument");
  const valueJson = formText(row.valueJson);
  if (new TextEncoder().encode(valueJson).byteLength > FORM_V2_RAW_BYTES) fail("invalid_argument");
  // Generic JSON validity only. The actual native owner validates its grammar;
  // its raw bytes are never normalized or turned into a public compiler here.
  let nativeValue: unknown;
  try {
    nativeValue = JSON.parse(valueJson);
  } catch {
    return fail("invalid_argument");
  }
  if (nativeValue === null || typeof nativeValue !== "object" || Array.isArray(nativeValue))
    fail("invalid_argument");
  return Object.freeze({
    providerId: formText(row.providerId),
    routeKind: row.routeKind,
    routeKey: formText(row.routeKey, row.routeKind === "host" ? 261 : 138),
    ownerNativeId: formText(row.ownerNativeId, 138),
    generation: formGeneration(row.generation),
    operationId: formText(row.operationId, row.routeKind === "host" ? 298 : 46),
    state: row.state,
    valueJson,
  });
}

function formBinding(value: unknown): SharedAppFormV2Binding {
  const input = formRecord(value, [
    "kind",
    "endpoint",
    "workerUid",
    "deployment",
    "providerId",
    "targetKey",
    "nativeSourceOperationId",
    "hostRow",
    "workerRow",
    "releases",
  ]);
  if (input.kind !== FORM_V2_ROUTE_KIND) fail("invalid_argument");
  const endpoint = formRecord(input.endpoint, ["uid", "generation"]);
  const deployment = formRecord(input.deployment, ["uid", "generation"]);
  const providerId = formText(input.providerId);
  const hostRow = formNativeRow(input.hostRow);
  const workerRow = formNativeRow(input.workerRow);
  if (
    hostRow.routeKind !== "host" ||
    workerRow.routeKind !== "worker" ||
    hostRow.state !== "active" ||
    workerRow.state !== "active" ||
    hostRow.providerId !== providerId ||
    workerRow.providerId !== providerId ||
    hostRow.ownerNativeId !== workerRow.ownerNativeId
  )
    fail("invalid_argument");
  const releases: SharedAppFormV2ReleasePin[] = [];
  let prior = "";
  let total = 0;
  for (const value of formArray(input.releases, 8, 1)) {
    const release = formRecord(value, [
      "versionUid",
      "versionGeneration",
      "scriptName",
      "weight",
      "descriptorDigest",
      "providerEtag",
    ]);
    const versionUid = formUid(release.versionUid);
    if (
      versionUid <= prior ||
      typeof release.weight !== "number" ||
      !Number.isSafeInteger(release.weight) ||
      release.weight < 1 ||
      release.weight > 10_000 ||
      !isSha256Digest(release.descriptorDigest)
    )
      fail("invalid_argument");
    total += release.weight;
    prior = versionUid;
    releases.push(
      Object.freeze({
        versionUid,
        versionGeneration: formGeneration(release.versionGeneration),
        scriptName: formText(release.scriptName, 255),
        weight: release.weight,
        descriptorDigest: release.descriptorDigest,
        providerEtag: formText(release.providerEtag, 255),
      }),
    );
  }
  if (total !== 10_000) fail("invalid_argument");
  return Object.freeze({
    kind: FORM_V2_ROUTE_KIND,
    endpoint: Object.freeze({
      uid: formUid(endpoint.uid),
      generation: formGeneration(endpoint.generation),
    }),
    workerUid: formUid(input.workerUid),
    deployment: Object.freeze({
      uid: formUid(deployment.uid),
      generation: formGeneration(deployment.generation),
    }),
    providerId,
    targetKey: formText(input.targetKey, 255),
    nativeSourceOperationId: formOperation(input.nativeSourceOperationId),
    hostRow,
    workerRow,
    releases: Object.freeze(releases),
  });
}

function formRouteAssignment(
  value: unknown,
  environment: SharedAppEnvironment,
): SharedAppRouteAssignment {
  if (formRouteKind(value) === "scalar") {
    const input = formRecord(value, ["kind", "value"]);
    const scalar = formRecord(input.value, [...FORM_V2_PIN_KEYS, "state", "script", "releasedAt"]);
    const selected = formPinFields(scalar, environment);
    if (
      (scalar.state !== "reserved" && scalar.state !== "active" && scalar.state !== "released") ||
      (scalar.script !== null && typeof scalar.script !== "string") ||
      (scalar.state === "reserved" && scalar.script !== null) ||
      (scalar.state === "active" && scalar.script === null) ||
      (scalar.releasedAt !== null &&
        (typeof scalar.releasedAt !== "number" ||
          !Number.isSafeInteger(scalar.releasedAt) ||
          scalar.releasedAt < 0)) ||
      (scalar.state === "released") !== (scalar.releasedAt !== null)
    )
      fail("invalid_argument");
    return Object.freeze({
      kind: "scalar",
      value: Object.freeze({
        ...selected,
        state: scalar.state,
        script: scalar.script === null ? null : opaque(scalar.script),
        releasedAt: scalar.releasedAt,
      }),
    });
  }
  const input = formRecord(value, ["kind", "pin", "state", "releasedAt", "binding"]);
  if (input.kind !== FORM_V2_ROUTE_KIND) fail("invalid_argument");
  const selected = formPin(input.pin, environment);
  if (input.state === "active" && input.releasedAt === null)
    return Object.freeze({
      kind: FORM_V2_ROUTE_KIND,
      pin: selected,
      state: "active",
      releasedAt: null,
      binding: formBinding(input.binding),
    });
  if (input.binding !== null) fail("invalid_argument");
  if (input.state === "reserved" && input.releasedAt === null)
    return Object.freeze({
      kind: FORM_V2_ROUTE_KIND,
      pin: selected,
      state: "reserved",
      releasedAt: null,
      binding: null,
    });
  if (
    input.state === "released" &&
    typeof input.releasedAt === "number" &&
    Number.isSafeInteger(input.releasedAt) &&
    input.releasedAt >= 0
  )
    return Object.freeze({
      kind: FORM_V2_ROUTE_KIND,
      pin: selected,
      state: "released",
      releasedAt: input.releasedAt,
      binding: null,
    });
  return fail("invalid_argument");
}

function formAssignmentPin(value: SharedAppRouteAssignment): SharedAppPin {
  return value.kind === "scalar" ? value.value : value.pin;
}

function formAssignmentState(value: SharedAppRouteAssignment): "reserved" | "active" | "released" {
  return value.kind === "scalar" ? value.value.state : value.state;
}

function formSame(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function formAssignmentRow(row: Row, environment: SharedAppEnvironment): SharedAppRouteAssignment {
  try {
    if (row.binding_kind == null) {
      if (row.binding_json != null) fail("unavailable");
      return Object.freeze({ kind: "scalar", value: assignment(row, environment) });
    }
    if (row.binding_kind !== FORM_V2_ROUTE_KIND || row.script !== null) fail("unavailable");
    const value = formRouteAssignment(
      {
        kind: FORM_V2_ROUTE_KIND,
        pin: {
          environment,
          name: row.name,
          organizationId: row.organization_id,
          product: row.product,
          reservationId: row.reservation_id,
          incarnation: row.incarnation,
          generation: row.generation,
        },
        state: row.state,
        releasedAt: row.released_at,
        binding: row.binding_json === null ? null : JSON.parse(formText(row.binding_json)),
      },
      environment,
    );
    if (value.kind !== FORM_V2_ROUTE_KIND) fail("unavailable");
    if (row.binding_json !== (value.binding === null ? null : canonicalJson(value.binding)))
      fail("unavailable");
    return value;
  } catch {
    return fail("unavailable");
  }
}

function formSnapshots(value: unknown): readonly SharedAppNativeRouteSnapshot[] {
  const snapshots: SharedAppNativeRouteSnapshot[] = [];
  let prior = "";
  for (const entry of formArray(value, 3, 1)) {
    const input = formRecord(entry, ["providerId", "routeKind", "routeKey", "row"]);
    if (input.routeKind !== "host" && input.routeKind !== "worker") fail("invalid_argument");
    const providerId = formText(input.providerId);
    const routeKey = formText(input.routeKey, input.routeKind === "host" ? 261 : 138);
    const key = `${input.routeKind}\u0000${routeKey}`;
    const row = input.row === null ? null : formNativeRow(input.row);
    if (
      key <= prior ||
      (row &&
        (row.providerId !== providerId ||
          row.routeKind !== input.routeKind ||
          row.routeKey !== routeKey))
    )
      fail("invalid_argument");
    prior = key;
    snapshots.push(Object.freeze({ providerId, routeKind: input.routeKind, routeKey, row }));
  }
  return Object.freeze(snapshots);
}

function formBindingInSnapshots(
  binding: SharedAppFormV2Binding,
  snapshots: readonly SharedAppNativeRouteSnapshot[],
): boolean {
  return [binding.hostRow, binding.workerRow].every((row) =>
    snapshots.some(
      (snapshot) =>
        snapshot.providerId === row.providerId &&
        snapshot.routeKind === row.routeKind &&
        snapshot.routeKey === row.routeKey &&
        formSame(snapshot.row, row),
    ),
  );
}

function formAccepted(value: unknown): SharedAppFormV2AcceptedCommand {
  const input = formRecord(value, [
    "kind",
    "action",
    "resourceUid",
    "generation",
    "operationId",
    "formUrl",
    "backendId",
    "targetKey",
  ]);
  if (
    (input.kind !== "endpoint" && input.kind !== "deployment") ||
    (input.action !== "create" && input.action !== "update" && input.action !== "delete")
  )
    fail("invalid_argument");
  return Object.freeze({
    kind: input.kind,
    action: input.action,
    resourceUid: formUid(input.resourceUid),
    generation: formGeneration(input.generation),
    operationId: formOperation(input.operationId),
    formUrl: formText(input.formUrl),
    backendId: formText(input.backendId),
    targetKey: formText(input.targetKey, 255),
  });
}

function formEndpointBinding(value: unknown): SharedAppFormV2EndpointBindingPin {
  const input = formRecord(value, [
    "incarnation",
    "organizationId",
    "product",
    "reservationId",
    "name",
    "endpointUid",
    "endpointGeneration",
    "formUrl",
    "backendId",
    "targetKey",
    "createOperationId",
    "currentOperationId",
  ]);
  if (typeof input.incarnation !== "string" || !/^[0-9a-f]{32}$/u.test(input.incarnation))
    fail("invalid_argument");
  const name = normalize(input.name);
  if (name !== input.name) fail("invalid_argument");
  return Object.freeze({
    incarnation: input.incarnation,
    organizationId: opaque(input.organizationId),
    product: productValue(input.product),
    reservationId: opaque(input.reservationId),
    name,
    endpointUid: formUid(input.endpointUid),
    endpointGeneration: formGeneration(input.endpointGeneration),
    formUrl: formText(input.formUrl),
    backendId: formText(input.backendId),
    targetKey: formText(input.targetKey, 255),
    createOperationId: formOperation(input.createOperationId),
    currentOperationId: formOperation(input.currentOperationId),
  });
}

function formOriginal(
  action: unknown,
  value: unknown,
  owner: TrustedSharedAppOwner,
  environment: SharedAppEnvironment,
): SharedAppFormV2RouteOriginal {
  if (action !== "activate" && action !== "advance" && action !== "retire")
    fail("invalid_argument");
  const input = formRecord(value, FORM_V2_INPUT_KEYS);
  const expected = formRouteAssignment(input.expected, environment);
  const selected = formAssignmentPin(expected);
  const state = formAssignmentState(expected);
  const principal = formText(input.principal);
  const space = formText(input.space);
  if (
    selected.organizationId !== owner.organizationId ||
    selected.product !== owner.product ||
    principal !== `org:${owner.organizationId}` ||
    space !== owner.organizationId
  )
    fail("conflict");
  if (
    selected.generation >= Number.MAX_SAFE_INTEGER - 1 ||
    state === "released" ||
    (action === "activate" ? state !== "reserved" : state !== "active")
  )
    fail("invalid_argument");
  const accepted = formAccepted(input.accepted);
  const endpointBinding = formEndpointBinding(input.endpointBinding);
  const priorBinding = input.priorBinding === null ? null : formBinding(input.priorBinding);
  const nextBinding = input.nextBinding === null ? null : formBinding(input.nextBinding);
  const nativeBefore = formSnapshots(input.nativeBefore);
  const nativeAfter = formSnapshots(input.nativeAfter);
  const binding = nextBinding ?? priorBinding;
  if (
    !binding ||
    endpointBinding.organizationId !== owner.organizationId ||
    endpointBinding.product !== owner.product ||
    endpointBinding.incarnation !== selected.incarnation ||
    endpointBinding.reservationId !== selected.reservationId ||
    endpointBinding.name !== selected.name ||
    endpointBinding.targetKey !== accepted.targetKey ||
    binding.targetKey !== accepted.targetKey ||
    (accepted.kind === "endpoint" && accepted.resourceUid !== endpointBinding.endpointUid) ||
    (accepted.kind === "deployment" && accepted.resourceUid !== binding.deployment.uid) ||
    (state === "active" ? priorBinding === null : priorBinding !== null) ||
    (action === "retire" ? nextBinding !== null : nextBinding === null) ||
    (priorBinding &&
      (priorBinding.endpoint.uid !== endpointBinding.endpointUid ||
        !formBindingInSnapshots(priorBinding, nativeBefore))) ||
    (nextBinding &&
      (nextBinding.endpoint.uid !== endpointBinding.endpointUid ||
        nextBinding.endpoint.generation !== endpointBinding.endpointGeneration ||
        !formBindingInSnapshots(nextBinding, nativeAfter))) ||
    nativeBefore.length !== nativeAfter.length ||
    nativeBefore.some((row, index) => {
      const after = nativeAfter[index];
      return (
        !after ||
        row.providerId !== binding.providerId ||
        after.providerId !== binding.providerId ||
        row.routeKind !== after.routeKind ||
        row.routeKey !== after.routeKey
      );
    })
  )
    fail("invalid_argument");
  if (
    expected.kind === FORM_V2_ROUTE_KIND &&
    expected.state === "active" &&
    !formSame(expected.binding, priorBinding)
  )
    fail("conflict");
  if (
    expected.kind === "scalar" &&
    state === "active" &&
    (priorBinding?.releases.length !== 1 ||
      priorBinding.releases[0]?.scriptName !== expected.value.script)
  )
    fail("conflict");
  // The accepted binding and last confirmed native binding have independent
  // generations, including repeated failed-none DELETE. Actual authority is
  // supplied by the fixed receiver's row/history/accepted-operation predicates.
  const original: SharedAppFormV2RouteOriginal = Object.freeze({
    ...owner,
    environment,
    action,
    commandRef: formText(input.commandRef, 298),
    principal,
    space,
    expected,
    accepted,
    endpointBinding,
    priorBinding,
    nextBinding,
    nativeBefore,
    nativeAfter,
  });
  formJson(original);
  return original;
}

function captureFormOriginal(
  value: unknown,
  owner: TrustedSharedAppOwner,
  environment: SharedAppEnvironment,
): SharedAppFormV2RouteOriginal {
  const input = formRecord(value, [
    ...FORM_V2_INPUT_KEYS,
    "organizationId",
    "product",
    "environment",
    "action",
  ]);
  if (
    input.organizationId !== owner.organizationId ||
    input.product !== owner.product ||
    input.environment !== environment
  )
    fail("conflict");
  const fields: Record<string, unknown> = {};
  for (const key of FORM_V2_INPUT_KEYS) fields[key] = input[key];
  return formOriginal(input.action, fields, owner, environment);
}

function formJson(value: unknown): string {
  const json = canonicalJson(value);
  if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > D1_STRING_ROW_BYTES)
    fail("invalid_argument");
  return json;
}

function formNextAssignment(
  original: SharedAppFormV2RouteOriginal,
): SharedAppFormV2RouteAssignment {
  const selected = pin(formAssignmentPin(original.expected));
  const nextPin = Object.freeze({ ...selected, generation: selected.generation + 1 });
  if (original.action === "retire")
    return Object.freeze({
      kind: FORM_V2_ROUTE_KIND,
      pin: nextPin,
      state: "reserved",
      releasedAt: null,
      binding: null,
    });
  if (!original.nextBinding) return fail("invalid_argument");
  return Object.freeze({
    kind: FORM_V2_ROUTE_KIND,
    pin: nextPin,
    state: "active",
    releasedAt: null,
    binding: original.nextBinding,
  });
}

function formHistoryFields(original: SharedAppFormV2RouteOriginal): readonly SqlParam[] {
  const selected = formAssignmentPin(original.expected);
  const binding = original.nextBinding ?? original.priorBinding;
  if (!binding) return fail("invalid_argument");
  const values: readonly SqlParam[] = [
    original.organizationId,
    original.product,
    selected.reservationId,
    selected.name,
    selected.incarnation,
    original.action,
    original.commandRef,
    selected.generation,
    formAssignmentState(original.expected),
    original.expected.kind === "scalar" ? original.expected.value.script : null,
    null,
    original.endpointBinding.endpointUid,
    original.accepted.kind === "endpoint"
      ? original.accepted.generation
      : original.endpointBinding.endpointGeneration,
    binding.workerUid,
    binding.deployment.uid,
    binding.deployment.generation,
    original.accepted.operationId,
    binding.providerId,
    binding.targetKey,
    formJson(original),
    selected.generation + 1,
    original.action === "retire" ? "reserved" : "active",
  ];
  // Actual history-row bytes, including common fields and the full original.
  // Reserve eight bytes per numeric field and the separately captured created_at.
  const bytes = values.reduce<number>(
    (total, value) =>
      total +
      (typeof value === "string"
        ? new TextEncoder().encode(value).byteLength
        : typeof value === "number"
          ? 8
          : 0),
    8,
  );
  if (bytes > D1_STRING_ROW_BYTES) fail("invalid_argument");
  return Object.freeze(values);
}

function formReceipt(row: Row, environment: SharedAppEnvironment): SharedAppFormV2RouteReceipt {
  if (row.form_v2_original_json == null) {
    routeReceipt(row, environment);
    return fail("conflict");
  }
  try {
    const owner = {
      organizationId: opaque(row.organization_id),
      product: productValue(row.product),
    };
    const raw = formText(row.form_v2_original_json);
    const original = captureFormOriginal(JSON.parse(raw), owner, environment);
    if (formJson(original) !== raw) fail("unavailable");
    const columns = [
      ...ROUTE_COLUMNS.map(([, column]) => column),
      "form_v2_original_json",
      "next_generation",
      "next_state",
    ];
    const values = formHistoryFields(original);
    if (
      columns.some((column, index) => row[column] !== values[index]) ||
      typeof row.created_at !== "number" ||
      !Number.isSafeInteger(row.created_at) ||
      row.created_at < 0
    )
      fail("unavailable");
    return Object.freeze({ original, assignment: formNextAssignment(original) });
  } catch {
    return fail("unavailable");
  }
}

function formSelection(value: unknown, environment: SharedAppEnvironment): SharedAppRouteSelection {
  if (formRouteKind(value) === "scalar") {
    const input = formRecord(value, ["kind", "value"]);
    const scalar = formRecord(input.value, [...FORM_V2_PIN_KEYS, "script"]);
    return Object.freeze({
      kind: "scalar",
      value: Object.freeze({
        ...formPinFields(scalar, environment),
        script: opaque(scalar.script),
      }),
    });
  }
  const input = formRecord(value, ["kind", "pin", "binding"]);
  if (input.kind !== FORM_V2_ROUTE_KIND) return fail("invalid_argument");
  return Object.freeze({
    kind: FORM_V2_ROUTE_KIND,
    pin: formPin(input.pin, environment),
    binding: formBinding(input.binding),
  });
}

function formStatement(sql: string, params: readonly SqlParam[]): SqlStatement {
  if (params.length > 90 || new TextEncoder().encode(sql).byteLength > D1_SQL_BYTES)
    fail("invalid_argument");
  for (const value of params) {
    if (
      value !== null &&
      typeof value !== "string" &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      fail("invalid_argument");
    if (
      typeof value === "string" &&
      new TextEncoder().encode(value).byteLength > D1_STRING_ROW_BYTES
    )
      fail("invalid_argument");
  }
  return Object.freeze({ sql, params: Object.freeze([...params]) });
}

function formEffects(
  command: SharedAppFormV2RouteOriginal,
  inputGuards: TrustedSharedAppRouteGuards,
  now: number,
): SharedAppFormV2RouteEffects {
  const captureGuard = (value: unknown): SqlStatement => {
    const guard = formRecord(value, ["sql", "params"]);
    const sql = formText(guard.sql);
    if (!sql.trim()) return fail("invalid_argument");
    const params = formArray(guard.params, 90).map((value): SqlParam => {
      if (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        return value;
      return fail("invalid_argument");
    });
    return formStatement(sql, params);
  };
  // Capture both predicates before invoking any caller-owned asynchronous port.
  const guards = formRecord(inputGuards, ["admission", "publication"]);
  const admission = captureGuard(formRecord(guards.admission, ["sql", "params"]));
  const publication = captureGuard(formRecord(guards.publication, ["sql", "params"]));
  const prefix = command.environment === "staging" ? "shared_app_staging" : "shared_app_production";
  const names = `${prefix}_names`;
  const assignments = `${prefix}_assignments`;
  const history = `${prefix}_route_commands`;
  const assertions = `${prefix}_batch_assertions`;
  const selected = formAssignmentPin(command.expected);
  const state = formAssignmentState(command.expected);
  const previousScript = command.expected.kind === "scalar" ? command.expected.value.script : null;
  const previousKind = command.expected.kind === "scalar" ? null : FORM_V2_ROUTE_KIND;
  const previousBinding =
    command.expected.kind === FORM_V2_ROUTE_KIND && command.expected.binding !== null
      ? formJson(command.expected.binding)
      : null;
  const next = formNextAssignment(command);
  const nextBinding = next.binding === null ? null : formJson(next.binding);
  const witness = crypto.randomUUID().replaceAll("-", "");
  const historyColumns = [
    ...ROUTE_COLUMNS.map(([, column]) => column),
    "form_v2_original_json",
    "next_generation",
    "next_state",
  ];
  const historyParams = formHistoryFields(command);
  const sameHistory = `EXISTS (SELECT 1 FROM ${history} h WHERE ${historyColumns.map((column) => `h.${column} IS ?`).join(" AND ")})`;
  const originalKey = `SELECT 1 FROM ${history} WHERE organization_id = ? AND command_ref = ?`;
  const ownerParams = [command.organizationId, command.commandRef];
  const tuple = (
    generation: number,
    tupleState: string,
    script: string | null,
    kind: string | null,
    binding: string | null,
    joinName: boolean,
  ): SqlStatement =>
    formStatement(
      `SELECT 1 FROM ${assignments} a${
        joinName
          ? ` JOIN ${names} n ON n.normalized_name = a.name
      AND n.incarnation = a.incarnation AND n.generation = a.generation AND n.state = a.state
      AND n.released_at IS NULL`
          : ""
      }
      WHERE a.organization_id = ? AND a.product = ? AND a.reservation_id = ? AND a.name = ?
        AND a.incarnation = ? AND a.generation = ? AND a.state = ? AND a.script IS ?
        AND a.binding_kind IS ? AND a.binding_json IS ? AND a.released_at IS NULL`,
      [
        command.organizationId,
        command.product,
        selected.reservationId,
        selected.name,
        selected.incarnation,
        generation,
        tupleState,
        script,
        kind,
        binding,
      ],
    );
  const prior = tuple(
    selected.generation,
    state,
    previousScript,
    previousKind,
    previousBinding,
    true,
  );
  const afterAssignment = tuple(
    next.pin.generation,
    next.state,
    null,
    FORM_V2_ROUTE_KIND,
    nextBinding,
    false,
  );
  const afterTuple = tuple(
    next.pin.generation,
    next.state,
    null,
    FORM_V2_ROUTE_KIND,
    nextBinding,
    true,
  );
  const activeBinding = command.priorBinding;
  let priorHistory: SqlStatement;
  if (state === "reserved" && selected.generation === 1) {
    priorHistory = formStatement(`NOT EXISTS (SELECT 1 FROM ${history} WHERE incarnation = ?)`, [
      selected.incarnation,
    ]);
  } else {
    const params: SqlParam[] = [
      command.organizationId,
      command.product,
      selected.reservationId,
      selected.name,
      selected.incarnation,
      selected.generation,
      state,
    ];
    let variant: string;
    if (command.expected.kind === "scalar") {
      variant = "h.form_v2_original_json IS NULL AND h.next_script IS ?";
      params.push(previousScript);
      if (state === "active" && activeBinding) {
        variant += ` AND h.endpoint_uid = ? AND h.endpoint_generation = ? AND h.worker_uid = ?
          AND h.deployment_uid = ? AND h.deployment_generation = ? AND h.provider_id = ? AND h.target_key = ?`;
        params.push(
          activeBinding.endpoint.uid,
          activeBinding.endpoint.generation,
          activeBinding.workerUid,
          activeBinding.deployment.uid,
          activeBinding.deployment.generation,
          activeBinding.providerId,
          activeBinding.targetKey,
        );
      }
    } else {
      variant = `h.form_v2_original_json IS NOT NULL AND json_valid(h.form_v2_original_json) = 1
        AND h.next_script IS NULL AND json_extract(h.form_v2_original_json, '$.nextBinding') IS ?`;
      params.push(previousBinding);
    }
    priorHistory = formStatement(
      `EXISTS (SELECT 1 FROM ${history} h
      WHERE h.organization_id = ? AND h.product = ? AND h.reservation_id = ? AND h.name = ?
        AND h.incarnation = ? AND h.next_generation = ? AND h.next_state = ? AND (${variant}))`,
      params,
    );
  }
  const fresh = `EXISTS (SELECT 1 FROM ${assertions} WHERE witness = ? AND apply_effects = 1)`;
  const before = [
    formStatement(
      `INSERT INTO ${assertions} (witness, ok, apply_effects)
      SELECT ?, CASE WHEN ${sameHistory} OR (NOT EXISTS (${originalKey})
        AND EXISTS (${prior.sql}) AND (${priorHistory.sql}) AND (${admission.sql})) THEN 1 ELSE 0 END,
        CASE WHEN EXISTS (${originalKey}) THEN 0 ELSE 1 END`,
      [
        witness,
        ...historyParams,
        ...ownerParams,
        ...(prior.params ?? []),
        ...(priorHistory.params ?? []),
        ...(admission.params ?? []),
        ...ownerParams,
      ],
    ),
    formStatement(
      `INSERT INTO ${history} (${historyColumns.join(", ")}, created_at)
      SELECT ${[...historyParams, now].map(() => "?").join(", ")} WHERE ${fresh}`,
      [...historyParams, now, witness],
    ),
    formStatement(
      `UPDATE ${assignments} SET generation = ?, state = ?, script = NULL, binding_kind = ?,
        binding_json = ?, updated_at = ? WHERE incarnation = ? AND EXISTS (${prior.sql}) AND ${fresh}`,
      [
        next.pin.generation,
        next.state,
        FORM_V2_ROUTE_KIND,
        nextBinding,
        now,
        selected.incarnation,
        ...(prior.params ?? []),
        witness,
      ],
    ),
    formStatement(
      `UPDATE ${names} SET generation = ?, state = ?, released_at = NULL, updated_at = ?
      WHERE normalized_name = ? AND incarnation = ? AND generation = ? AND state = ?
        AND EXISTS (${afterAssignment.sql}) AND ${fresh}`,
      [
        next.pin.generation,
        next.state,
        now,
        selected.name,
        selected.incarnation,
        selected.generation,
        state,
        ...(afterAssignment.params ?? []),
        witness,
      ],
    ),
  ];
  const publicationGuard = formStatement(
    `${fresh} AND EXISTS (${afterTuple.sql}) AND EXISTS (${originalKey})`,
    [witness, ...(afterTuple.params ?? []), ...ownerParams],
  );
  const after = [
    formStatement(
      `INSERT INTO ${assertions} (witness, ok, apply_effects)
      SELECT ?, CASE WHEN ${sameHistory} AND EXISTS (SELECT 1 FROM ${assertions}
        WHERE witness = ? AND (apply_effects = 0 OR (apply_effects = 1
          AND EXISTS (${afterTuple.sql}) AND (${publication.sql})))) THEN 1 ELSE 0 END, 0`,
      [
        `${witness}:result`,
        ...historyParams,
        witness,
        ...(afterTuple.params ?? []),
        ...(publication.params ?? []),
      ],
    ),
    formStatement(`DELETE FROM ${assertions} WHERE witness IN (?, ?)`, [
      witness,
      `${witness}:result`,
    ]),
  ];
  return Object.freeze({
    original: command,
    before: Object.freeze(before),
    publicationGuard,
    after: Object.freeze(after),
  });
}

function routeStatement(sql: string, params: readonly SqlParam[]): SqlStatement {
  // Leave room below D1's100 bound-parameter limit; owner composition must also check its full route SQL.
  if (params.length > 90) fail("invalid_argument");
  return Object.freeze({ sql, params: Object.freeze([...params]) });
}

function routeEffects(
  command: SharedAppRouteOriginal,
  inputGuards: TrustedSharedAppRouteGuards,
  now: number,
): SharedAppRouteEffects {
  const captureGuard = (input: TrustedSharedAppRouteGuards["admission"]): SqlStatement => {
    const sql = input.sql;
    if (typeof sql !== "string" || sql.trim().length === 0) fail("invalid_argument");
    const params = input.params.map((value) => {
      if (
        value !== null &&
        typeof value !== "string" &&
        (typeof value !== "number" || !Number.isFinite(value))
      )
        fail("invalid_argument");
      return value;
    });
    return routeStatement(sql, params);
  };
  const admission = captureGuard(inputGuards.admission);
  const publication = captureGuard(inputGuards.publication);
  // Literal table selection only. No public environment/table identifier is interpolated.
  const prefix = command.environment === "staging" ? "shared_app_staging" : "shared_app_production";
  const names = `${prefix}_names`;
  const assignments = `${prefix}_assignments`;
  const history = `${prefix}_route_commands`;
  const assertions = `${prefix}_batch_assertions`;
  const witness = crypto.randomUUID().replaceAll("-", "");
  const nextGeneration = command.expectedGeneration + 1;
  const nextState = command.action === "retire" ? "reserved" : "active";
  const historyColumns = [
    ...ROUTE_COLUMNS.map(([, column]) => column),
    "next_generation",
    "next_state",
  ];
  const historyParams: readonly SqlParam[] = [
    ...ROUTE_COLUMNS.map(([key]) => command[key]),
    nextGeneration,
    nextState,
  ];
  const historyMatch = historyColumns.map((column) => `h.${column} IS ?`).join(" AND ");
  const sameHistory = `EXISTS (SELECT 1 FROM ${history} AS h WHERE ${historyMatch})`;
  const originalKey = `SELECT 1 FROM ${history} WHERE organization_id = ? AND command_ref = ?`;
  const ownerParams = [command.organizationId, command.commandRef];
  const tuple = (
    generation: number,
    state: string,
    script: string | null,
    joinName: boolean,
  ): SqlStatement => {
    const join = joinName
      ? ` JOIN ${names} AS n ON n.normalized_name = a.name
      AND n.incarnation = a.incarnation AND n.generation = a.generation AND n.state = a.state
      AND n.released_at IS NULL`
      : "";
    return routeStatement(
      `SELECT 1 FROM ${assignments} AS a${join}
      WHERE a.organization_id = ? AND a.product = ? AND a.reservation_id = ? AND a.name = ?
      AND a.incarnation = ? AND a.generation = ? AND a.state = ? AND a.script IS ? AND a.released_at IS NULL`,
      [
        command.organizationId,
        command.product,
        command.reservationId,
        command.name,
        command.incarnation,
        generation,
        state,
        script,
      ],
    );
  };
  const prior = tuple(
    command.expectedGeneration,
    command.expectedState,
    command.expectedScript,
    true,
  );
  const nextAssignment = tuple(nextGeneration, nextState, command.acceptedScript, false);
  const next = tuple(nextGeneration, nextState, command.acceptedScript, true);
  const fresh = `EXISTS (SELECT 1 FROM ${assertions} WHERE witness = ? AND apply_effects = 1)`;
  const before = [
    routeStatement(
      `INSERT INTO ${assertions} (witness, ok, apply_effects)
      SELECT ?, CASE WHEN ${sameHistory} OR (NOT EXISTS (${originalKey})
        AND EXISTS (${prior.sql}) AND (${admission.sql})) THEN 1 ELSE 0 END,
        CASE WHEN EXISTS (${originalKey}) THEN 0 ELSE 1 END`,
      [
        witness,
        ...historyParams,
        ...ownerParams,
        ...(prior.params ?? []),
        ...(admission.params ?? []),
        ...ownerParams,
      ],
    ),
    routeStatement(
      `INSERT INTO ${history} (${historyColumns.join(", ")}, created_at)
      SELECT ${[...historyParams, now].map(() => "?").join(", ")} WHERE ${fresh}`,
      [...historyParams, now, witness],
    ),
    routeStatement(
      `UPDATE ${assignments} SET generation = ?, state = ?, script = ?, updated_at = ?
      WHERE incarnation = ? AND EXISTS (${prior.sql}) AND ${fresh}`,
      [
        nextGeneration,
        nextState,
        command.acceptedScript,
        now,
        command.incarnation,
        ...(prior.params ?? []),
        witness,
      ],
    ),
    routeStatement(
      `UPDATE ${names} SET generation = ?, state = ?, released_at = NULL, updated_at = ?
      WHERE normalized_name = ? AND incarnation = ? AND generation = ? AND state = ?
        AND EXISTS (${nextAssignment.sql}) AND ${fresh}`,
      [
        nextGeneration,
        nextState,
        now,
        command.name,
        command.incarnation,
        command.expectedGeneration,
        command.expectedState,
        ...(nextAssignment.params ?? []),
        witness,
      ],
    ),
  ];
  const publicationGuard = routeStatement(
    `${fresh} AND EXISTS (${next.sql}) AND EXISTS (${originalKey})`,
    [witness, ...(next.params ?? []), ...ownerParams],
  );
  const after = [
    routeStatement(
      `INSERT INTO ${assertions} (witness, ok, apply_effects)
      SELECT ?, CASE WHEN ${sameHistory} AND EXISTS (SELECT 1 FROM ${assertions}
        WHERE witness = ? AND (apply_effects = 0 OR (apply_effects = 1
          AND EXISTS (${next.sql}) AND (${publication.sql})))) THEN 1 ELSE 0 END, 0`,
      [
        `${witness}:result`,
        ...historyParams,
        witness,
        ...(next.params ?? []),
        ...(publication.params ?? []),
      ],
    ),
    routeStatement(`DELETE FROM ${assertions} WHERE witness IN (?, ?)`, [
      witness,
      `${witness}:result`,
    ]),
  ];
  return Object.freeze({
    original: command,
    before: Object.freeze(before),
    publicationGuard,
    after: Object.freeze(after),
  });
}
