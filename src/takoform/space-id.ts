/** Maximum length of a stable Takoform Host Space, measured in Unicode code points. */
export const SPACE_ID_MAX_CODE_POINTS = 255;

/**
 * JSON Schema/ECMA-262 pattern for the stable Space grammar.
 *
 * `maxLength` remains a separate schema keyword because it counts Unicode code
 * points, just like the Host codec below. Keep this source exported so the
 * published OpenAPI description and executable grammar cannot drift apart.
 */
export const SPACE_ID_PATTERN_SOURCE =
  "^(?![\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff])(?![\\s\\S]*[/\\u0000-\\u001f\\u007f-\\u009f])(?![\\s\\S]*[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]$)[\\s\\S]+$";

const BOUNDARY_WHITESPACE =
  /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;

/**
 * Stable Host Space grammar. This module owns syntax only; each calling
 * boundary translates a false result into its own public error taxonomy.
 */
export function isSpaceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const points = [...value];
  return (
    points.length > 0 &&
    points.length <= SPACE_ID_MAX_CODE_POINTS &&
    !BOUNDARY_WHITESPACE.test(points[0] ?? "") &&
    !BOUNDARY_WHITESPACE.test(points.at(-1) ?? "") &&
    points.every((point) => {
      const code = point.codePointAt(0) ?? 0;
      return point !== "/" && code > 0x1f && (code < 0x7f || code > 0x9f);
    })
  );
}
