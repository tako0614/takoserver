import { tr } from "./i18n.ts";

/**
 * Signing in with Google, without a script and without a secret.
 *
 * The browser is sent to Google, Google sends back an ID token in the URL
 * fragment, and the server verifies that token. There is no authorization code
 * and so no exchange, which is why this needs no client secret — the flow has
 * no step a secret would protect.
 *
 * Nothing of Google's is loaded into the page. That is not only a privacy
 * position: a sign-in that depends on a third-party script is a sign-in that
 * fails when that script does, and the button would be the last thing to admit
 * it.
 *
 * Two random values guard the round trip. `state` is checked when Google
 * returns, so a response the browser did not ask for is discarded — otherwise
 * a link could sign somebody into an account that is not theirs. `nonce` is
 * carried inside the token and checked by the server, binding the token to this
 * attempt rather than to any previous one.
 */

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const PENDING_KEY = "takoserver.google.pending";
/** Where Google returns to. Must be an authorized redirect URI on the client. */
export const RETURN_PATH = "/auth/google";

interface Pending {
  readonly state: string;
  readonly nonce: string;
  /** Where the person was before they were sent to Google. */
  readonly from: string;
}

function random(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function beginGoogleSignIn(clientId: string, from = "/"): void {
  const pending: Pending = { state: random(), nonce: random(), from };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${window.location.origin}${RETURN_PATH}`);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("nonce", pending.nonce);
  // The fragment never reaches a server, including ours: the token is read by
  // this page and posted deliberately.
  url.searchParams.set("response_mode", "fragment");
  // Someone signing in to a console is often not on their only account, and a
  // silent sign-in as the wrong one is worse than one extra click.
  url.searchParams.set("prompt", "select_account");
  window.location.assign(url.toString());
}

export interface GoogleReturn {
  readonly idToken: string;
  readonly nonce: string;
  readonly from: string;
}

export type GoogleReturnResult =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly value: GoogleReturn }
  | { readonly kind: "error"; readonly message: string };

/**
 * Reads what Google left in the fragment, once.
 *
 * The fragment is cleared whatever the outcome, so a reload cannot replay a
 * sign-in and the token does not sit in the address bar to be copied out of a
 * screenshot.
 */
export function readGoogleReturn(): GoogleReturnResult {
  if (window.location.pathname !== RETURN_PATH) return { kind: "none" };
  const fragment = window.location.hash.replace(/^#/u, "");
  const stored = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  const clear = (): void => {
    window.history.replaceState({}, "", "/");
  };

  if (fragment === "") {
    clear();
    return {
      kind: "error",
      message: tr("Googleから応答がありませんでした。", "Google returned nothing."),
    };
  }
  const params = new URLSearchParams(fragment);
  clear();

  const failure = params.get("error");
  if (failure) {
    return {
      kind: "error",
      message:
        failure === "access_denied"
          ? tr("サインインをキャンセルしました。", "Sign-in was cancelled.")
          : tr(`Googleが拒否しました: ${failure}`, `Google refused this: ${failure}`),
    };
  }

  const pending = stored ? (JSON.parse(stored) as Pending) : null;
  const idToken = params.get("id_token");
  if (!pending || !idToken) {
    return {
      kind: "error",
      message: tr(
        "このConsoleから開始したサインインではありません。やり直してください。",
        "That sign-in did not start here. Try again.",
      ),
    };
  }
  if (params.get("state") !== pending.state) {
    // A response the browser never asked for. Accepting it would sign this
    // person into whichever account the response names.
    return {
      kind: "error",
      message: tr(
        "このConsoleから開始したサインインではありません。やり直してください。",
        "That sign-in did not start here. Try again.",
      ),
    };
  }
  return { kind: "ok", value: { idToken, nonce: pending.nonce, from: pending.from } };
}
