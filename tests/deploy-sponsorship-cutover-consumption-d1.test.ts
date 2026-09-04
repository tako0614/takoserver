import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import {
  createSponsorshipCutoverConsumptionDatabase,
  sponsorshipCutoverOperationIdentity,
} from "../scripts/deploy/sponsorship-cutover-consumption.ts";

describe("D1 sponsorship cutover consumption authority", () => {
  test("keeps starts/completions remote, immutable, and single-use across bundle interleaves", async () => {
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "cutover-consumption-test",
            type: "worker",
            compatibilityDate: "2026-08-17",
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: "export default {};" } },
            },
            env: { STATE_DB: { type: "d1", id: "cutover-consumption" } },
            triggers: [],
          },
        },
      ],
    });
    try {
      const d1 = await runtime.getD1Database("STATE_DB");
      const migration = readFileSync(
        resolve(import.meta.dir, "../migrations/0047_sponsorship_cutover_consumption.sql"),
        "utf8",
      );
      const statements = migration.match(/CREATE (?:TABLE[\s\S]*?\n\);|TRIGGER[\s\S]*?\nEND;)/gu);
      if (statements?.length !== 10) throw new Error("migration fixture parse failed");
      for (const statement of statements) await d1.prepare(statement).run();
      const database = createSponsorshipCutoverConsumptionDatabase({
        async query(_phase, _description, sql) {
          const result = await d1.prepare(sql).all<Record<string, unknown>>();
          return result.results;
        },
        async statement(_phase, _description, sql) {
          await d1.prepare(sql).run();
        },
      });
      const base = {
        targetSha256: `sha256:${"1".repeat(64)}`,
        environment: "integration" as const,
        stage: "public-route-removal" as const,
        proofSha256: `sha256:${"2".repeat(64)}`,
        predecessorDeploymentId: "deployment-predecessor",
        predecessorVersionId: "11111111-1111-4111-8111-111111111111",
        predecessorTopologySha256: `sha256:${"3".repeat(64)}`,
        sourceCommit: "a".repeat(40),
        bundleSha256: `sha256:${"4".repeat(64)}`,
        configSha256: `sha256:${"5".repeat(64)}`,
        candidateIdentitySha256: `sha256:${"0".repeat(64)}`,
      };
      const identity = sponsorshipCutoverOperationIdentity(base);
      const start = { ...base, ...identity, startedAt: "2026-09-04T00:03:00.000Z" };
      await expect(
        database.complete({
          operationId: start.operationId,
          successorDeploymentId: "deployment-without-start",
          successorVersionId: "22222222-2222-4222-8222-222222222222",
          completedAt: "2026-09-04T00:03:30.000Z",
        }),
      ).rejects.toBeInstanceOf(Error);
      await expect(database.begin(start)).resolves.toBe("inserted");
      expect(await database.read(base, "preflight")).toEqual({ start, completion: null });

      const interleavedBase = { ...base, bundleSha256: `sha256:${"6".repeat(64)}` };
      const interleaved = sponsorshipCutoverOperationIdentity(interleavedBase);
      await expect(
        database.begin({
          ...interleavedBase,
          ...interleaved,
          startedAt: "2026-09-04T00:03:01.000Z",
        }),
      ).resolves.toBe("existing");

      const completion = {
        operationId: start.operationId,
        successorDeploymentId: "deployment-successor",
        successorVersionId: "22222222-2222-4222-8222-222222222222",
        completedAt: "2026-09-04T00:04:00.000Z",
      };
      await database.complete(completion);
      expect(await database.read(base, "preflight")).toEqual({ start, completion });
      expect(await database.readByOperationId(start.operationId, "preflight")).toEqual({
        start,
        completion,
      });
      await expect(database.begin(start)).resolves.toBe("existing");
      await expect(
        d1.prepare("DELETE FROM sponsorship_cutover_operation_starts").run(),
      ).rejects.toThrow("append-only");
    } finally {
      await runtime.dispose();
    }
  });
});
