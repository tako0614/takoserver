import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { runD1Schema } from "../scripts/deploy/schema.ts";
import {
  type MoneySchemaPhase,
  moneyUnitCutoverExpectedShape,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { workerMoneyUnitSchemaReady, workerSchemaAllowsPending } from "../scripts/deploy/worker.ts";

const source = readMigrationArtifact();
const stageName = `takoserver-i-${"f".repeat(32)}`;
const target: DeployTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration-money",
  publicOrigin: "https://money.integration.example.test",
  d1: { databaseId: "00000000-0000-4000-8000-000000000092", databaseName: stageName },
  r2: { bucketName: stageName },
  signing: { currentKeyId: "current" },
  takoformV2: { config: "{}", storageLineage: "v2-0092" },
  moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
  moneyCutoverWriterEpoch: `sha256:${"d".repeat(64)}`,
};

function state(phase: MoneySchemaPhase) {
  const shape = moneyUnitCutoverExpectedShape(source.files, phase);
  return {
    local: source.names,
    applied: source.names.slice(0, Number(phase.slice(0, 4))),
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
    moneyUnitPolicy: [
      {
        ledger_unit: "usd-micros-v2",
        historical_usage_unit: "microcent-v1",
        cash_unit: "usd-cents-v1",
      },
    ],
  };
}

describe("integration money maintenance publication", () => {
  test("the dedicated maintenance profile accepts exact campaign phases while serving still refuses old units", () => {
    const maintenance = {
      ...target,
      schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced" as const,
    };
    for (const phase of [
      "0092",
      "0092-fenced",
      "0093",
      "0093-fenced",
      "0094",
      "0094-fenced",
    ] as const) {
      const observed = state(phase);
      expect(workerSchemaAllowsPending(maintenance, observed)).toBe(true);
      if (!phase.startsWith("0094")) {
        expect(workerSchemaAllowsPending(target, observed)).toBe(false);
        expect(workerMoneyUnitSchemaReady(observed, `${import.meta.dir}/..`)).toBe(false);
      }
    }
    for (const phase of ["0094", "0094-fenced"] as const) {
      const observed = state(phase);
      expect(workerMoneyUnitSchemaReady(observed, `${import.meta.dir}/..`)).toBe(true);
      expect(workerSchemaAllowsPending(target, observed)).toBe(true);
      const { moneyCutoverWriterEpoch: _epoch, ...withoutEpoch } = target;
      expect(workerSchemaAllowsPending(withoutEpoch, observed)).toBe(false);
      expect(workerSchemaAllowsPending({ ...target, hostedPricing: "{}" }, observed)).toBe(false);
      expect(
        workerSchemaAllowsPending(
          {
            ...target,
            takoformV2: { config: "{}", storageLineage: "v2-0088" },
          },
          observed,
        ),
      ).toBe(false);
    }
    expect(
      workerSchemaAllowsPending({ ...maintenance, environment: "production" }, state("0092")),
    ).toBe(false);
  });

  test("unknown additional trigger or incomplete fence never qualifies a publication", () => {
    const observed = state("0094-fenced");
    const rows = JSON.parse(observed.shape) as {
      type: string;
      name: string;
      table: string;
      sql: string;
    }[];
    const missingFence = rows.filter((row) => row.name !== "money_cutover_fence_ledger_insert");
    const shape = canonicalSchemaShape(
      missingFence.map((row) => ({ ...row, tbl_name: row.table })),
    );
    expect(
      workerMoneyUnitSchemaReady(
        {
          ...observed,
          shape,
          shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
        },
        `${import.meta.dir}/..`,
      ),
    ).toBe(false);
  });

  test("schema selectors cannot fall through into legacy authority or production identity readers", async () => {
    for (const throughMigration of ["0093", "0094"] as const) {
      await expect(
        runD1Schema(
          { action: "apply", environment: "integration", commit: "a".repeat(40), throughMigration },
          target,
          {
            get productionD1(): never {
              throw new Error("production identity was accessed");
            },
            run: async () => {
              throw new Error("provider was accessed without qualification");
            },
          },
        ),
      ).rejects.toThrow("dedicated integration money-unit owner qualification");
      await expect(
        runD1Schema(
          { action: "apply", environment: "production", commit: "a".repeat(40), throughMigration },
          { ...target, environment: "production" },
        ),
      ).rejects.toThrow("dedicated integration money-unit owner qualification");
    }
  });
});
