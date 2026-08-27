import { expect, test } from "bun:test";
import { RUNTIME_TABLES } from "../scripts/deploy/preflight.ts";
import { assertProductTablesPresent, PRODUCT_TABLES } from "../scripts/deploy/verify.ts";

const ADMISSION_TABLES = [
  "tf_form_publisher_events",
  "tf_form_revocation_checkpoints",
  "tf_form_install_events",
  "tf_form_support_events",
  "tf_form_activation_events",
  "tf_form_evacuation_events",
  "tf_form_package_purge_events",
] as const;

test("post-deploy table readback includes every current product table", () => {
  expect(PRODUCT_TABLES).toEqual(expect.arrayContaining(ADMISSION_TABLES));
  expect(new Set(PRODUCT_TABLES).size).toBe(PRODUCT_TABLES.length);
});

test("post-deploy table readback rejects the old sentinel-only inventory", () => {
  expect(() => assertProductTablesPresent(RUNTIME_TABLES)).toThrow(
    "the target is missing product tables",
  );
});
