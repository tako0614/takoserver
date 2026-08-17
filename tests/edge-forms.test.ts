import { describe, expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { canonicalDigest } from "../src/json.ts";

/**
 * A Form's identity includes the digest of its own schema, so improving a
 * schema mints a different Form. That is the right meaning for an exact-pin
 * protocol, and it has one consequence that must be handled rather than
 * discovered: a resource created under an earlier definition becomes
 * unaddressable the moment that definition stops being installed. Not deleted
 * — unreachable, which is worse, because the backend resource keeps running
 * and billing while nobody can manage or remove it.
 */
describe("edge Forms", () => {
  test("identifies each Form by the digest of its own schema", async () => {
    const edge = await buildEdgeForms();
    for (const form of edge.forms) {
      expect(form.identity.formRef.schemaDigest).toBe(await canonicalDigest(form.desiredSchema));
    }
  });

  test("keeps superseded definitions installed alongside the current one", async () => {
    const edge = await buildEdgeForms();
    const worker = edge.workerScript.forms;
    expect(worker.length).toBeGreaterThan(1);

    // Every definition is distinct, and the newest is what new resources use.
    const digests = worker.map((form) => form.identity.formRef.schemaDigest);
    expect(new Set(digests).size).toBe(digests.length);
    const newest = worker[worker.length - 1];
    expect(newest).toBeDefined();
    expect(edge.workerScript.form).toBe(newest as (typeof worker)[number]);

    // All of them are served, so an older declaration stays manageable.
    for (const form of worker) {
      expect(edge.forms).toContain(form);
    }
  });

  test("still resolves a superseded Form to a provider that can execute it", async () => {
    const edge = await buildEdgeForms();
    const catalog = createCatalog(edge.offerings);
    for (const form of edge.workerScript.forms) {
      const sold = catalog.forForm(form.identity.formRef);
      expect(sold).toBeDefined();
      expect(edge.providerOfferings.some((offering) => offering.id === sold?.id)).toBe(true);
    }
  });

  test("offers only the current definition for sale", async () => {
    const edge = await buildEdgeForms();
    const catalog = createCatalog(edge.offerings);
    const listed = catalog.list();

    // One purchasable offering per kind, however many definitions exist.
    expect(listed.map((offering) => offering.id).sort()).toEqual([
      "compute.worker.standard",
      "database.sql.standard",
      "storage.object.standard",
    ]);
    for (const offering of listed) {
      expect(offering.retired).toBeUndefined();
    }
  });

  test("prices every definition of a kind the same", async () => {
    const edge = await buildEdgeForms({ workerScriptMinor: 2_500 });
    for (const offering of edge.workerScript.offerings) {
      // A customer on an older definition is not charged a different rate for
      // the same thing.
      expect(offering.price.unitPriceMinor).toBe(2_500);
    }
  });

  test("declares the artifact a Worker must be built from", async () => {
    const edge = await buildEdgeForms();
    for (const form of edge.workerScript.forms) {
      expect(form.artifactRequirement).toEqual({ specField: "bundle", kind: "WorkerBundle" });
    }
  });
});
