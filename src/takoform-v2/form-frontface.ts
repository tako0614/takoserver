import type { V2Form } from "./types.ts";

/** Synchronous Form policy shared by the Host and the executing backend. */
export type V2FormFrontFace = Required<
  Pick<V2Form, "validateCreate" | "validateUpdate" | "references" | "rejectDeleteWhileReferenced">
>;
