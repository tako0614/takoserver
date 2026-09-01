import { TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE } from "../generated/takoform-publisher-set-authority-closure.ts";
import {
  TAKOFORM_PUBLISHER_SET_RECEIPT,
  TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST,
} from "../generated/takoform-publisher-set-receipt.ts";
import { bytesDigest, canonicalDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import type { AdmissionDigest } from "./admission.ts";
import {
  assertFormAuthorityEvidence,
  type FormAuthorityVerificationEvidence,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
} from "./form-authority-verification.ts";
import type { FormPackageFileInput, FormPackageInput } from "./form-packages.ts";
import {
  type FormAuthorityPackageIdentity,
  type FormAuthorityPackageSource,
  HostAdmissionCoordinatorError,
} from "./host-admission-coordinator.ts";

/**
 * One exact publisher-set import.
 *
 * The generated closure and receipt are public data. This module binds them
 * into a single import identity — exact publisher repository, repository
 * commit, set id/tag, receipt digest and released Core version — and derives
 * the package set, the exact package bytes and the verification evidence the
 * Host hands to released Core before any durable mutation. Neither generated
 * file is executable authority on its own: Core re-verifies the raw policy,
 * trusted root, checkpoint and every Sigstore bundle at the mutation boundary,
 * and the Host still makes its own admission decision afterwards.
 */
export const PUBLISHER_SET_IMPORT_KIND = "takoserver.publisher-set-import@v1" as const;
export const PUBLISHER_SET_NAMESPACE_GRANT_KIND =
  "takoserver.publisher-set-namespace-grant@v1" as const;
const PUBLISHER_KEY_PREFIX = "takoform-forms:";

export interface PublisherSetImportIdentity {
  readonly kind: typeof PUBLISHER_SET_IMPORT_KIND;
  readonly repository: string;
  readonly repositoryCommit: string;
  readonly setId: string;
  readonly setTag: string;
  readonly receiptDigest: AdmissionDigest;
  readonly coreVersion: typeof TAKOFORM_CORE_VERSION;
  readonly packageCount: number;
}

export interface PublisherSetClosure {
  readonly identity: PublisherSetImportIdentity;
  /** Durable publisher chain key: one immutable key per exact import. */
  readonly publisherKey: string;
  /** Every package in the set, independent of Host implementation support. */
  readonly packageSet: readonly FormAuthorityPackageIdentity[];
  /** Exact embedded package bytes for the set. */
  readonly packages: FormAuthorityPackageSource;
  /** Evidence a plan request must carry verbatim for this import. */
  readonly evidence: FormAuthorityVerificationEvidence;
}

let loaded: Promise<PublisherSetClosure> | null = null;

/** Loads, cross-checks and memoizes the embedded exact publisher-set closure. */
export function loadPublisherSetClosure(): Promise<PublisherSetClosure> {
  loaded ??= buildClosure().catch((error) => {
    loaded = null;
    throw error;
  });
  return loaded.then(cloneClosure);
}

async function buildClosure(): Promise<PublisherSetClosure> {
  const closure = TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE;
  const receipt = TAKOFORM_PUBLISHER_SET_RECEIPT;
  const receiptPackages: readonly (typeof receipt.packages)[number][] = receipt.packages;
  if (
    closure.kind !== "takoserver.takoform-publisher-set-authority-closure@v1" ||
    receipt.kind !== "takoserver.publisher-set-verification@v1" ||
    closure.repository !== receipt.repository ||
    closure.repositoryCommit !== receipt.repositoryCommit ||
    closure.setId !== receipt.setId ||
    closure.setTag !== receipt.setTag ||
    closure.setTag !== `forms/sets/${closure.setId}` ||
    closure.receiptDigest !== TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST ||
    (await canonicalDigest(receipt)) !== TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST ||
    receipt.coreVersion !== TAKOFORM_CORE_VERSION ||
    closure.core.protocol !== TAKOFORM_CORE_VERIFIER_PROTOCOL ||
    closure.core.expectedSourceCommit !== receipt.sourceCommit ||
    receipt.sourceCommit !== closure.setId ||
    receipt.workflowCommit !== closure.setId ||
    receipt.buildConfigCommit !== closure.setId ||
    !/^[0-9a-f]{40}$/u.test(closure.setId) ||
    !/^[0-9a-f]{40}$/u.test(closure.repositoryCommit) ||
    !isSha256Digest(receipt.policyDigest) ||
    (await canonicalDigest(receipt.publisherPolicy)) !== receipt.policyDigest ||
    canonicalJson(strictJson(closure.core.publisherPolicy)) !==
      canonicalJson(receipt.publisherPolicy) ||
    (await bytesDigest(utf8(closure.core.checkpointBundle))) !== receipt.checkpoint.bundleDigest ||
    (await bytesDigest(utf8(closure.core.checkpoint))) !== receipt.checkpoint.digest ||
    receipt.checkpoint.previousDigest !== null ||
    receipt.checkpoint.revokedPackageDigests.length !== 0 ||
    receiptPackages.length === 0 ||
    closure.packages.length !== receiptPackages.length ||
    closure.core.packageBundles.length !== receiptPackages.length
  ) {
    throw closureError("generated publisher-set closure and receipt disagree");
  }

  const receiptByDigest = new Map<string, (typeof receipt.packages)[number]>();
  for (const entry of receipt.packages) {
    if (receiptByDigest.has(entry.packageDigest)) {
      throw closureError("publisher-set receipt repeats a package digest");
    }
    receiptByDigest.set(entry.packageDigest, entry);
  }
  const seenFormRefs = new Set<string>();
  const exactPackages = new Map<string, FormPackageInput>();
  const packageSet: FormAuthorityPackageIdentity[] = [];
  for (const pkg of closure.packages) {
    const entry = receiptByDigest.get(pkg.packageDigest);
    const formRefKey = canonicalJson(pkg.formRef);
    if (
      !entry ||
      seenFormRefs.has(formRefKey) ||
      canonicalJson(entry.formRef) !== formRefKey ||
      canonicalJson(pkg.manifest.formRef) !== formRefKey ||
      (await canonicalDigest(pkg.manifest)) !== pkg.packageDigest ||
      pkg.files.length !== pkg.manifest.files.length
    ) {
      throw closureError(`publisher-set package ${pkg.packageDigest} is not exact`);
    }
    seenFormRefs.add(formRefKey);
    const files: FormPackageFileInput[] = [];
    for (const descriptor of pkg.manifest.files) {
      const matches = pkg.files.filter((file) => file.path === descriptor.path);
      const file = matches[0];
      if (!file || matches.length !== 1) {
        throw closureError(`publisher-set package ${pkg.packageDigest} file closure is not exact`);
      }
      const bytes = base64Bytes(file.base64);
      if (
        bytes.byteLength !== descriptor.size ||
        file.digest !== descriptor.digest ||
        (await bytesDigest(bytes)) !== descriptor.digest ||
        file.mediaType !== descriptor.mediaType
      ) {
        throw closureError(`publisher-set package ${pkg.packageDigest} file ${file.path} drifted`);
      }
      files.push({
        path: file.path,
        bytes,
        digest: file.digest,
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      });
    }
    exactPackages.set(packageKey(pkg.formRef, pkg.packageDigest), {
      packageDigest: pkg.packageDigest,
      formRef: structuredClone(pkg.formRef),
      manifest: structuredClone(pkg.manifest) as unknown as JsonObject,
      files,
    });
    packageSet.push({
      formRef: structuredClone(pkg.formRef),
      packageDigest: pkg.packageDigest,
    });
  }

  const packageBundles: {
    readonly formRef: FormPackageInput["formRef"];
    readonly packageDigest: AdmissionDigest;
    readonly bundle: string;
  }[] = [];
  const packageBundleDigests: {
    readonly formRef: FormPackageInput["formRef"];
    readonly packageDigest: AdmissionDigest;
    readonly bundleDigest: AdmissionDigest;
  }[] = [];
  const seenBundles = new Set<string>();
  for (const bundle of closure.core.packageBundles) {
    const entry = receiptByDigest.get(bundle.packageDigest);
    if (
      !entry ||
      seenBundles.has(bundle.packageDigest) ||
      (await bytesDigest(utf8(bundle.bundle))) !== entry.bundleDigest
    ) {
      throw closureError(`publisher-set bundle ${bundle.packageDigest} drifted from the receipt`);
    }
    seenBundles.add(bundle.packageDigest);
    packageBundles.push({
      formRef: structuredClone(entry.formRef),
      packageDigest: bundle.packageDigest,
      bundle: bundle.bundle,
    });
    packageBundleDigests.push({
      formRef: structuredClone(entry.formRef),
      packageDigest: bundle.packageDigest,
      bundleDigest: entry.bundleDigest,
    });
  }
  sortByFormRef(packageSet);
  sortByFormRef(packageBundles);
  sortByFormRef(packageBundleDigests);

  const identity: PublisherSetImportIdentity = {
    kind: PUBLISHER_SET_IMPORT_KIND,
    repository: closure.repository,
    repositoryCommit: closure.repositoryCommit,
    setId: closure.setId,
    setTag: closure.setTag,
    receiptDigest: closure.receiptDigest,
    coreVersion: TAKOFORM_CORE_VERSION,
    packageCount: packageSet.length,
  };
  const publisherKey = `${PUBLISHER_KEY_PREFIX}${await canonicalDigest(identity)}`;
  const source = sourceIdentifiers(receipt.sourceRepository);
  const namespaceGrantDigest = await canonicalDigest({
    kind: PUBLISHER_SET_NAMESPACE_GRANT_KIND,
    group: receipt.family,
    publisherIdentity: receipt.publisherIdentity,
    sourceRepository: receipt.sourceRepository,
  });
  const evidence: FormAuthorityVerificationEvidence = {
    publisher: {
      publisherKey,
      policyDigest: receipt.policyDigest,
      policy: structuredClone(receipt.publisherPolicy) as unknown as Record<string, unknown>,
      oidcIssuer: receipt.oidcIssuer,
      sourceRepository: receipt.sourceRepository,
      workflow: receipt.workflow,
      ref: receipt.ref,
      identity: receipt.publisherIdentity,
      trustedRootDigest: receipt.trustedRootDigest,
      sourceCommit: receipt.sourceCommit,
      workflowCommit: receipt.workflowCommit,
      buildConfigCommit: receipt.buildConfigCommit,
      repositoryIdentifier: source.repositoryIdentifier,
      ownerIdentifier: source.ownerIdentifier,
      group: receipt.family,
      namespaceGrantDigest,
    },
    checkpoint: {
      apiVersion: receipt.checkpoint.apiVersion,
      sequence: receipt.checkpoint.sequence,
      digest: receipt.checkpoint.digest,
      entriesDigest: receipt.checkpoint.entriesDigest,
      previousDigest: null,
      revokedPackageDigests: [],
    },
    core: {
      protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      expectedSourceCommit: closure.core.expectedSourceCommit,
      publisherPolicy: closure.core.publisherPolicy,
      trustedRoot: closure.core.trustedRoot,
      checkpoint: closure.core.checkpoint,
      checkpointBundle: closure.core.checkpointBundle,
      packageBundles,
    },
    checkpointBundleDigest: receipt.checkpoint.bundleDigest,
    packageBundleDigests,
  };
  assertFormAuthorityEvidence(evidence, packageSet);

  return {
    identity,
    publisherKey,
    packageSet,
    packages: exactPackageSource(exactPackages),
    evidence,
  };
}

function exactPackageSource(
  exact: ReadonlyMap<string, FormPackageInput>,
): FormAuthorityPackageSource {
  return {
    async load({ formRef, packageDigest }): Promise<FormPackageInput> {
      const pkg = exact.get(packageKey(formRef, packageDigest));
      if (!pkg) {
        throw new HostAdmissionCoordinatorError(
          "package_unavailable",
          "package is not part of the embedded exact publisher set",
        );
      }
      return clonePackage(pkg);
    },
  };
}

function cloneClosure(closure: PublisherSetClosure): PublisherSetClosure {
  return {
    identity: structuredClone(closure.identity),
    publisherKey: closure.publisherKey,
    packageSet: structuredClone(closure.packageSet),
    packages: closure.packages,
    evidence: structuredClone(closure.evidence),
  };
}

function clonePackage(pkg: FormPackageInput): FormPackageInput {
  return {
    packageDigest: pkg.packageDigest,
    formRef: structuredClone(pkg.formRef),
    ...(pkg.manifest === undefined ? {} : { manifest: structuredClone(pkg.manifest) }),
    files: pkg.files.map((file) => ({
      path: file.path,
      bytes: file.bytes instanceof Uint8Array ? file.bytes.slice() : file.bytes,
      ...(file.digest === undefined ? {} : { digest: file.digest }),
      ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    })),
  };
}

function sourceIdentifiers(sourceRepository: string): {
  readonly repositoryIdentifier: string;
  readonly ownerIdentifier: string;
} {
  const url = new URL(sourceRepository);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const [owner, name] = segments;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    segments.length !== 2 ||
    !owner ||
    !name ||
    !/^[A-Za-z0-9._-]+$/u.test(owner) ||
    !/^[A-Za-z0-9._-]+$/u.test(name)
  ) {
    throw closureError("publisher-set source repository is not an exact GitHub repository");
  }
  return { repositoryIdentifier: `repo:${owner}/${name}`, ownerIdentifier: `owner:${owner}` };
}

function sortByFormRef<T extends { readonly formRef: unknown }>(values: T[]): void {
  values.sort((left, right) =>
    canonicalJson(left.formRef).localeCompare(canonicalJson(right.formRef)),
  );
}

function packageKey(formRef: unknown, packageDigest: string): string {
  return `${canonicalJson(formRef)}\0${packageDigest}`;
}

function strictJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw closureError("publisher-set closure carries malformed JSON");
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64Bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw closureError("publisher-set closure carries malformed package bytes");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function closureError(message: string): TypeError {
  return new TypeError(message);
}
