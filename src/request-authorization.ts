/** Explicit credentials take precedence; cookies require the operator's exact console Origin. */
export function requestAuthorization(request: Request, consoleOrigin?: string): string | null {
  const header = request.headers.get("authorization");
  if (header) return header;
  if (!consoleOrigin || request.headers.get("origin") !== consoleOrigin) return null;
  const token = cookie(request, "takoserver_session");
  return token ? `Bearer ${token}` : null;
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}
