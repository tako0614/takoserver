import type { IdentityProvider } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { beginGoogleSignIn } from "../google.ts";
import { consoleLocale, setConsoleLocale, tr } from "../i18n.ts";
import { mark } from "../mark.ts";
import { effect, type Resource, resource, signal, untrack } from "../reactive.ts";
import { route } from "../router.ts";
import {
  api,
  apiOrigin,
  applyTheme,
  captureSessionScope,
  normalizeApiOrigin,
  refreshSharedAuthAvailability,
  setApiOrigin,
  sharedAuthAvailable,
  sharedAuthProbeState,
  signInSession,
  storeSharedSessionReturnPath,
  theme,
} from "../state.ts";
import { beginTakosIdSignIn } from "../takos-id.ts";
import { explain, ICON, icon, setFieldError, toast } from "../ui.ts";

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
  untrack(() => {
    if (sharedAuthAvailable() === null && sharedAuthProbeState() === "idle") {
      void refreshSharedAuthAvailability();
    }
  });

  // Update translated copy in place via child effects so switching JA <-> EN
  // never remounts signInPage(), preserves focus on the language switch, keeps
  // any pasted assertion or open API endpoint disclosure, and avoids re-fetching providers.
  const lede = h("p", { class: "signin__lede" });
  effect(() => {
    lede.replaceChildren(
      text(
        tr(
          "Takoformで宣言したリソース、使用量、請求を管理します。",
          "Manage resources declared through Takoform, usage, and billing.",
        ),
      ),
    );
  });

  const legal = h("p", { class: "signin__legal" });
  effect(() => {
    legal.replaceChildren(
      text(
        tr(
          "続行すると、作成したリソースと使用量に応じた請求に同意したものとみなします。",
          "By continuing, you agree to charges for the resources and usage you create.",
        ),
      ),
    );
  });

  return h(
    "main",
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
        lede,
        sharedSessionRow(),
        live(() => wayIn(providers)),
        legal,
      ),
      themeSwitch(),
      languageSwitch(),
      endpointField(providers.reload),
    ),
  );
}

/** Build the fixed shared-auth entry URL from an API origin, with no query. */
export function sharedSessionLoginUrl(origin: string): string {
  const url = new URL(origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid shared-auth API origin");
  }
  return `${url.origin}/auth/oidc/login`;
}

function sharedSessionRow(): Child {
  const busy = signal(false);
  return live(() => {
    if (sharedAuthAvailable() !== true) return null;
    return h(
      "button",
      {
        class: "rowbutton",
        type: "button",
        ...(busy() ? { disabled: true } : {}),
        onClick: () => {
          try {
            const loginUrl = sharedSessionLoginUrl(apiOrigin());
            storeSharedSessionReturnPath(route().path);
            busy.set(true);
            window.location.assign(loginUrl);
          } catch (error) {
            busy.set(false);
            toast(explain(error as Error), "bad");
          }
        },
      },
      h("span", { class: "rowbutton__glyph" }, "T"),
      h(
        "span",
        { class: "rowbutton__label" },
        busy()
          ? tr("アカウントに移動しています…", "Opening your account…")
          : tr("Takosアカウントで続ける", "Continue with Takos account"),
      ),
      h("span", { class: "rowbutton__chevron" }, icon(ICON.chevron, 15)),
    );
  });
}

interface OperatorAssertionSignInClient {
  readonly signIn: (
    provider: string,
    assertion: string,
    method: "operator-assertion",
  ) => Promise<unknown>;
}

/**
 * Routes an operator assertion using the provider named in its payload.
 *
 * The payload is only a routing hint here. It is not trusted for identity, and
 * the API still verifies the Ed25519 signature and the provider claim before
 * creating a session. Refusing an assertion whose provider is not advertised
 * keeps a malformed paste from being sent to an arbitrary endpoint.
 */
export async function signInWithOperatorAssertion(
  client: OperatorAssertionSignInClient,
  providers: readonly IdentityProvider[],
  assertion: string,
): Promise<void> {
  const value = assertion.trim();
  const provider = operatorProviderFromAssertion(providers, value);
  if (provider === null) {
    throw new Error("operator assertion does not name an advertised provider");
  }
  await client.signIn(provider, value, "operator-assertion");
}

const MAX_OPERATOR_ASSERTION_CHARS = 8 * 1_024;

function operatorProviderFromAssertion(
  providers: readonly IdentityProvider[],
  assertion: string,
): string | null {
  if (assertion === "" || assertion.length > MAX_OPERATOR_ASSERTION_CHARS) return null;
  const [payloadPart, signaturePart, ...rest] = assertion.split(".");
  if (!payloadPart || !signaturePart || rest.length > 0) return null;

  let payload: string;
  try {
    const normalized = payloadPart.replaceAll("-", "+").replaceAll("_", "/");
    payload = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  } catch {
    return null;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const provider = (claims as { readonly provider?: unknown }).provider;
  if (typeof provider !== "string" || provider === "") return null;
  return providers.some((entry) => entry.method === "operator-assertion" && entry.id === provider)
    ? provider
    : null;
}

function signInLoadingBar(): HTMLElement {
  return h(
    "div",
    { role: "status", "aria-busy": "true" },
    h("span", { class: "visually-hidden" }, tr("読み込み中…", "Loading…")),
    h("div", { class: "skeleton", "aria-hidden": "true", style: { height: "50px" } }),
  );
}

function wayIn(providers: Resource<{ providers: readonly IdentityProvider[] }>): Child {
  const state = providers.get();
  if (state.state === "loading") {
    return signInLoadingBar();
  }
  if (state.state === "error") {
    return h(
      "div",
      {
        class: "notice notice--bad",
        role: "alert",
        style: { display: "grid", gap: "10px", justifyItems: "start" },
      },
      h("span", null, explain(state.error)),
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: () => {
            void refreshSharedAuthAvailability(true);
            providers.reload();
          },
        },
        tr("再試行", "Retry"),
      ),
    );
  }
  const takosId = state.value.providers.find(
    (entry) => entry.id === "takos-id" && entry.method === "oidc",
  );
  const google = state.value.providers.find(
    (entry) => entry.id === "google" && entry.method === "oidc",
  );
  const operators = state.value.providers.filter((entry) => entry.method === "operator-assertion");
  if (takosId?.clientId && takosId.issuer) return takosIdRow(takosId.issuer, takosId.clientId);
  if (google?.clientId) return googleRow(google.clientId);
  if (operators.length > 0) return operatorForm(operators);
  if (sharedAuthAvailable() === true) return null;
  if (sharedAuthAvailable() === null && sharedAuthProbeState() === "loading") {
    return signInLoadingBar();
  }
  if (sharedAuthAvailable() === null && sharedAuthProbeState() === "error") {
    return h(
      "div",
      {
        class: "notice notice--warn",
        role: "alert",
        style: { display: "grid", gap: "10px", justifyItems: "start" },
      },
      h(
        "span",
        null,
        tr(
          "サインイン方法を確認できませんでした。接続を確認して再試行してください。",
          "Couldn't check sign-in availability. Check your connection and try again.",
        ),
      ),
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: () => {
            void refreshSharedAuthAvailability(true);
            providers.reload();
          },
        },
        tr("再試行", "Retry"),
      ),
    );
  }
  return h(
    "div",
    { class: "notice notice--warn" },
    tr(
      "この環境にはIDプロバイダーが設定されていないため、まだサインインできません。",
      "No identity provider is configured for this environment, so nobody can sign in yet.",
    ),
  );
}

function takosIdRow(issuer: string, clientId: string): Child {
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
          void beginTakosIdSignIn(issuer, clientId, "/").catch((error: unknown) => {
            busy.set(false);
            toast(explain(error as Error), "bad");
          });
        },
      },
      h("span", { class: "rowbutton__glyph" }, "T"),
      h(
        "span",
        { class: "rowbutton__label" },
        busy()
          ? tr("Takos IDに移動しています…", "Opening Takos ID…")
          : tr("Takos IDで続ける", "Continue with Takos ID"),
      ),
      h("span", { class: "rowbutton__chevron" }, icon(ICON.chevron, 15)),
    ),
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
        busy()
          ? tr("Googleに移動しています…", "Opening Google…")
          : tr("Googleで続ける", "Continue with Google"),
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
 *
 * The deployment may verify an operator assertion for more than one provider,
 * so the form routes from the provider claim in the pasted payload rather than
 * silently choosing the first descriptor. That claim is only a routing hint;
 * the server verifies the signature and provider before accepting it.
 */
function operatorForm(providers: readonly IdentityProvider[]): Child {
  const busy = signal(false);
  const activeError = signal<(() => string) | null>(null);
  const hintIds = ["assertion-hint"];
  const assertionError = h("div", {
    class: "field__error",
    id: "assertion-error",
    hidden: true,
  });
  const showError = (describe: (() => string) | null): void => {
    activeError.set(describe);
    setFieldError(assertion, assertionError, describe ? describe() : null, hintIds);
  };
  const assertion = h("textarea", {
    id: "assertion",
    name: "assertion",
    class: "textarea",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": "assertion-hint",
    onInput: () => {
      showError(null);
    },
  });
  const label = h("label", { for: "assertion" });
  const hint = h("small", { id: "assertion-hint" });
  const submitButton = h("button", {
    class: "btn",
    type: "submit",
    style: { width: "100%" },
  });
  effect(() => {
    consoleLocale();
    const describe = untrack(activeError);
    if (describe) setFieldError(assertion, assertionError, describe(), hintIds);
  });
  effect(() => {
    label.replaceChildren(text(tr("運営者assertion", "Operator assertion")));
    assertion.setAttribute(
      "placeholder",
      tr(
        "運営者が署名したassertionを貼り付けてください",
        "Paste the assertion the operator signed",
      ),
    );
    hint.replaceChildren(
      text(
        tr(
          "この環境に設定された運営者キーでオフライン署名されたものです。",
          "Signed offline by the operator key this deployment is configured with.",
        ),
      ),
    );
    const sending = busy();
    submitButton.disabled = sending;
    submitButton.replaceChildren(
      text(
        sending
          ? tr("サインインしています…", "Signing in…")
          : tr("assertionでサインイン", "Sign in with assertion"),
      ),
    );
  });

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (busy()) return;
    if (assertion.value.trim() === "") {
      // Said beside the field, not only in a passing toast, and the caret goes
      // where the paste belongs.
      showError(() => tr("assertionを貼り付けてください", "Paste an assertion first"));
      assertion.focus?.();
      return;
    }
    showError(null);
    busy.set(true);
    const isCurrent = captureSessionScope();
    try {
      await signInWithOperatorAssertion(
        { signIn: signInSession },
        providers,
        assertion.value.trim(),
      );
    } catch (error) {
      if (isCurrent()) {
        const describeError =
          error instanceof Error &&
          error.message === "operator assertion does not name an advertised provider"
            ? () =>
                tr(
                  "assertionの形式が正しくないか、この環境で有効なプロバイダーと一致しません。",
                  "The assertion format is invalid or does not match an advertised provider for this environment.",
                )
            : () => explain(error as Error);
        // The refusal stays beside the field until the assertion changes, so it
        // can still be read after the toast has gone.
        showError(describeError);
        assertion.focus?.();
      }
    } finally {
      busy.set(false);
    }
  };

  return h(
    "form",
    { style: { display: "grid", gap: "10px" }, onSubmit: submit },
    h("div", { class: "field" }, label, assertion, assertionError, hint),
    submitButton,
  );
}

function themeSwitch(): Child {
  const items = (
    [
      ["system", ICON.monitor, () => tr("システム", "System")],
      ["light", ICON.sun, () => tr("ライト", "Light")],
      ["dark", ICON.moon, () => tr("ダーク", "Dark")],
    ] as const
  ).map(([value, glyph, label]) => {
    const button = h(
      "button",
      {
        class: "segmented__item",
        type: "button",
        onClick: () => applyTheme(value),
      },
      icon(glyph, 15),
    );
    effect(() => {
      const name = label();
      button.setAttribute("title", name);
      button.setAttribute("aria-label", name);
      button.setAttribute("aria-pressed", theme() === value ? "true" : "false");
    });
    return button;
  });
  const group = h("div", { class: "segmented", role: "group" }, ...items);
  effect(() => {
    group.setAttribute("aria-label", tr("表示", "Appearance"));
  });
  return group;
}

function languageSwitch(): Child {
  const items = (["ja", "en"] as const).map((option) => {
    const button = h(
      "button",
      {
        class: "segmented__item",
        type: "button",
        title: option === "ja" ? "日本語" : "English",
        onClick: () => setConsoleLocale(option),
      },
      // The visible code is part of the name (WCAG 2.5.3), so voice control
      // users can say what they see; the full name follows for screen readers.
      h("span", { "aria-hidden": "true" }, option === "ja" ? "JA" : "EN"),
      h(
        "span",
        { class: "visually-hidden", lang: option },
        option === "ja" ? "JA 日本語" : "EN English",
      ),
    );
    effect(() => {
      button.setAttribute("aria-pressed", consoleLocale() === option ? "true" : "false");
    });
    return button;
  });
  const group = h("div", { class: "segmented", role: "group" }, ...items);
  effect(() => {
    group.setAttribute("aria-label", tr("言語", "Language"));
  });
  return group;
}

/**
 * Where the API is.
 *
 * Folded away because almost nobody needs it, and kept because the console is a
 * static bundle that may be served from a laptop against a local server.
 */
function endpointField(reload: () => void): Child {
  const activeError = signal<(() => string) | null>(null);
  const originError = h("div", {
    class: "field__error",
    id: "signin-api-origin-error",
    hidden: true,
  });
  const showError = (describe: (() => string) | null): void => {
    activeError.set(describe);
    setFieldError(input, originError, describe ? describe() : null);
  };
  const save = (): void => {
    const normalized = normalizeApiOrigin(input.value);
    if (!normalized) {
      const describeError = () =>
        tr(
          "有効なHTTP(S)オリジンを入力してください（例: https://api.example.com）",
          "Enter a valid HTTP(S) origin (for example, https://api.example.com)",
        );
      showError(describeError);
      input.focus?.();
      toast(describeError(), "bad");
      return;
    }
    showError(null);
    input.value = normalized;
    setApiOrigin(normalized);
    void refreshSharedAuthAvailability(true);
    reload();
    toast(tr("接続先を更新しました", "Endpoint updated"), "ok");
  };
  const input = h("input", {
    class: "input",
    id: "signin-api-origin",
    name: "apiOrigin",
    type: "url",
    autocomplete: "off",
    spellcheck: "false",
    value: untrack(apiOrigin),
    onInput: () => {
      if (normalizeApiOrigin(input.value)) showError(null);
    },
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        save();
      }
    },
  });
  effect(() => {
    consoleLocale();
    const describe = untrack(activeError);
    if (describe) setFieldError(input, originError, describe());
  });
  const summary = h("summary");
  const label = h("label", { for: "signin-api-origin", class: "visually-hidden" });
  const saveButton = h("button", { class: "btn", type: "button", onClick: save });
  effect(() => {
    const title = tr("API接続先", "API endpoint");
    summary.replaceChildren(text(title));
    label.replaceChildren(text(title));
    saveButton.replaceChildren(text(tr("保存", "Save")));
  });
  return h(
    "details",
    { class: "signin__endpoint" },
    summary,
    h(
      "div",
      { class: "field", style: { marginTop: "8px" } },
      label,
      h("div", { style: { display: "flex", gap: "8px" } }, input, saveButton),
      originError,
    ),
  );
}
