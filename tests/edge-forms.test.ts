import { describe, expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { canonicalDigest } from "../src/json.ts";
import { validateDesired } from "../src/takoform/schema.ts";

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

/**
 * The digest of a shipped definition is its identity, and resources in
 * production name it. Changing a schema in place — even to fix something —
 * mints a different Form and strands every resource that named the old one:
 * still running, still billing, no longer addressable. Pinning the digests
 * turns that from a mistake somebody discovers in production into a failing
 * test.
 *
 * Adding a line here is how a new definition ships. Changing one is not.
 */
describe("shipped Form digests", () => {
  test("never move once published", async () => {
    const edge = await buildEdgeForms();
    const published = Object.fromEntries(
      edge.workerScript.forms.map((form) => [
        form.identity.formRef.definitionVersion,
        form.identity.formRef.schemaDigest,
      ]),
    );
    expect(published).toEqual({
      "1.0.0": "sha256:2f53c9e9fba4ba4c96b4693fe1440e1e54fd2b3641f2fb5794b14068c0c46e32",
      "1.1.0": "sha256:f5eaa41ee1dd1d701af921d6eb6f4ef8955dca7b3edcd9df58edcaeff0609f8f",
      "1.2.0": "sha256:c76c3a5d0583ec749c119970090c3cf3fa9ec81ce039cbc09d8f312e12c7dcfa",
      "1.3.0": "sha256:afff66bf3d4ba016a9fc3e99e50edee81f63a7c9caefd026e81a6b9960889fd9",
    });
  });

  test("accepts a static asset declaration only in the definition that has it", async () => {
    const edge = await buildEdgeForms();
    const spec = {
      bundle: `sha256:${"a".repeat(64)}`,
      assets: { bundle: `sha256:${"b".repeat(64)}` },
    };
    const by = (version: string) =>
      edge.workerScript.forms.find((form) => form.identity.formRef.definitionVersion === version);

    const complaints = (version: string) => {
      const form = by(version);
      expect(form).toBeDefined();
      return validateDesired(form as NonNullable<typeof form>, spec);
    };

    // 1.2.0 refuses it — which is the point of minting 1.3.0 rather than
    // widening a definition that resources already name.
    expect(complaints("1.2.0").length).toBeGreaterThan(0);
    expect(complaints("1.3.0")).toEqual([]);
  });
});
