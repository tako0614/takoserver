/**
 * The identity of a Takoform Form.
 *
 * This lives in core rather than with the Host's wire types because three
 * layers need to name a Form without depending on each other: the catalog
 * prices one, a provider declares which one it can execute, and the Host
 * resolves one. Identity is the whole quad — anything less is a different Form.
 */
export interface TakoformV1Alpha3FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: `sha256:${string}`;
}
