import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createSelfhostComposition } from "../src/selfhost-composition.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * Released provider Forms remain installed behind the Provider Pack only to
 * drain already-recorded Deployments. They are not a current product catalog:
 * stable S3 is a Host-owned standard service and no current ObjectBucket or
 * edge.objects identity may regain sale/provision authority here.
 */

const runtime: WorkerdRuntime = {
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};

async function compose(edgeForms: boolean) {
  return createSelfhostComposition({
    edge: await buildEdgeForms(),
    dataRoot: "/tmp/unused",
    runtime,
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
    edgeForms,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });
}

describe("the self-host catalog", () => {
  test("keeps every released identity Form drain-only and out of the sale catalog", async () => {
    const composition = await compose(true);
    expect(composition.offerings).toEqual([]);
    expect(composition.provider.offerings.map((offering) => offering.id).sort()).toEqual([
      "compute.edge.standard",
      "database.sqlite.standard",
      "messaging.queue.standard",
      "selfhost.edge.queueconsumer",
      "selfhost.edge.workercrontrigger",
      "selfhost.edge.workercustomdomain",
      "selfhost.edge.workerdeployment",
      "selfhost.edge.workerendpoint",
      "selfhost.edge.workerversion",
      "storage.kv.standard",
      "storage.object.standard",
    ]);
    expect(JSON.stringify(composition.offerings)).not.toContain("ObjectBucket");
    expect(JSON.stringify(composition.offerings)).not.toContain("edge.objects");
  });

  test("projects exactly one technical offering per relation Form", async () => {
    const composition = await compose(true);
    const edge = await buildEdgeForms();
    const relationForms = edge.forms.filter(
      (form) =>
        form.role !== "identity" &&
        ![
          "WorkerBundle",
          "StaticAssetBundle",
          "SQLiteMigrationSet",
          "SQLiteMigrationApplication",
        ].includes(form.identity.formRef.kind),
    );
    for (const form of relationForms) {
      const matches = composition.provider.offerings.filter(
        (offering) =>
          offering.form.kind === form.identity.formRef.kind &&
          offering.form.schemaDigest === form.identity.formRef.schemaDigest,
      );
      expect(matches).toHaveLength(1);
    }
  });

  test("keeps the legacy storage-only variant drain-only too", async () => {
    const composition = await compose(false);
    expect(composition.offerings).toEqual([]);
    expect(composition.provider.offerings.map((offering) => offering.id)).toEqual([
      "storage.object.standard",
    ]);
  });
});
