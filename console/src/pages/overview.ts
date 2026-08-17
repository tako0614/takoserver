import type { Organization } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { resource } from "../reactive.ts";
import { byKind, health } from "../resource-state.ts";
import { linkProps, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { ago, badge, card, copyable, empty, ICON, icon, money, stat, whenReady } from "../ui.ts";

/**
 * The first screen, answering the two questions someone signs in with: is
 * anything broken, and can I still pay for it.
 *
 * Everything else on this page is a shortcut. Nothing is summarised in a way
 * that could hide a failure — a kind with something failing says so on the
 * tile rather than only in the list one click away.
 */
export function overviewPage(organization: Organization): Child {
  const wallet = resource(() => api.wallet(organization.id));
  const resources = resource(() => api.resources(organization.id));
  const operations = resource(() => api.operations(organization.id));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, organization.name),
        h("p", null, "Takoform resources, prepaid balance, and what changed recently."),
      ),
    ),
    live(() =>
      h(
        "div",
        { class: "grid" },
        whenReady(
          wallet.get(),
          ({ wallet: held }) =>
            h(
              "div",
              { style: { display: "contents" } },
              stat(
                "Available",
                money(held.availableMinor, held.currency),
                held.heldMinor > 0
                  ? `${money(held.heldMinor, held.currency)} held against live work`
                  : "nothing held",
              ),
              stat("Settled", money(held.settledMinor, held.currency), "credited and captured"),
            ),
          { skeleton: h("div", { class: "card" }, h("div", { class: "card__body skeleton" })) },
        ),
        whenReady(
          resources.get(),
          ({ resources: all }) => {
            const failing = all.filter((entry) => health(entry).phase === "Failed").length;
            return stat(
              "Resources",
              String(all.length),
              failing === 0
                ? "all reporting healthy"
                : h("span", { style: { color: "var(--bad)" } }, `${failing} failing`),
            );
          },
          { skeleton: h("div", { class: "card" }, h("div", { class: "card__body skeleton" })) },
        ),
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all }) =>
          all.length === 0
            ? card(
                "Resources",
                empty(
                  "Nothing declared yet",
                  "Point the Takoform provider at this organization and apply a declaration. Whatever the Host accepts shows up here.",
                ),
              )
            : card(
                "By kind",
                h(
                  "div",
                  { class: "card__body" },
                  h(
                    "div",
                    { class: "grid" },
                    ...byKind(all).map((entry) =>
                      h(
                        "a",
                        {
                          class: "card",
                          style: { display: "block" },
                          ...linkProps(`/resources?kind=${encodeURIComponent(entry.kind)}`),
                        },
                        h(
                          "div",
                          { class: "card__body" },
                          h("div", { class: "stat__label" }, entry.kind),
                          h("div", { class: "stat__value" }, String(entry.total)),
                          entry.failing > 0
                            ? h(
                                "div",
                                { style: { marginTop: "6px" } },
                                badge(`${entry.failing} failing`, "bad", true),
                              )
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
                h(
                  "a",
                  { class: "btn btn--sm", ...linkProps("/resources") },
                  text("View all"),
                  icon(ICON.chevron, 13),
                ),
              ),
        { retry: resources.reload },
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all }) => {
          const attention = all.filter((entry) => {
            const state = health(entry);
            return state.phase === "Failed" || state.stale;
          });
          if (attention.length === 0) return h("div", { style: { display: "none" } });
          return card(
            "Needs attention",
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
                    h("th", null, "Resource"),
                    h("th", null, "State"),
                    h("th", null, "Why"),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  ...attention.slice(0, 8).map((entry) => {
                    const state = health(entry);
                    return h(
                      "tr",
                      null,
                      h(
                        "td",
                        null,
                        h(
                          "a",
                          {
                            class: "mono",
                            ...linkProps(
                              resourcePath(entry.metadata.space, entry.kind, entry.metadata.name),
                            ),
                          },
                          entry.metadata.name,
                        ),
                      ),
                      h("td", null, badge(state.phase, state.tone, true)),
                      h(
                        "td",
                        { class: "dim" },
                        state.message ??
                          (state.stale ? "the latest declaration has not been applied" : "—"),
                      ),
                    );
                  }),
                ),
              ),
            ),
          );
        },
        { skeleton: h("div", { style: { display: "none" } }) },
      ),
    ),
    live(() =>
      whenReady(
        operations.get(),
        ({ operations: all }) =>
          all.length === 0
            ? h("div", { style: { display: "none" } })
            : card(
                "Recent operations",
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
                        h("th", null, "Operation"),
                        h("th", null, "Result"),
                        h("th", null, "When"),
                        h("th", null, "Id"),
                      ),
                    ),
                    h(
                      "tbody",
                      null,
                      ...all
                        .slice(0, 10)
                        .map((entry) =>
                          h(
                            "tr",
                            null,
                            h("td", { class: "mono" }, entry.operation),
                            h(
                              "td",
                              null,
                              badge(entry.state, entry.state === "succeeded" ? "ok" : "bad"),
                            ),
                            h("td", { class: "dim" }, ago(entry.createdAt)),
                            h("td", null, copyable(entry.id)),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
        { skeleton: h("div", { style: { display: "none" } }) },
      ),
    ),
  );
}
