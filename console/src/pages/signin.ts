import type { IdentityProvider } from "../api.ts";
import { type Child, h, live } from "../dom.ts";
import { beginGoogleSignIn } from "../google.ts";
import { mark } from "../mark.ts";
import { type Resource, resource, signal } from "../reactive.ts";
import { adoptSession, api, apiOrigin, applyTheme, setApiOrigin, theme } from "../state.ts";
import { explain, ICON, icon, toast } from "../ui.ts";

/**
 * Signing in.
 *
 * One row, one decision. The screen shows what the server says it accepts and
 * nothing else: where a Google client is configured that is a single button,
 * and where it is not, it is the operator assertion — labelled as the operator
 * vouching by signature, because that is what it is.
 *
 * A console that renders "Continue with Google" against a deployment with no
 * Google client renders a button that fails, which is worse than an honest
 * text field.
 */

export function signInPage(): Child {
  const providers = resource(() => api.identityProviders());

  return h(
    "div",
    { class: "signin" },
    h(
      "div",
      { class: "signin__card" },
      h(
        "div",
        { class: "signin__brand" },
        mark(28),
        h("span", { class: "signin__brandtext" }, "takoserver"),
      ),
      h(
        "div",
        { class: "signin__panel" },
        h("h1", null, "Takoserver"),
        h(
          "p",
          { class: "signin__lede" },
          "Takoform で宣言したリソースと、前払いの残高を管理します。",
        ),
        live(() => wayIn(providers)),
        h(
          "p",
          { class: "signin__legal" },
          "続行すると、プロビジョニングした分の請求に同意したものとみなします。",
        ),
      ),
      themeSwitch(),
      endpointField(providers.reload),
    ),
  );
}

function wayIn(providers: Resource<{ providers: readonly IdentityProvider[] }>): Child {
  const state = providers.get();
  if (state.state === "loading") {
    return h("div", { class: "skeleton", style: { height: "50px" } });
  }
  if (state.state === "error") {
    return h("div", { class: "notice notice--bad" }, explain(state.error));
  }
  const google = state.value.providers.find((entry) => entry.method === "oidc");
  const operator = state.value.providers.find((entry) => entry.method === "operator-assertion");
  if (google?.clientId) return googleRow(google.clientId);
  if (operator) return operatorForm();
  return h(
    "div",
    { class: "notice notice--warn" },
    "この配備には ID プロバイダーが設定されていないため、まだ誰もサインインできません。",
  );
}

/**
 * The button, and only the button.
 *
 * Google's own rendered button is not used: it cannot be made to sit in this
 * layout, and it drags a third-party script into the page to do it. What
 * happens behind this row is the ordinary redirect, and the token it produces
 * is verified by the server exactly the same way.
 */
function googleRow(clientId: string): Child {
  const busy = signal(false);
  return live(() =>
    h(
      "button",
      {
        class: "rowbutton",
        type: "button",
        ...(busy() ? { disabled: true } : {}),
        onClick: () => {
          busy.set(true);
          beginGoogleSignIn(clientId, "/");
        },
      },
      h("span", { class: "rowbutton__glyph" }, googleGlyph()),
      h(
        "span",
        { class: "rowbutton__label" },
        busy() ? "Google に移動しています…" : "Google で続ける",
      ),
      h("span", { class: "rowbutton__chevron" }, icon(ICON.chevron, 15)),
    ),
  );
}

/** Google's mark, drawn rather than fetched. */
function googleGlyph(): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", "17");
  node.setAttribute("height", "17");
  node.setAttribute("aria-hidden", "true");
  const paths: readonly (readonly [string, string])[] = [
    [
      "#4285F4",
      "M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z",
    ],
    [
      "#34A853",
      "M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z",
    ],
    ["#FBBC05", "M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1Z"],
    [
      "#EA4335",
      "M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z",
    ],
  ];
  for (const [fill, d] of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", fill);
    path.setAttribute("d", d);
    node.append(path);
  }
  return node;
}

/**
 * The operator assertion.
 *
 * Shown only where no identity provider is configured, because it asks a person
 * to paste a token they had to produce elsewhere. It stays reachable on the
 * wire either way — it is how the operator gets in when the provider is
 * misconfigured, which is exactly when nobody can sign in the ordinary way.
 */
function operatorForm(): Child {
  const busy = signal(false);
  const assertion = h("textarea", {
    class: "textarea",
    placeholder: "Paste the assertion the operator signed",
    autocomplete: "off",
    spellcheck: "false",
  });

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (assertion.value.trim() === "") {
      toast("Paste an assertion first", "bad");
      return;
    }
    busy.set(true);
    try {
      const { sessionToken } = await api.signIn(
        "google",
        assertion.value.trim(),
        "operator-assertion",
      );
      adoptSession(sessionToken);
    } catch (error) {
      toast(explain(error as Error), "bad");
    } finally {
      busy.set(false);
    }
  };

  return h(
    "form",
    { style: { display: "grid", gap: "10px" }, onSubmit: submit },
    h(
      "div",
      { class: "field" },
      h("label", { for: "assertion" }, "Operator assertion"),
      assertion,
      h("small", null, "Signed offline by the operator key this deployment is configured with."),
    ),
    live(() =>
      h(
        "button",
        {
          class: "btn",
          type: "submit",
          style: { width: "100%" },
          ...(busy() ? { disabled: true } : {}),
        },
        busy() ? "Signing in…" : "Sign in with assertion",
      ),
    ),
  );
}

function themeSwitch(): Child {
  return live(() =>
    h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Appearance" },
      ...(
        [
          ["system", ICON.monitor, "System"],
          ["light", ICON.sun, "Light"],
          ["dark", ICON.moon, "Dark"],
        ] as const
      ).map(([value, glyph, label]) =>
        h(
          "button",
          {
            class: "segmented__item",
            type: "button",
            title: label,
            "aria-label": label,
            "aria-pressed": theme() === value ? "true" : "false",
            onClick: () => applyTheme(value),
          },
          icon(glyph, 15),
        ),
      ),
    ),
  );
}

/**
 * Where the API is.
 *
 * Folded away because almost nobody needs it, and kept because the console is a
 * static bundle that may be served from a laptop against a local server.
 */
function endpointField(reload: () => void): Child {
  const input = h("input", { class: "input", value: apiOrigin() });
  return h(
    "details",
    { class: "signin__endpoint" },
    h("summary", null, "API endpoint"),
    h(
      "div",
      { style: { display: "flex", gap: "8px", marginTop: "8px" } },
      input,
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: () => {
            setApiOrigin(input.value.trim());
            reload();
            toast("Endpoint updated", "ok");
          },
        },
        "Save",
      ),
    ),
  );
}
