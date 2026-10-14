// Test-only boundary for a real entry-bun child. Never forward a Stripe
// Authorization header or permit this child to reach a non-loopback service.
import { appendFileSync } from "node:fs";

const stripeOrigin = process.env.AUTO_TEST_STRIPE_ORIGIN;
const auditPath = process.env.AUTO_TEST_PAYMENT_AUDIT;
const acceleratedMilliseconds = Number(process.env.AUTO_TEST_PAYMENT_INTERVAL_MS ?? "300000");
if (
  !stripeOrigin ||
  !/^http:\/\/127\.0\.0\.1:\d+$/u.test(stripeOrigin) ||
  !auditPath ||
  !Number.isSafeInteger(acceleratedMilliseconds) ||
  acceleratedMilliseconds < 20
) {
  throw new Error("isolated Stripe origin, timer audit, and positive interval required");
}

const originalFetch = globalThis.fetch;
const nativeFetch = originalFetch.bind(globalThis);
const interceptedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === "https://api.stripe.com" && url.pathname.startsWith("/v1/")) {
    const redirected = new Request(`${stripeOrigin}${url.pathname}${url.search}`, request);
    redirected.headers.delete("authorization");
    return await nativeFetch(redirected);
  }
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
    return await nativeFetch(request);
  }
  throw new Error("fixture refused non-loopback outbound fetch");
};
globalThis.fetch = Object.assign(interceptedFetch, { preconnect: originalFetch.preconnect });

const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = ((
  callback: (...args: unknown[]) => void,
  milliseconds?: number,
  ...args: unknown[]
) => {
  if (milliseconds !== 5 * 60_000) {
    return nativeSetInterval(callback, milliseconds, ...args);
  }
  // The production entry calls its normal pass owner. This seam only shortens
  // that exact existing registration, without invoking its callback ourselves.
  const stack = new Error().stack ?? "";
  if (!stack.includes("entry-bun.ts") || !stack.includes("selfhost-entry-shutdown.ts")) {
    throw new Error("unexpected five-minute interval registration");
  }
  appendFileSync(auditPath, "registered\n");
  return nativeSetInterval(
    (...callbackArgs: unknown[]) => {
      appendFileSync(auditPath, "tick\n");
      callback(...callbackArgs);
    },
    acceleratedMilliseconds,
    ...args,
  );
}) as typeof setInterval;
