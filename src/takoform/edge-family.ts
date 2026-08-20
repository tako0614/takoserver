const EDGE_FORMS_GROUP = "edge.forms.takoform.com";

/**
 * Recognizes one released Edge Forms API lane without pinning Host semantics to
 * yesterday's version. Exact Form identity still includes the full apiVersion,
 * definitionVersion, and schemaDigest everywhere else.
 */
export function isEdgeFormsApiVersion(apiVersion: string): boolean {
  const separator = apiVersion.indexOf("/");
  return separator > 0 && apiVersion.slice(0, separator) === EDGE_FORMS_GROUP;
}
