import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildEdgeForms } from "../src/edge-forms.ts";
import {
  assertReleasedTakoformProviderBindings,
  assertReleasedTakoformProviderForms,
} from "../src/takoform/released-provider-catalog.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

const VENDOR_ROOT = "vendor/takoform/v2.1.1";
const MANIFEST_PATH = `${VENDOR_ROOT}/source-manifest.json`;
const MANIFEST_SIZE = 9_595;
const MANIFEST_SHA256 = "229cd5c5209fae5c1088418216f75ce1ea7d049af027c527117aff0f1137f2ad";
const STABLE_CATALOG_PATH = "src/generated/takoform-stable-v1-catalog.ts";
const STABLE_CATALOG_SIZE = 99_632;
const STABLE_CATALOG_SHA256 = "85fec32b0793b95699969656b6dcd9c227dfaa47731e8bb1adbecdeb21f2d71b";
const PUBLISHER_RECEIPT_PATH = "src/generated/takoform-publisher-set-receipt.ts";
const PUBLISHER_RECEIPT_SIZE = 15_530;
const PUBLISHER_RECEIPT_SHA256 = "31457e7a98176539a105a0533dd93897252228afbf3696836134e133d968105f";
const PUBLISHER_AUTHORITY_CLOSURE_PATH =
  "src/generated/takoform-publisher-set-authority-closure.ts";
const PUBLISHER_AUTHORITY_CLOSURE_SIZE = 508_336;
const PUBLISHER_AUTHORITY_CLOSURE_SHA256 =
  "cd538d61fec561a0cde25f36ea20187c20400cbb9ac4559e3009e2344ee8c105";

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
  source.repository !== "https://github.com/tako0614/takoform.git" ||
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
const publisherReceiptBytes = readFileSync(PUBLISHER_RECEIPT_PATH);
if (
  publisherReceiptBytes.byteLength !== PUBLISHER_RECEIPT_SIZE ||
  createHash("sha256").update(publisherReceiptBytes).digest("hex") !== PUBLISHER_RECEIPT_SHA256
) {
  throw new Error("publisher_set_receipt_bytes_mismatch");
}
const publisherAuthorityClosureBytes = readFileSync(PUBLISHER_AUTHORITY_CLOSURE_PATH);
if (
  publisherAuthorityClosureBytes.byteLength !== PUBLISHER_AUTHORITY_CLOSURE_SIZE ||
  createHash("sha256").update(publisherAuthorityClosureBytes).digest("hex") !==
    PUBLISHER_AUTHORITY_CLOSURE_SHA256
) {
  throw new Error("publisher_set_authority_closure_bytes_mismatch");
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
if (
  edge.forms.length !== 15 ||
  edge.bindings.length !== 5 ||
  edge.forms.some(
    (form) => form.identity.formRef.apiVersion !== "edge.forms.takoform.com/v1beta1",
  ) ||
  edge.objectBucket.form.providedInterfaces?.map((entry) => entry.name).join(",") !== "edge.objects"
) {
  throw new Error("released_takoform_product_catalog_mismatch");
}
const stable = stableProductionTakoformCatalog();

console.log(
  `Form corpora ok: retained ${source.repository} ${source.tag} ${source.commit} ` +
    `${edge.forms.length} Forms/${edge.bindings.length} Bindings; stable ` +
    `${stable.provenance.repository} ${stable.provenance.setTag} ` +
    `${stable.forms.length} Forms/${stable.bindings.length} Bindings`,
);
