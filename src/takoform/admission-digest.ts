import { isSha256Digest } from "../json.ts";

/** Content identity shared by the admission writer and its read-only projection. */
export type AdmissionDigest = `sha256:${string}`;

/** The zero predecessor makes the first event in every append-only chain explicit. */
export const ADMISSION_GENESIS_DIGEST = `sha256:${"0".repeat(64)}` as AdmissionDigest;

export const TAKOFORM_REVOCATION_V1 = "trust.forms.takoform.com/v1" as const;
export const TAKOFORM_REVOCATION_V1ALPHA1 = "trust.forms.takoform.com/v1alpha1" as const;
export type TakoformRevocationCheckpointApiVersion =
  | typeof TAKOFORM_REVOCATION_V1
  | typeof TAKOFORM_REVOCATION_V1ALPHA1;

/** RFC 8785 digest of the one signed empty v1 sequence-zero checkpoint. */
export const TAKOFORM_REVOCATION_V1_GENESIS_DIGEST =
  "sha256:35c5c4cdc6cd6c4beaec8ba273091be10ae02c0d6f49861f97062fd59f9e8f66" as const;

/** RFC 8785 digest of the genesis checkpoint's exact empty cumulative entry set. */
export const TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST =
  "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" as const;

/** Read-side validation that carries no command, handle, or writer dependency. */
export function assertAdmissionDigest(
  value: unknown,
  label = "digest",
): asserts value is AdmissionDigest {
  if (!isSha256Digest(value)) throw new TypeError(`invalid ${label}`);
}
