import type { IdentityProvider } from "../api.ts";
import { type Child, h, live } from "../dom.ts";
import { mark } from "../mark.ts";
import { resource, signal } from "../reactive.ts";
import { adoptSession, api, apiOrigin, setApiOrigin } from "../state.ts";
import { explain, toast } from "../ui.ts";

/**
 * Signing in.
 *
 * The screen shows what the server says it accepts, and nothing else. Where a
 * Google client is configured that is a Google button; where it is not, it is
 * the operator assertion, labelled as what it is. A console that renders a
 * "Continue with Google" button against a deployment with no Google client
 * renders a button that fails, which is worse than an honest text field.
 */

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";

export function signInPage(): Child {
  const providers = resource(() => api.identityProviders());

  return h(
    "div",
    { class: "signin" },
    h(
      "div",
      { class: "signin__card" },
      h("div", { class: "signin__mark" }, mark(56)),
      h("h1", null, "Sign in to Takoserver"),
      h("p", { class: "signin__lede" }, "Takoform resources, keys, and prepaid billing."),
      live(() => {
        const state = providers.get();
        if (state.state === "loading") {
          return h("div", { class: "signin__panel" }, h("div", { class: "skeleton" }));
        }
        if (state.state === "error") {
          return h(
            "div",
            { class: "signin__panel" },
            h("div", { class: "notice notice--bad" }, explain(state.error)),
            endpointField(providers.reload),
          );
        }
        const google = state.value.providers.find((entry) => entry.method === "oidc");
        const operator = state.value.providers.find(
          (entry) => entry.method === "operator-assertion",
        );
        if (!google && !operator) {
          return h(
            "div",
            { class: "signin__panel" },
            h(
              "div",
              { class: "notice notice--warn" },
              "This deployment has no identity provider configured, so nobody can sign in yet.",
            ),
            endpointField(providers.reload),
          );
        }
        return h(
          "div",
          { class: "signin__panel" },
          google ? googleButton(google) : null,
          google && operator ? h("div", { class: "signin__divider" }, "or") : null,
          operator ? operatorForm() : null,
          endpointField(providers.reload),
        );
      }),
      h(
        "p",
        { class: "signin__foot" },
        "By signing in you agree to be billed for what you provision.",
      ),
    ),
  );
}

/**
 * Google's own button, rendered by Google's own script.
 *
 * The token never passes through anything of ours before the server sees it,
 * and the server verifies its signature, issuer, audience and expiry rather
 * than believing the browser. What arrives here is only ever forwarded.
 */
function googleButton(provider: IdentityProvider): Child {
  const host = h("div", {
    style: { display: "grid", justifyContent: "center", minHeight: "44px" },
  });
  const busy = signal(false);

  const start = (): void => {
    const google = (
      window as unknown as {
        google?: {
          accounts: {
            id: {
              initialize(config: Record<string, unknown>): void;
              renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
            };
          };
        };
      }
    ).google;
    if (!google || !provider.clientId) {
      host.replaceChildren(
        h(
          "div",
          { class: "notice notice--warn" },
          "Google sign-in could not load. Check that this page is allowed to reach accounts.google.com.",
        ),
      );
      return;
    }
    google.accounts.id.initialize({
      client_id: provider.clientId,
      callback: (response: { credential?: string }) => {
        if (!response.credential) {
          toast("Google returned no credential", "bad");
          return;
        }
        busy.set(true);
        api
          .signIn("google", response.credential, "oidc")
          .then(
            ({ sessionToken }) => adoptSession(sessionToken),
            (error: unknown) => toast(explain(error as Error), "bad"),
          )
          .finally(() => busy.set(false));
      },
      auto_select: false,
      // A person who signed out meant it; offering to sign them straight back
      // in is how a sign-out button stops working.
      cancel_on_tap_outside: true,
    });
    google.accounts.id.renderButton(host, {
      type: "standard",
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      width: 340,
    });
  };

  if (document.querySelector(`script[src="${GOOGLE_SCRIPT}"]`)) {
    queueMicrotask(start);
  } else {
    const script = h("script", { src: GOOGLE_SCRIPT, async: true, defer: true });
    script.addEventListener("load", start);
    script.addEventListener("error", () =>
      host.replaceChildren(
        h("div", { class: "notice notice--warn" }, "Google sign-in could not be loaded."),
      ),
    );
    document.head.append(script);
  }

  return host;
}

/**
 * The operator assertion.
 *
 * Kept because a deployment with no Google client still has to let its operator
 * in — including the first time, before anyone exists to be signed in as.
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
    null,
    h("summary", { class: "dim", style: { fontSize: "12px", cursor: "pointer" } }, "API endpoint"),
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
