import { type Child, h, live } from "../dom.ts";
import { resource } from "../reactive.ts";
import { api } from "../state.ts";
import { badge, card, copyable, empty, money, shortDigest, whenReady } from "../ui.ts";

/**
 * What Takoserver sells, and the exact Form each offering executes.
 *
 * An offering is not just a price — it is a promise to execute one Form
 * definition, identified by its schema digest. Two offerings for the same kind
 * at the same price can still be different products, so the digest is on the
 * card rather than hidden behind a detail view.
 */
export function catalogPage(organizationId: string): Child {
  const catalog = resource(() => api.catalog(organizationId));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, "Catalog"),
        h(
          "p",
          null,
          "Everything this organization may provision, with the Form each offering executes and what it costs.",
        ),
      ),
    ),
    live(() =>
      whenReady(
        catalog.get(),
        ({ offerings }) =>
          offerings.length === 0
            ? card(null, empty("Nothing offered", "This organization has no offerings available."))
            : h(
                "div",
                { class: "grid" },
                ...offerings.map((offering) =>
                  card(
                    h(
                      "span",
                      { style: { display: "flex", alignItems: "center", gap: "8px" } },
                      offering.displayName,
                      badge(offering.kind, "accent"),
                    ),
                    h(
                      "div",
                      { class: "card__body" },
                      h(
                        "div",
                        { class: "stat__value", style: { fontSize: "20px" } },
                        `${money(offering.price.unitPriceMinor, offering.price.currency)}`,
                        h(
                          "span",
                          { class: "dim", style: { fontSize: "13px", fontWeight: "400" } },
                          ` / ${offering.price.unit}`,
                        ),
                      ),
                      h(
                        "div",
                        { class: "rows", style: { marginTop: "12px" } },
                        detail("Offering", copyable(offering.id)),
                        detail(
                          "Form",
                          h(
                            "span",
                            { class: "mono", style: { fontSize: "12px" } },
                            `${offering.form.kind} ${offering.form.definitionVersion}`,
                          ),
                        ),
                        detail(
                          "Schema digest",
                          copyable(
                            offering.form.schemaDigest,
                            shortDigest(offering.form.schemaDigest),
                          ),
                        ),
                        offering.protocols.length > 0
                          ? detail(
                              "Data protocols",
                              h(
                                "span",
                                { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                                ...offering.protocols.map((protocol) => badge(protocol)),
                              ),
                            )
                          : null,
                        offering.regions && offering.regions.length > 0
                          ? detail("Regions", offering.regions.join(", "))
                          : null,
                      ),
                    ),
                  ),
                ),
              ),
        { retry: catalog.reload },
      ),
    ),
  );
}

function detail(label: string, value: Child): Child {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row__label" }, label),
    h("div", { class: "row__value" }, value),
  );
}
