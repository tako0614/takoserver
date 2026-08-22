import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Typed schema for the on-demand usage authority.
 *
 * SQL migrations remain the deployment lineage. These definitions are the
 * application-side schema used by both D1 and self-host SQLite queries; a
 * schema parity test keeps the two representations from drifting.
 */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    requestId: text("request_id").primaryKey().notNull(),
    organizationId: text("org_id").notNull(),
    resourceUid: text("resource_uid").notNull(),
    meter: text("meter").notNull(),
    quantity: real("quantity").notNull(),
    amountMicros: integer("amount_micros").notNull(),
    createdAt: text("created_at").notNull(),
    rollupId: text("rollup_id"),
  },
  (table) => [index("usage_events_unrolled").on(table.organizationId, table.rollupId)],
);

export const providerMeterCheckpoints = sqliteTable(
  "provider_meter_checkpoints",
  {
    tenantId: text("tenant_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    meterSourceId: text("meter_source_id").notNull(),
    cursorAt: integer("cursor_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.deploymentId, table.meterSourceId] })],
);

export const providerMeterSchedule = sqliteTable(
  "provider_meter_schedule",
  {
    tenantId: text("tenant_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    nextAt: integer("next_at").notNull(),
    leaseUntil: integer("lease_until").notNull(),
    leaseToken: text("lease_token"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.deploymentId] }),
    index("provider_meter_schedule_due").on(
      table.nextAt,
      table.leaseUntil,
      table.tenantId,
      table.deploymentId,
    ),
  ],
);

export const databaseSchema = {
  usageEvents,
  providerMeterCheckpoints,
  providerMeterSchedule,
};
