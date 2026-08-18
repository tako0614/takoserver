/** Exact portable contracts offered or accepted by a Takoform Resource. */
export interface TakoformInterfaceRef {
  readonly apiVersion: "interfaces.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
}

export interface TakoformBindingRef {
  readonly apiVersion: "bindings.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
}
