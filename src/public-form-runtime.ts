import {
  createProviderDriver,
  createProviderFormAvailability,
  TAKOSERVER_INTRINSIC_HANDLER_KINDS,
} from "./provider-driver.ts";
import { CLOUDFLARE_TAKOFORM_HANDLER_KINDS, CloudflareProvider } from "./providers/cloudflare.ts";
import { createTakoformEngine } from "./takoform/engine.ts";

/**
 * One real executable seam shared by the public Worker and the build-only Form
 * payload entry. The payload build references these exact values, so changes to
 * provider dispatch or intrinsic lifecycle handling rotate its digest without
 * pulling unrelated HTTP, account, console, or discovery code into identity.
 */
export {
  CLOUDFLARE_TAKOFORM_HANDLER_KINDS,
  CloudflareProvider,
  createProviderDriver,
  createProviderFormAvailability,
  createTakoformEngine,
  TAKOSERVER_INTRINSIC_HANDLER_KINDS,
};

export const PUBLIC_FORM_RUNTIME_PAYLOAD = Object.freeze({
  CloudflareProvider,
  createProviderDriver,
  createProviderFormAvailability,
  createTakoformEngine,
});
