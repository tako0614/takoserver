import type { Clock, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import { normalizeSharedAppName } from "./shared-app-name.ts";

export const SHARED_APP_COOLDOWN_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
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
  };
  readCurrent(name: string): Promise<SharedAppSelection | null>;
  isCurrentBeforeDispatch(selected: SharedAppSelection): Promise<boolean>;
  isCurrentAfterDispatch(selected: SharedAppSelection): Promise<boolean>;
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
      `SELECT a.* FROM ${names} AS n JOIN ${assignments} AS a
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
  return {
    async readCurrent(name) {
      // KV hits AND misses must reach this read. No hint can bypass it.
      return current(normalize(name));
    },
    isCurrentBeforeDispatch: recheck,
    isCurrentAfterDispatch: recheck,
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
          const cutoff = now - SHARED_APP_COOLDOWN_MILLISECONDS;
          try {
            await primary().batch([
              {
                sql: `INSERT INTO ${assignments}
                    (incarnation, name, organization_id, product, reservation_id, generation,
                     state, script, released_at, created_at, updated_at)
                  SELECT ?, ?, ?, ?, ?, COALESCE((SELECT generation FROM ${names}
                      WHERE normalized_name = ?), 0) + 1, 'reserved', NULL, NULL, ?, ?
                  WHERE NOT EXISTS (SELECT 1 FROM ${assignments}
                    WHERE organization_id = ? AND reservation_id = ?)
                    AND NOT EXISTS (SELECT 1 FROM ${names} WHERE normalized_name = ?
                      AND (state <> 'released' OR released_at IS NULL OR released_at > ?))`,
                params: [
                  incarnation,
                  command.name,
                  owner.organizationId,
                  owner.product,
                  command.reservationId,
                  command.name,
                  now,
                  now,
                  owner.organizationId,
                  command.reservationId,
                  command.name,
                  cutoff,
                ],
              },
              {
                sql: `INSERT INTO ${names} (normalized_name, incarnation, generation, state, released_at, updated_at)
                  SELECT name, incarnation, generation, state, NULL, updated_at FROM ${assignments}
                    WHERE incarnation = ?
                  ON CONFLICT(normalized_name) DO UPDATE SET incarnation = excluded.incarnation,
                    generation = excluded.generation, state = excluded.state, released_at = NULL,
                    updated_at = excluded.updated_at
                  WHERE ${names}.state = 'released' AND ${names}.released_at <= ?
                    AND ${names}.generation + 1 = excluded.generation`,
                params: [incarnation, cutoff],
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
    targetKey: opaque(accepted.targetKey),
  });
}

function routeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER)
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
