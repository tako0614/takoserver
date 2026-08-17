import { type Child, h, live, text } from "../dom.ts";
import { resource, signal } from "../reactive.ts";
import { adoptSession, api, apiOrigin, setApiOrigin } from "../state.ts";
import { explain, ICON, icon, toast } from "../ui.ts";

/**
 * Signing in.
 *
 * Takoserver does not verify identity itself. Today the operator vouches: they
 * sign an assertion offline, and the server accepts exactly what that signature
 * says. That is an interim, and this screen says so rather than dressing it up
 * as a login — a console that shows a "Continue with Google" button wired to
 * something that cannot work is worse than one that explains the situation.
 *
 * When a real identity provider is configured, the provider list this screen
 * already reads is where those buttons will come from.
 */
export function signInPage(): Child {
  const providers = resource(() => api.identityProviders());
  const busy = signal(false);
  const provider = signal("google");

  const assertion = h("textarea", {
    class: "textarea",
    placeholder: "Paste the sign-in assertion issued for your account",
    autocomplete: "off",
    spellcheck: "false",
  });

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (assertion.value.trim() === "") {
      toast("Paste a sign-in assertion", "bad");
      return;
    }
    busy.set(true);
    try {
      const { sessionToken } = await api.signIn(provider(), assertion.value.trim());
      adoptSession(sessionToken);
    } catch (error) {
      toast(explain(error as Error), "bad");
    } finally {
      busy.set(false);
    }
  };

  return h(
    "div",
    { class: "signin" },
    h(
      "form",
      { class: "signin__card", onSubmit: submit },
      h(
        "div",
        { class: "signin__brand" },
        h("span", { class: "brand__mark" }, icon(ICON.layers, 15)),
        text("Takoserver"),
      ),
      h(
        "p",
        { class: "dim", style: { margin: "0", fontSize: "13px" } },
        "Sign in to manage Takoform resources, keys, and billing.",
      ),
      live(() => {
        const state = providers.get();
        const available =
          state.state === "ready" ? state.value.providers : (["google", "github"] as const);
        return h(
          "div",
          { class: "field" },
          h("label", { for: "provider" }, "Identity provider"),
          h(
            "select",
            {
              class: "select",
              id: "provider",
              onChange: (event: Event) => provider.set((event.target as HTMLSelectElement).value),
            },
            ...available.map((name) =>
              h(
                "option",
                { value: name, ...(name === provider() ? { selected: true } : {}) },
                name,
              ),
            ),
          ),
        );
      }),
      h(
        "div",
        { class: "field" },
        h("label", { for: "assertion" }, "Sign-in assertion"),
        assertion,
        h(
          "small",
          null,
          "Takoserver has no identity provider configured yet, so sign-in is by an assertion the operator signs. Browser sign-in arrives with the provider.",
        ),
      ),
      live(() =>
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "submit",
            style: { width: "100%" },
            ...(busy() ? { disabled: true } : {}),
          },
          busy() ? "Signing in…" : "Sign in",
        ),
      ),
      live(() => {
        const input = h("input", { class: "input", value: apiOrigin() });
        return h(
          "details",
          null,
          h(
            "summary",
            { class: "dim", style: { fontSize: "12.5px", cursor: "pointer" } },
            "API endpoint",
          ),
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
                  providers.reload();
                  toast("Endpoint updated", "ok");
                },
              },
              "Save",
            ),
          ),
        );
      }),
    ),
  );
}
