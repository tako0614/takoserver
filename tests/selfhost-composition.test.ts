import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createSelfhostComposition } from "../src/selfhost-composition.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * A self-hosted Takoserver that cannot host a Worker is a place to keep
 * files, not a Takoform Host. The default catalog therefore sells every
 * released Edge identity Form, and every relation Form has exactly one
 * technical projection so the driver can inherit it — while the operator who
 * deliberately runs a storage-only machine can still narrow the catalog.
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
  test("sells the released Edge identity Forms beside the bucket", async () => {
    const composition = await compose(true);
    expect(composition.offerings.map((offering) => offering.id).sort()).toEqual([
      "compute.edge.standard",
      "database.sqlite.standard",
      "messaging.queue.standard",
      "storage.kv.standard",
      "storage.object.standard",
    ]);
    for (const offering of composition.offerings) {
      // Local supply: the operator's own machine, at no catalog price.
      expect(offering.pricePlan.provisioning.amountMinor).toBe(0);
      expect(offering.providerPackRef).toBe("local");
      expect(offering.providerInstallationRef).toBe("local.primary");
      expect(offering.deliveryMode).toBe("managed-endpoint");
    }
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

  test("narrows to object storage when the operator turns the Edge Family off", async () => {
    const composition = await compose(false);
    expect(composition.offerings.map((offering) => offering.id)).toEqual([
      "storage.object.standard",
    ]);
  });
});
