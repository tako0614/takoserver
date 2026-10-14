import type { Clock, Row, Sql, SqlStatement } from "./ports.ts";
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
    readonly original?: Readonly<
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
