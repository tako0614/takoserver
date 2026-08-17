import type { Organization } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import {
  apiOrigin,
  applyTheme,
  principal,
  setApiOrigin,
  signOut,
  type Theme,
  theme,
} from "../state.ts";
import { card, copyable, ICON, icon, toast, when } from "../ui.ts";

/**
 * The account, the organization, and where this console is pointed.
 *
 * The API origin is settable because the console is a static bundle that may
 * be served from anywhere — including a laptop, against a local server. A
 * console that can only ever talk to one host is a console you cannot develop
 * against.
 */
export function settingsPage(organization: Organization): Child {
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, "Settings"),
        h("p", null, "Who you are signed in as, and what this console is talking to."),
      ),
    ),
    card(
      "Organization",
      h(
        "div",
        { class: "card__body" },
        h(
          "div",
          { class: "rows" },
          row("Name", organization.name),
          row("Identifier", copyable(organization.id)),
          row("Created", when(organization.createdAt)),
          row(
            "Tenant",
            h(
              "span",
              { class: "dim" },
              "Resources are isolated by this organization; its identifier is the tenant key the Takoform Host uses.",
            ),
          ),
        ),
      ),
    ),
    live(() => {
      const who = principal();
      return card(
        "Account",
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "rows" },
            row("Signed in as", who ? who.displayName : "—"),
            row("Email", who ? who.email : "—"),
            row("Identity provider", who ? who.provider : "—"),
            row("Principal", who ? copyable(who.id) : "—"),
          ),
          h(
            "div",
            { style: { marginTop: "16px" } },
            h(
              "button",
              { class: "btn btn--danger", type: "button", onClick: signOut },
              icon(ICON.out, 14),
              text("Sign out"),
            ),
          ),
        ),
      );
    }),
    live(() =>
      card(
        "Appearance",
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "toolbar" },
            ...(["system", "light", "dark"] as const).map((option) =>
              h(
                "button",
                {
                  class: theme() === option ? "btn btn--primary" : "btn",
                  type: "button",
                  onClick: () => applyTheme(option as Theme),
                },
                option,
              ),
            ),
          ),
        ),
      ),
    ),
    live(() => {
      const input = h("input", { class: "input", value: apiOrigin() });
      return card(
        "API endpoint",
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "field" },
            h("label", null, "Origin"),
            h(
              "div",
              { style: { display: "flex", gap: "8px" } },
              input,
              h(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onClick: () => {
                    setApiOrigin(input.value.trim());
                    toast("Endpoint updated", "ok");
                  },
                },
                "Save",
              ),
            ),
            h(
              "small",
              null,
              "Every request from this console goes here. Changing it does not move any data.",
            ),
          ),
        ),
      );
    }),
  );
}

function row(label: string, value: Child): Child {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row__label" }, label),
    h("div", { class: "row__value" }, value),
  );
}
