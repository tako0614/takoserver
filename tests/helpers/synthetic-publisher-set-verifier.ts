import { takoformCoreVerifierArtifactDigest } from "../../scripts/deploy/form-authority.ts";
import { TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE } from "../../src/generated/takoform-publisher-set-authority-closure.ts";
import { TAKOFORM_PUBLISHER_SET_RECEIPT } from "../../src/generated/takoform-publisher-set-receipt.ts";
import { bytesDigest } from "../../src/json.ts";
import {
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
} from "../../src/takoform/form-authority-verification.ts";

const ARTIFACT_DIGEST = takoformCoreVerifierArtifactDigest();
const RAW_POLICY_DIGEST = await bytesDigest(
  new TextEncoder().encode(TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE.core.publisherPolicy),
);

/**
 * Replays synthetic external verifier responses for the exact embedded set.
 *
 * The normal coordinator still installs the published bytes and records its
 * durable admission decisions. This fixture does NOT execute released Core or
 * verify Sigstore/publisher authenticity, even when a resulting protocol field
 * says `released-core`. Such fields are inputs to these tests, not live proof.
 */
export function createSyntheticPublisherSetVerifier(options?: {
  readonly artifactDigest?: `sha256:${string}`;
}) {
  const calls: string[] = [];
  const identity = {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    coreVersion: TAKOFORM_CORE_VERSION,
    coreCommit: TAKOFORM_CORE_COMMIT,
    artifactDigest: options?.artifactDigest ?? ARTIFACT_DIGEST,
  };
  const receipt = TAKOFORM_PUBLISHER_SET_RECEIPT;
  return {
    calls,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === "/v1/identity") return Response.json(identity);
      if (path !== "/v1/verify-set") {
        throw new Error(`unexpected synthetic verifier path ${path}`);
      }
      const body = (await request.json()) as {
        readonly packages: readonly { packageDigest: string; formRef: unknown }[];
      };
      return Response.json({
        identity,
        publisher: {
          policyDigest: RAW_POLICY_DIGEST,
          trustedRootDigest: receipt.trustedRootDigest,
          oidcIssuer: receipt.oidcIssuer,
          sourceRepository: receipt.sourceRepository,
          workflow: receipt.workflow,
          ref: receipt.ref,
          identity: receipt.publisherIdentity,
          sourceCommit: receipt.sourceCommit,
          workflowCommit: receipt.workflowCommit,
          buildConfigCommit: receipt.buildConfigCommit,
        },
        checkpoint: {
          checkpointApiVersion: receipt.checkpoint.apiVersion,
          sequence: receipt.checkpoint.sequence,
          digest: receipt.checkpoint.digest,
          entriesDigest: receipt.checkpoint.entriesDigest,
          bundleDigest: receipt.checkpoint.bundleDigest,
          revokedPackageDigests: [],
        },
        packages: body.packages.map((pkg) => {
          const entry = receipt.packages.find((item) => item.packageDigest === pkg.packageDigest);
          if (!entry) throw new Error(`unexpected package ${pkg.packageDigest}`);
          return {
            packageDigest: pkg.packageDigest,
            formRef: pkg.formRef,
            bundleDigest: entry.bundleDigest,
          };
        }),
      });
    },
  };
}
