import { tr } from "./i18n.ts";

const PENDING_KEY = "takoserver.takos-id.pending";
export const RETURN_PATH = "/auth/takos-id";

interface Pending {
  readonly issuer: string;
  readonly clientId: string;
  readonly state: string;
  readonly verifier: string;
  readonly from: string;
}

const random = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const challenge = async (verifier: string): Promise<string> =>
  bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

const exactIssuer = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("invalid Takos ID issuer");
  return value;
};

export async function beginTakosIdSignIn(
  issuerValue: string,
  clientId: string,
  from = "/",
): Promise<void> {
  const issuer = exactIssuer(issuerValue);
  const verifier = random();
  const pending: Pending = { issuer, clientId, state: random(), verifier, from };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${window.location.origin}${RETURN_PATH}`,
    response_type: "code",
    scope: "openid profile email organizations",
    state: pending.state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  window.location.assign(url.toString());
}

export type TakosIdReturnResult =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly idToken: string; readonly from: string }
  | { readonly kind: "error"; readonly message: string };

export async function readTakosIdReturn(): Promise<TakosIdReturnResult> {
  if (window.location.pathname !== RETURN_PATH) return { kind: "none" };
  const rawPending = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  const parameters = new URLSearchParams(window.location.search);
  window.history.replaceState({}, "", "/");

  let pending: Pending | null = null;
  try {
    pending = rawPending ? (JSON.parse(rawPending) as Pending) : null;
  } catch {
    pending = null;
  }
  if (!pending || parameters.get("state") !== pending.state) {
    return {
      kind: "error",
      message: tr(
        "このConsoleから開始したサインインではありません。やり直してください。",
        "That sign-in did not start here. Try again.",
      ),
    };
  }
  const providerFailure = parameters.get("error");
  if (providerFailure) {
    return {
      kind: "error",
      message:
        providerFailure === "access_denied"
          ? tr("サインインをキャンセルしました。", "Sign-in was cancelled.")
          : tr("Takos IDでサインインできませんでした。", "Takos ID could not sign you in."),
    };
  }
  const code = parameters.get("code");
  if (!code) {
    return {
      kind: "error",
      message: tr("Takos IDから応答がありませんでした。", "Takos ID returned no code."),
    };
  }
  let response: Response;
  try {
    response = await fetch(`${exactIssuer(pending.issuer)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: pending.clientId,
        redirect_uri: `${window.location.origin}${RETURN_PATH}`,
        code,
        code_verifier: pending.verifier,
      }),
    });
  } catch {
    return {
      kind: "error",
      message: tr("Takos IDに接続できません。", "Takos ID is unreachable."),
    };
  }
  const body = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!response.ok || typeof body?.id_token !== "string") {
    return {
      kind: "error",
      message: tr("Takos IDの応答を検証できません。", "Takos ID returned an invalid response."),
    };
  }
  return { kind: "ok", idToken: body.id_token, from: pending.from };
}
