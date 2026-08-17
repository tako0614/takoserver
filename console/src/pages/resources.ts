import type { ResourceSummary } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { resource, signal } from "../reactive.ts";
import { health } from "../resource-state.ts";
import { linkProps, navigate, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { ago, badge, card, empty, ICON, icon, shortDigest, whenReady } from "../ui.ts";

/**
 * Everything the organization has declared.
 *
 * The columns answer the questions a person actually arrives with: is it
 * working, what is it, where does it live, and when did it last move. The Form
 * that produced it is one column over, because in an exact-pin protocol two
 * resources of the same kind are not necessarily the same thing.
 */
export function resourcesPage(organizationId: string): Child {
  const filter = signal("");
  const spaceFilter = signal("");
  const page = resource(() => api.resources(organizationId));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, "Resources"),
        h(
          "p",
          null,
          "Every resource this organization has declared through Takoform, with the state the Host last observed.",
        ),
      ),
      h(
        "button",
        { class: "btn", type: "button", onClick: page.reload },
        icon(ICON.refresh, 14),
        text("Reload"),
      ),
    ),
    live(() =>
      whenReady(
        page.get(),
        ({ resources, cursor }) => {
          if (resources.length === 0) {
            return card(
              null,
              empty(
                "Nothing declared yet",
                "Apply a resource with the Takoform provider or the CLI, and it will appear here the moment the Host accepts it.",
              ),
            );
          }
          const spaces = [...new Set(resources.map((entry) => entry.metadata.space))].sort();
          return h(
            "div",
            { style: { display: "grid", gap: "14px" } },
            toolbar(filter, spaceFilter, spaces),
            card(
              null,
              h(
                "div",
                { class: "table-scroll" },
                table(visible(resources, filter(), spaceFilter())),
              ),
            ),
            cursor
              ? h(
                  "div",
                  { class: "dim", style: { fontSize: "12.5px" } },
                  `Showing the first ${resources.length}. More pages exist.`,
                )
              : null,
          );
        },
        { retry: page.reload },
      ),
    ),
  );
}

function toolbar(
  filter: ReturnType<typeof signal<string>>,
  spaceFilter: ReturnType<typeof signal<string>>,
  spaces: readonly string[],
): Child {
  return h(
    "div",
    { class: "toolbar" },
    h("input", {
      class: "input",
      style: { maxWidth: "300px" },
      type: "search",
      placeholder: "Filter by name or kind",
      value: filter(),
      onInput: (event: Event) => filter.set((event.target as HTMLInputElement).value),
    }),
    spaces.length > 1
      ? h(
          "select",
          {
            class: "select",
            style: { maxWidth: "200px" },
            onChange: (event: Event) => spaceFilter.set((event.target as HTMLSelectElement).value),
          },
          h("option", { value: "" }, "All spaces"),
          ...spaces.map((space) =>
            h(
              "option",
              { value: space, ...(space === spaceFilter() ? { selected: true } : {}) },
              space,
            ),
          ),
        )
      : null,
  );
}

function visible(
  resources: readonly ResourceSummary[],
  needle: string,
  space: string,
): readonly ResourceSummary[] {
  const term = needle.trim().toLowerCase();
  return resources.filter((entry) => {
    if (space !== "" && entry.metadata.space !== space) return false;
    if (term === "") return true;
    return (
      entry.metadata.name.toLowerCase().includes(term) || entry.kind.toLowerCase().includes(term)
    );
  });
}

function table(resources: readonly ResourceSummary[]): Child {
  if (resources.length === 0) {
    return empty("No match", "Nothing here matches that filter.");
  }
  return h(
    "table",
    null,
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, "State"),
        h("th", null, "Name"),
        h("th", null, "Kind"),
        h("th", null, "Space"),
        h("th", null, "Form"),
        h("th", null, "Changed"),
      ),
    ),
    h("tbody", null, ...resources.map((entry) => row(entry))),
  );
}

function row(entry: ResourceSummary): Child {
  const state = health(entry);
  const href = resourcePath(entry.metadata.space, entry.kind, entry.metadata.name);
  return h(
    "tr",
    {
      class: "is-clickable",
      // The row is a shortcut; the name is the link. A click that lands on a
      // control inside the row belongs to that control, not to the row.
      onClick: (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, a")) return;
        navigate(href);
      },
    },
    h(
      "td",
      null,
      badge(state.phase, state.tone, true),
      state.stale ? h("span", { style: { marginLeft: "6px" } }, badge("changed", "accent")) : null,
    ),
    h("td", null, h("a", { class: "mono", ...linkProps(href) }, entry.metadata.name)),
    h("td", null, entry.kind),
    h("td", { class: "dim" }, entry.metadata.space),
    h(
      "td",
      { class: "dim mono", style: { fontSize: "12px" } },
      `${entry.apiVersion.split("/")[0] ?? entry.apiVersion} · ${shortDigest(entry.metadata.uid)}`,
    ),
    h("td", { class: "dim", title: entry.metadata.updatedAt }, ago(entry.metadata.updatedAt)),
  );
}
