import type { FormSupport } from "../api.ts";
import { type Child, h, live } from "../dom.ts";
import { resource } from "../reactive.ts";
import { api } from "../state.ts";
import { badge, card, copyable, empty, shortDigest, whenReady } from "../ui.ts";

/**
 * Every Form definition the Host will accept, grouped by lineage.
 *
 * This page exists because of a property of the protocol that nothing else
 * surfaces: a Form's identity includes the digest of its own schema, so
 * improving a schema mints a *different* Form, and the older one has to stay
 * installed or every resource created under it becomes unaddressable. Seeing
 * the whole lineage is how an operator confirms that has not been broken.
 */
export function formsPage(): Child {
  const forms = resource(() => api.forms());

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, "Forms"),
        h(
          "p",
          null,
          "The Host resolves a declaration by an exact reference: group, kind, definition version, and the digest of the schema itself. Superseded definitions stay installed so resources made under them remain manageable.",
        ),
      ),
    ),
    live(() =>
      whenReady(
        forms.get(),
        ({ profiles }) =>
          profiles.length === 0
            ? card(null, empty("No Forms installed", "This Host accepts nothing."))
            : h(
                "div",
                { style: { display: "grid", gap: "14px" } },
                ...group(profiles).map(([lineage, definitions]) =>
                  card(
                    h(
                      "span",
                      { style: { display: "flex", alignItems: "center", gap: "8px" } },
                      h("span", { class: "mono" }, lineage),
                      badge(
                        `${definitions.length} definition${definitions.length === 1 ? "" : "s"}`,
                      ),
                    ),
                    h(
                      "div",
                      { class: "table-scroll" },
                      h(
                        "table",
                        null,
                        h(
                          "thead",
                          null,
                          h(
                            "tr",
                            null,
                            h("th", null, "Version"),
                            h("th", null, "Schema digest"),
                            h("th", null, "Operations"),
                            h("th", null, "Bindings"),
                          ),
                        ),
                        h(
                          "tbody",
                          null,
                          ...definitions.map((profile, index) =>
                            h(
                              "tr",
                              null,
                              h(
                                "td",
                                null,
                                h("span", { class: "mono" }, profile.formRef.definitionVersion),
                                index === definitions.length - 1
                                  ? h(
                                      "span",
                                      { style: { marginLeft: "8px" } },
                                      badge("current", "ok"),
                                    )
                                  : h(
                                      "span",
                                      { style: { marginLeft: "8px" } },
                                      badge("superseded", "idle"),
                                    ),
                              ),
                              h(
                                "td",
                                null,
                                copyable(
                                  profile.formRef.schemaDigest,
                                  shortDigest(profile.formRef.schemaDigest),
                                ),
                              ),
                              h(
                                "td",
                                null,
                                h(
                                  "span",
                                  { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                                  ...profile.operations.map((operation) => badge(operation)),
                                ),
                              ),
                              h(
                                "td",
                                { class: "dim mono", style: { fontSize: "12px" } },
                                profile.supportedBindings?.join(", ") ?? "—",
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
        { retry: forms.reload },
      ),
    ),
  );
}

/** Definitions of one kind, oldest first, so the newest reads as current. */
function group(
  profiles: readonly FormSupport[],
): readonly (readonly [string, readonly FormSupport[]])[] {
  const lineages = new Map<string, FormSupport[]>();
  for (const profile of profiles) {
    const key = `${profile.formRef.apiVersion}/${profile.formRef.kind}`;
    const bucket = lineages.get(key) ?? [];
    bucket.push(profile);
    lineages.set(key, bucket);
  }
  return [...lineages.entries()]
    .map(
      ([key, bucket]) =>
        [
          key,
          [...bucket].sort((left, right) =>
            compareVersions(left.formRef.definitionVersion, right.formRef.definitionVersion),
          ),
        ] as const,
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string): readonly number[] => value.split(".").map((part) => Number(part));
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}
