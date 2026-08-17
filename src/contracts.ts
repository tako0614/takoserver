/**
 * Shapes shared by the parts of the old backend lane that have not been
 * replaced yet.
 *
 * The command/result vocabulary that used to live here is gone: there is one
 * transport, and routes now call domain functions directly instead of packing
 * arguments into an envelope. What remains are the three value types the
 * backend adapter, the durable registry, and the released provider constants
 * still speak. They move to their owners when the provider port lands.
 */

export interface ExactFormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
  /** Optional audit evidence; never part of exact Form identity. */
  readonly packageDigest?: string;
}

export interface ServiceAllowance {
  readonly protocol: "s3" | "openai";
  readonly mode: "direct";
  /** Discovery metadata only. A separately issued scoped token is required. */
  readonly authority: "resource_scoped_grant";
}

export interface OfferingPrice {
  readonly currency: "USD";
  readonly unit: string;
  readonly unitPriceMinor: number;
}
