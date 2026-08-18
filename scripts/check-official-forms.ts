import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { assertReleasedTakoformProviderForms } from "../src/takoform/released-provider-catalog.ts";

const SOURCE_RELEASE = Object.freeze({
  repository: "https://github.com/tako0614/takoform.git",
  tag: "v2.1.1",
  commit: "9810570d542434efcf177543de9d463bbfda0d09",
  files: [
    {
      local: "vendor/takoform/v2.1.1/provider-form-identities.json",
      source: "release/provider-form-identities.json",
      size: 7_177,
      sha256: "494919695007578684f7bf4dfbbd96811f2b9577c17bf7b4a2410312b218d81a",
    },
    {
      local: "vendor/takoform/v2.1.1/object-bucket.definition.json",
      source: "forms/candidates/edge/v1beta1/object-bucket/definition.json",
      size: 2_103,
      sha256: "61f29bd91e211bbf1880e58e13565873c5ebe47417de307d94f5fb0b31df2994",
    },
    {
      local: "vendor/takoform/v2.1.1/object-bucket.package-index.json",
      source: "forms/candidates/edge/v1beta1/object-bucket/package-index.json",
      size: 1_014,
      sha256: "7017c95a1359f9435d3b30d68ebdecc57d3f60295d283d6944f8ac781db18587",
    },
  ],
});

for (const file of SOURCE_RELEASE.files) {
  const vendored = readFileSync(file.local);
  if (vendored.byteLength !== file.size) {
    throw new Error(`released_takoform_source_size_mismatch:${file.local}`);
  }
  const digest = createHash("sha256").update(vendored).digest("hex");
  if (digest !== file.sha256) {
    throw new Error(`released_takoform_source_digest_mismatch:${file.local}`);
  }
  JSON.parse(vendored.toString("utf8"));
}

const edge = await buildEdgeForms();
assertReleasedTakoformProviderForms(edge.forms);
if (
  edge.forms.length !== 1 ||
  edge.forms[0]?.identity.formRef.kind !== "ObjectBucket" ||
  edge.offerings.length !== 1 ||
  edge.offerings[0]?.protocols.join(",") !== "s3"
) {
  throw new Error("released_takoform_product_catalog_mismatch");
}

console.log(
  `official Forms ok: ${SOURCE_RELEASE.repository} ${SOURCE_RELEASE.tag} ` +
    `${SOURCE_RELEASE.commit}; ${edge.forms.length} shipped Form`,
);
