/**
 * Recognizes one released Edge Forms API lane without pinning Host semantics to
 * yesterday's version. Exact Form identity still includes the full apiVersion,
 * definitionVersion, and schemaDigest everywhere else.
 */
export { isEdgeFormsApiVersion } from "../form-ref.ts";
