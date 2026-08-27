import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildEdgeForms, objectBucketProviderOffering } from "../src/edge-forms.ts";
import {
  assertReleasedTakoformProviderBindings,
  assertReleasedTakoformProviderForms,
} from "../src/takoform/released-provider-catalog.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

const VENDOR_ROOT = "vendor/takoform/v2.1.1";
const MANIFEST_PATH = `${VENDOR_ROOT}/source-manifest.json`;
const MANIFEST_SIZE = 9_614;
const MANIFEST_SHA256 = "0efd67356bebd44c33607e1e518c2b30a630d5c41efa2e576b0b967919260282";
const STABLE_CATALOG_PATH = "src/generated/takoform-stable-v1-catalog.ts";
const STABLE_CATALOG_SIZE = 168_740;
const STABLE_CATALOG_SHA256 = "6f03577b12b46dba04f1d66ff7d37b0827fb0c35d4376a41f02acd03bc43c04e";

interface SourceManifest {
  readonly format: "takoserver.vendored-takoform-source@v1";
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly files: readonly {
    readonly local: string;
    readonly source: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

const manifestBytes = readFileSync(MANIFEST_PATH);
if (
  manifestBytes.byteLength !== MANIFEST_SIZE ||
  createHash("sha256").update(manifestBytes).digest("hex") !== MANIFEST_SHA256
) {
  throw new Error("released_takoform_source_manifest_mismatch");
}
const source = JSON.parse(manifestBytes.toString("utf8")) as SourceManifest;
if (
  source.format !== "takoserver.vendored-takoform-source@v1" ||
  source.repository !== "https://github.com/tako0614/terraform-provider-takoform.git" ||
  source.tag !== "v2.1.1" ||
  source.commit !== "9810570d542434efcf177543de9d463bbfda0d09" ||
  source.files.length !== 36
) {
  throw new Error("released_takoform_source_authority_mismatch");
}

const stableCatalogBytes = readFileSync(STABLE_CATALOG_PATH);
if (
  stableCatalogBytes.byteLength !== STABLE_CATALOG_SIZE ||
  createHash("sha256").update(stableCatalogBytes).digest("hex") !== STABLE_CATALOG_SHA256
) {
  throw new Error("stable_takoform_catalog_bytes_mismatch");
}

for (const file of source.files) {
  if (!/^[A-Za-z0-9._/-]+$/u.test(file.local) || file.local.includes("..")) {
    throw new Error("released_takoform_source_path_invalid");
  }
  const vendored = readFileSync(`${VENDOR_ROOT}/${file.local}`);
  if (vendored.byteLength !== file.size) {
    throw new Error(`released_takoform_source_size_mismatch:${file.local}`);
  }
  if (createHash("sha256").update(vendored).digest("hex") !== file.sha256) {
    throw new Error(`released_takoform_source_digest_mismatch:${file.local}`);
  }
  JSON.parse(vendored.toString("utf8"));
}

const edge = await buildEdgeForms();
assertReleasedTakoformProviderForms(edge.forms);
assertReleasedTakoformProviderBindings(edge.bindings);
const objectBucket = objectBucketProviderOffering(edge.objectBucket.form, {
  id: "storage.object.standard",
  displayName: "Object bucket",
});
if (
  edge.forms.length !== 15 ||
  edge.bindings.length !== 5 ||
  edge.forms.some(
    (form) => form.identity.formRef.apiVersion !== "edge.forms.takoform.com/v1beta1",
  ) ||
  objectBucket.providedInterfaces.map((entry) => entry.name).join(",") !== "edge.objects"
) {
  throw new Error("released_takoform_product_catalog_mismatch");
}
const stable = stableProductionTakoformCatalog();

console.log(
  `official Forms ok: retained ${source.repository} ${source.tag} ${source.commit} ` +
    `${edge.forms.length} Forms/${edge.bindings.length} Bindings; staging adoption candidate ` +
    `${stable.provenance.repository} ${stable.provenance.commit} ` +
    `${stable.forms.length} Forms/${stable.bindings.length} Bindings`,
);
