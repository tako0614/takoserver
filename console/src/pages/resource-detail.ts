import type { ResourceSummary } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { resource, signal } from "../reactive.ts";
import { health } from "../resource-state.ts";
import { linkProps } from "../router.ts";
import { api } from "../state.ts";
import {
  badge,
  card,
  copyable,
  empty,
  ICON,
  icon,
  jsonBlock,
  shortDigest,
  when,
  whenReady,
} from "../ui.ts";

/**
 * One resource, in full.
 *
 * The page is arranged around a distinction the protocol makes and most
 * consoles blur: `spec` is what the customer declared, `status.observed` is
 * what the backend actually reports, and they are shown side by side rather
 * than merged into a single "configuration". When they disagree, that
 * disagreement is the most useful thing on the screen.
 */
export function resourceDetailPage(
  organizationId: string,
  address: { space: string; kind: string; name: string },
): Child {
  const tab = signal<"overview" | "spec" | "observed" | "identity">("overview");
  const page = resource(async () => {
    const { resources } = await api.resources(organizationId, { space: address.space });
    return (
      resources.find(
        (entry) => entry.kind === address.kind && entry.metadata.name === address.name,
      ) ?? null
    );
  });

  return h(
    "div",
    { class: "page" },
    live(() =>
      whenReady(
        page.get(),
        (found) =>
          found === null
            ? card(
                null,
                empty(
                  "No such resource",
                  `Nothing named ${address.name} of kind ${address.kind} exists in space ${address.space}.`,
                  h("a", { class: "btn", ...linkProps("/resources") }, "Back to resources"),
                ),
              )
            : body(found, tab, page.reload),
        { retry: page.reload },
      ),
    ),
  );
}

function body(
  found: ResourceSummary,
  tab: ReturnType<typeof signal<"overview" | "spec" | "observed" | "identity">>,
  reload: () => void,
): Child {
  const state = health(found);
  return h(
    "div",
    { style: { display: "grid", gap: "18px" } },
    header(found, reload),
    h(
      "div",
      { class: "tabs" },
      ...(
        [
          ["overview", "Overview"],
          ["spec", "Declared"],
          ["observed", "Observed"],
          ["identity", "Form & identity"],
        ] as const
      ).map(([key, label]) =>
        h(
          "button",
          {
            class: "tab",
            type: "button",
            role: "tab",
            "aria-selected": tab() === key ? "true" : "false",
            onClick: () => tab.set(key),
          },
          label,
        ),
      ),
    ),
    tab() === "overview"
      ? overview(found, state)
      : tab() === "spec"
        ? card(
            "Declared spec",
            found.spec
              ? jsonBlock(found.spec)
              : empty("No spec recorded", "This resource was stored without a spec."),
          )
        : tab() === "observed"
          ? observed(found)
          : identity(found),
  );
}

function header(found: ResourceSummary, reload: () => void): Child {
  const state = health(found);
  return h(
    "div",
    { class: "head" },
    h(
      "div",
      { class: "head__text" },
      h(
        "div",
        { class: "dim", style: { fontSize: "12.5px", marginBottom: "4px" } },
        h("a", { ...linkProps("/resources") }, "Resources"),
        text(" / "),
        text(found.metadata.space),
      ),
      h(
        "h1",
        { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
        h("span", { class: "mono" }, found.metadata.name),
        badge(state.phase, state.tone, true),
        state.stale ? badge("declaration not yet applied", "accent") : null,
      ),
      h("p", null, `${found.kind} · ${found.apiVersion}`),
    ),
    h(
      "button",
      { class: "btn", type: "button", onClick: reload },
      icon(ICON.refresh, 14),
      text("Reload"),
    ),
  );
}

function overview(found: ResourceSummary, state: ReturnType<typeof health>): Child {
  const outputs = found.status?.outputs ?? {};
  const conditions = found.status?.conditions ?? [];
  return h(
    "div",
    { style: { display: "grid", gap: "14px" } },
    state.message
      ? h(
          "div",
          { class: state.tone === "bad" ? "notice notice--bad" : "notice notice--warn" },
          icon(ICON.alert),
          h(
            "div",
            null,
            h("strong", null, state.reason ?? state.phase),
            h("div", { style: { marginTop: "2px" } }, state.message),
          ),
        )
      : null,
    card(
      "Outputs",
      Object.keys(outputs).length === 0
        ? empty("No outputs", "This resource publishes nothing for other declarations to consume.")
        : h(
            "div",
            { class: "card__body" },
            h(
              "div",
              { class: "rows" },
              ...Object.entries(outputs).map(([key, value]) =>
                h(
                  "div",
                  { class: "row" },
                  h("div", { class: "row__label mono" }, key),
                  h(
                    "div",
                    { class: "row__value" },
                    typeof value === "string" ? copyable(value) : jsonBlock(value),
                  ),
                ),
              ),
            ),
          ),
    ),
    card(
      "Conditions",
      conditions.length === 0
        ? empty("No conditions", "The Host has not reported on this resource yet.")
        : h(
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
                  h("th", null, "Type"),
                  h("th", null, "Status"),
                  h("th", null, "Reason"),
                  h("th", null, "Message"),
                ),
              ),
              h(
                "tbody",
                null,
                ...conditions.map((condition) =>
                  h(
                    "tr",
                    null,
                    h("td", { class: "mono" }, condition.type),
                    h(
                      "td",
                      null,
                      badge(
                        condition.status,
                        condition.status === "True"
                          ? "ok"
                          : condition.status === "False"
                            ? "bad"
                            : "warn",
                      ),
                    ),
                    h("td", { class: "dim" }, condition.reason ?? "—"),
                    h("td", { class: "dim" }, condition.message ?? "—"),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

function observed(found: ResourceSummary): Child {
  const value = found.status?.observed;
  return card(
    "Observed state",
    value
      ? jsonBlock(value)
      : empty(
          "Nothing observed",
          "The Host has not read this resource back from the provider. That is normal while it is still being made.",
        ),
  );
}

/**
 * The exact-pin quad, spelled out.
 *
 * This is the part of Takoform that surprises people: identity includes the
 * digest of the schema the resource was created under, so an apparently
 * identical resource made yesterday may be a different Form. Showing the whole
 * quad — and letting it be copied — is what makes that legible instead of
 * mysterious.
 */
function identity(found: ResourceSummary): Child {
  const rows: readonly (readonly [string, Child])[] = [
    ["Kind", h("span", { class: "mono" }, found.kind)],
    ["API version", copyable(found.apiVersion)],
    ...(found.form
      ? ([
          [
            "Definition version",
            h(
              "span",
              null,
              h("span", { class: "mono" }, found.form.formRef.definitionVersion),
              h(
                "span",
                { class: "dim", style: { marginLeft: "8px" } },
                "the definition this resource was made under",
              ),
            ),
          ],
          [
            "Schema digest",
            h(
              "span",
              null,
              copyable(
                found.form.formRef.schemaDigest,
                shortDigest(found.form.formRef.schemaDigest),
              ),
              h(
                "div",
                { class: "dim", style: { marginTop: "2px" } },
                "part of the Form's identity: a different schema is a different Form",
              ),
            ),
          ],
        ] as const)
      : []),
    ["Space", h("span", { class: "mono" }, found.metadata.space)],
    ["Name", copyable(found.metadata.name)],
    ["UID", copyable(found.metadata.uid, shortDigest(found.metadata.uid))],
    [
      "Generation",
      h(
        "span",
        null,
        h("span", { class: "mono" }, found.metadata.generation),
        h(
          "span",
          { class: "dim", style: { marginLeft: "8px" } },
          "increments when the declaration changes",
        ),
      ),
    ],
    [
      "Revision",
      h(
        "span",
        null,
        h("span", { class: "mono" }, found.metadata.revision),
        h("span", { class: "dim", style: { marginLeft: "8px" } }, "the fence a write must present"),
      ),
    ],
    ["Last change", h("span", null, when(found.metadata.updatedAt))],
  ];

  return card(
    "Identity",
    h(
      "div",
      { class: "card__body" },
      h(
        "div",
        { class: "rows" },
        ...rows.map(([label, value]) =>
          h(
            "div",
            { class: "row" },
            h("div", { class: "row__label" }, label),
            h("div", { class: "row__value" }, value),
          ),
        ),
      ),
    ),
  );
}
