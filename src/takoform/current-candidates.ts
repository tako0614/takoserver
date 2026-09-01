import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../generated/takoform-stable-v1-catalog.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./types.ts";

export interface CurrentTakoformCandidates {
  readonly provenance: {
    readonly classification: "public-publisher-set-projection";
    readonly repository: string;
    readonly repositoryCommit: string;
    readonly setId: string;
    readonly setTag: string;
    readonly sourceCommit: string;
    readonly coreVersion: "v1.1.0";
    readonly verificationReceiptDigest: `sha256:${string}`;
    readonly publicationStatus: "published";
    readonly candidateTreeDigest: `sha256:${string}`;
    readonly familyIndexSha256: `sha256:${string}`;
    readonly familyCandidateSetSha256: `sha256:${string}`;
    readonly interfaceCandidateSetSha256: `sha256:${string}`;
    readonly bindingCandidateSetSha256: `sha256:${string}`;
    readonly familyCount: number;
    readonly formCount: number;
    readonly interfaceCount: number;
    readonly bindingCount: number;
  };
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
}

/**
 * Exact build projection for package/Definition byte matching and provider
 * capability composition. Publication verification still does not confer
 * Host support or activation authority at runtime.
 */
export function currentTakoformCandidates(): CurrentTakoformCandidates {
  const catalog = structuredClone(
    STABLE_PRODUCTION_TAKOFORM_CATALOG,
  ) as unknown as CurrentTakoformCandidates;
  if (
    catalog.provenance.classification !== "public-publisher-set-projection" ||
    catalog.provenance.repository !== "https://github.com/tako0614/takoform-forms.git" ||
    catalog.provenance.repositoryCommit !== "3231633605b737ce5279d7fc020b4780568e7091" ||
    catalog.provenance.setId !== "e7f8a39311dd011b8467e97e7f300cabb9a6b06c" ||
    catalog.provenance.setTag !== "forms/sets/e7f8a39311dd011b8467e97e7f300cabb9a6b06c" ||
    catalog.provenance.sourceCommit !== "e7f8a39311dd011b8467e97e7f300cabb9a6b06c" ||
    catalog.provenance.coreVersion !== "v1.1.0" ||
    catalog.provenance.verificationReceiptDigest !==
      "sha256:41c5d640813cf8f4aaaaa0e2c6ea7323100c2f7054fe4f02a2127837551d3055" ||
    catalog.provenance.publicationStatus !== "published" ||
    catalog.provenance.candidateTreeDigest !==
      "sha256:1b471fd96099c1bcdceb63f6f577946c9d6090dc2aee2a02447ced79cb5449e1" ||
    catalog.provenance.familyIndexSha256 !==
      "sha256:9eecc0732fbb8595bd1c84827f256ed7f68258f5d4658799fb3ae049607976ea" ||
    catalog.provenance.familyCandidateSetSha256 !==
      "sha256:02dcede7086df8fdf1513c3f47bb4ee011eed8f0812d601d38d942b2d6da5ccf" ||
    catalog.provenance.interfaceCandidateSetSha256 !==
      "sha256:2a66a036d0393c4acd37541bdd3ebaa879b897c5bdbe325f02ee2aa69ae4a402" ||
    catalog.provenance.bindingCandidateSetSha256 !==
      "sha256:ed725f798c2079c074a5a19e22d3494d920e5b46f85f11eea6c1e3c098a065fd" ||
    catalog.provenance.familyCount !== 1 ||
    catalog.provenance.formCount !== 17 ||
    catalog.provenance.interfaceCount !== 8 ||
    catalog.provenance.bindingCount !== 7 ||
    catalog.forms.length !== catalog.provenance.formCount ||
    catalog.bindings.length !== catalog.provenance.bindingCount ||
    catalog.forms.some(
      (form) =>
        form.identity.formRef.apiVersion !== "edge.forms.takoform.com" ||
        form.requiresHostApi !== "forms.takoform.com/v1",
    ) ||
    !catalog.forms.some(
      (form) =>
        form.identity.formRef.kind === "ObjectBucket" &&
        form.identity.formRef.definitionVersion === "0.1.0" &&
        form.identity.formRef.schemaDigest ===
          "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557" &&
        form.identity.packageDigest ===
          "sha256:46cd435d838d89de641d38180680e99c8bc7be1a3ae9c123494440d3e6e202ec" &&
        (form.providedInterfaces ?? []).some(
          (provided) =>
            provided.name === "edge.objects" &&
            provided.version === "1.0.0" &&
            provided.schemaDigest ===
              "sha256:b58cb2d54c93e4d97abe4ff3684dd88c8a400b4e39ec7fe2f3ba549c4ac448ba",
        ),
    ) ||
    !catalog.forms.some(
      (form) =>
        form.identity.formRef.kind === "WorkerVersion" &&
        form.identity.formRef.definitionVersion === "0.3.0" &&
        form.identity.formRef.schemaDigest ===
          "sha256:65870343bfab512fe5e7ae6faea8b3dbc48f9c9de0d4d9349dcbfd819f06d365" &&
        form.identity.packageDigest ===
          "sha256:21adc2e4e677cd31e905483d38eff60c9eb61112f6c234a01d6a487154980891",
    ) ||
    !catalog.forms.some(
      (form) =>
        form.identity.formRef.kind === "WorkerDeployment" &&
        form.identity.formRef.definitionVersion === "0.2.0" &&
        form.identity.formRef.schemaDigest ===
          "sha256:3d5174bf2c3f351cf1468607689019e9eaa503a353eceb3095cf3d31bad62081" &&
        form.identity.packageDigest ===
          "sha256:a752244c9f90caf18f9b5cec1b6b850fc318e6ec937d5b23eec33169f638c281",
    ) ||
    !catalog.bindings.some(
      (binding) =>
        binding.bindingRef.name === "module-worker.object-bucket" &&
        binding.bindingRef.version === "1.1.0" &&
        binding.bindingRef.schemaDigest ===
          "sha256:ff8661459b73a8d229e0915c698afad2aa297b5db90fe5e1693d346a7ae3adfb",
    )
  ) {
    throw new TypeError("current Takoform candidate corpus integrity failure");
  }
  return catalog;
}
