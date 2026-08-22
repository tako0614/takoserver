import { and, eq } from "drizzle-orm";
import type { Catalog } from "./catalog.ts";
import { priceMeteredUsage } from "./catalog.ts";
import { createDatabase, type TakoserverDatabase } from "./database.ts";
import { providerMeterCheckpoints, providerMeterSchedule } from "./database-schema.ts";
import type { Metering } from "./metering.ts";
import type { Clock, Sql } from "./ports.ts";
import type { MeterSource, ProviderPack } from "./provider-pack.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";

export interface ProviderMeteringReport {
  readonly windows: number;
  readonly deferred: number;
  readonly failures: readonly string[];
}

/**
 * Advances provider usage one bounded, idempotent window per active
 * Deployment. External reads occur only after a durable lease is claimed;
 * priced rows are written before the checkpoint advances.
 */
export function createProviderMetering(options: {
  readonly sql: Sql;
  readonly deployments: Pick<ResourceDeploymentStore, "meteringCandidates">;
  readonly catalog: Catalog;
  readonly packs: readonly ProviderPack[];
  readonly metering: Pick<Metering, "recordProviderWindow">;
  readonly clock: Clock;
  readonly randomId?: () => string;
}) {
  const db = createDatabase(options.sql);
  const packs = new Map(options.packs.map((pack) => [pack.id, pack]));
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return {
    async reconcile(limit: number): Promise<ProviderMeteringReport> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("provider metering limit invalid");
      }
      const deployments = await options.deployments.meteringCandidates(limit);
      let windows = 0;
      let deferred = 0;
      const failures: string[] = [];
      for (const deployment of deployments) {
        const now = options.clock().getTime();
        const leaseToken = `meter_${randomId()}`;
        if (!(await claim(options.sql, db, deployment, now, leaseToken))) continue;
        try {
          const pack = packs.get(deployment.providerPackRef);
          const offering = options.catalog.findOffering(deployment.offeringId);
          if (!pack || !offering || offering.providerPackRef !== pack.id) throw new Error();
          if (offering.pricePlan.meters.length === 0) {
            await release(options.sql, deployment, now + 86_400_000, now, leaseToken);
            deferred += 1;
            continue;
          }
          const pricedMeters = new Set(offering.pricePlan.meters.map((meter) => meter.meter));
          const sources = pack.meterSources.filter(
            (source) =>
              source.meters.length > 0 && source.meters.every((meter) => pricedMeters.has(meter)),
          );
          const coveredMeters = new Set(sources.flatMap((source) => source.meters));
          if (
            sources.length === 0 ||
            coveredMeters.size !== pricedMeters.size ||
            [...pricedMeters].some((meter) => !coveredMeters.has(meter))
          ) {
            throw new Error();
          }
          let nextAt = Number.POSITIVE_INFINITY;
          for (const source of sources) {
            const progressed = await reconcileSource({
              ...options,
              db,
              deployment,
              source,
              now,
              pricePlan: offering.pricePlan,
            });
            if (progressed.window) windows += 1;
            else deferred += 1;
            nextAt = Math.min(nextAt, progressed.nextAt);
          }
          await release(options.sql, deployment, nextAt, now, leaseToken);
        } catch {
          failures.push(deployment.id);
          await release(options.sql, deployment, now + 300_000, now, leaseToken);
        }
      }
      return { windows, deferred, failures };
    },
  };
}

async function reconcileSource(input: {
  readonly sql: Sql;
  readonly db: TakoserverDatabase;
  readonly catalog: Catalog;
  readonly metering: Pick<Metering, "recordProviderWindow">;
  readonly deployment: ResourceDeployment;
  readonly source: MeterSource;
  readonly now: number;
  readonly pricePlan: NonNullable<ReturnType<Catalog["findOffering"]>>["pricePlan"];
}): Promise<{ readonly window: boolean; readonly nextAt: number }> {
  const createdAt = Date.parse(input.deployment.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error();
  const rows = await input.db
    .select({ cursorAt: providerMeterCheckpoints.cursorAt })
    .from(providerMeterCheckpoints)
    .where(
      and(
        eq(providerMeterCheckpoints.tenantId, input.deployment.tenantId),
        eq(providerMeterCheckpoints.deploymentId, input.deployment.id),
        eq(providerMeterCheckpoints.meterSourceId, input.source.id),
      ),
    )
    .limit(2);
  if (rows.length > 1) throw new Error();
  const cursor = rows[0]
    ? integer(rows[0].cursorAt)
    : input.source.windowAlignment === "utc-day"
      ? startOfUtcDay(createdAt)
      : createdAt;
  if (
    input.source.retentionSeconds !== undefined &&
    cursor < input.now - input.source.retentionSeconds * 1_000
  ) {
    throw new Error();
  }
  const rawHorizon = input.now - input.source.settlementDelaySeconds * 1_000;
  const horizon =
    input.source.windowAlignment === "utc-day" ? startOfUtcDay(rawHorizon) : rawHorizon;
  if (cursor >= horizon) return { window: false, nextAt: cursor + 300_000 };
  const until = Math.min(horizon, cursor + input.source.maximumWindowSeconds * 1_000);
  const fromText = new Date(cursor).toISOString();
  const untilText = new Date(until).toISOString();
  const usage = validateUsage(
    await input.source.read({
      tenantId: input.deployment.tenantId,
      deployment: input.deployment,
      from: fromText,
      until: untilText,
    }),
    input.source,
  );
  const priced = priceMeteredUsage(input.pricePlan, usage);
  await input.metering.recordProviderWindow({
    organizationId: input.deployment.tenantId,
    resourceUid: input.deployment.resourceUid,
    deploymentId: input.deployment.id,
    meterSourceId: input.source.id,
    from: fromText,
    until: untilText,
    priced,
  });
  await input.db
    .insert(providerMeterCheckpoints)
    .values({
      tenantId: input.deployment.tenantId,
      deploymentId: input.deployment.id,
      meterSourceId: input.source.id,
      cursorAt: cursor,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .run();
  const advanced = await input.sql.run(
    `UPDATE provider_meter_checkpoints SET cursor_at = ?, updated_at = ?
     WHERE tenant_id = ? AND deployment_id = ? AND meter_source_id = ? AND cursor_at = ?`,
    [until, input.now, input.deployment.tenantId, input.deployment.id, input.source.id, cursor],
  );
  if (advanced.changes !== 1) {
    const current = await input.db
      .select({ cursorAt: providerMeterCheckpoints.cursorAt })
      .from(providerMeterCheckpoints)
      .where(
        and(
          eq(providerMeterCheckpoints.tenantId, input.deployment.tenantId),
          eq(providerMeterCheckpoints.deploymentId, input.deployment.id),
          eq(providerMeterCheckpoints.meterSourceId, input.source.id),
        ),
      )
      .limit(2);
    if (current.length !== 1 || integer(current[0]?.cursorAt) < until) throw new Error();
  }
  return { window: true, nextAt: until };
}

async function claim(
  sql: Sql,
  db: TakoserverDatabase,
  deployment: ResourceDeployment,
  now: number,
  leaseToken: string,
): Promise<boolean> {
  await db
    .insert(providerMeterSchedule)
    .values({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      nextAt: Date.parse(deployment.createdAt),
      leaseUntil: 0,
      leaseToken: null,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const claimed = await sql.run(
    `UPDATE provider_meter_schedule SET lease_until = ?, lease_token = ?, updated_at = ?
     WHERE tenant_id = ? AND deployment_id = ? AND lease_until <= ? AND next_at <= ?`,
    [now + 300_000, leaseToken, now, deployment.tenantId, deployment.id, now, now],
  );
  return claimed.changes === 1;
}

async function release(
  sql: Sql,
  deployment: ResourceDeployment,
  nextAt: number,
  now: number,
  leaseToken: string,
): Promise<void> {
  const released = await sql.run(
    `UPDATE provider_meter_schedule
     SET next_at = ?, lease_until = 0, lease_token = NULL, updated_at = ?
     WHERE tenant_id = ? AND deployment_id = ? AND lease_token = ?`,
    [Math.max(0, Math.floor(nextAt)), now, deployment.tenantId, deployment.id, leaseToken],
  );
  if (released.changes > 1) throw new Error("provider_meter_lease_ambiguous");
}

function validateUsage(
  usage: readonly { readonly meter: string; readonly quantity: number }[],
  source: MeterSource,
) {
  if (usage.length > source.meters.length) throw new Error();
  const seen = new Set<string>();
  return usage.map((item) => {
    if (
      !source.meters.includes(item.meter) ||
      seen.has(item.meter) ||
      !Number.isFinite(item.quantity) ||
      item.quantity < 0
    ) {
      throw new Error();
    }
    seen.add(item.meter);
    return { meter: item.meter, quantity: item.quantity };
  });
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
}

function startOfUtcDay(value: number): number {
  return Math.floor(value / 86_400_000) * 86_400_000;
}
