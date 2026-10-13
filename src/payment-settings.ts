/**
 * The operator's payment settings: amounts and windows, never constants.
 *
 * Kept free of imports so the Bun entry, the Worker entry and the deploy
 * target validate the same names against the same bounds. A value outside its
 * bounds refuses startup (or the deploy) rather than charging an amount the
 * operator did not write.
 */

/** Every amount and window here is configuration, never a constant a deployment is stuck with. */
export interface PaymentSettings {
  /** Smallest single Checkout payment, in minor units. */
  readonly checkoutMinimumMinor?: number;
  /** Largest single Checkout payment, in minor units. */
  readonly checkoutMaximumMinor?: number;
  /** How far a webhook's signed timestamp may be from this Host's clock. */
  readonly webhookToleranceSeconds?: number;
  /** How far back the reconcile pass looks for completed Checkout Sessions. */
  readonly reconcileLookbackSeconds?: number;
}

/** Defaults: a payment small enough to be a mistake, or large enough to be one. */
export const DEFAULT_CHECKOUT_MINIMUM_MINOR = 500;
export const DEFAULT_CHECKOUT_MAXIMUM_MINOR = 1_000_000;
/** Stripe's own limits for a USD Checkout line, which no setting may exceed. */
const STRIPE_USD_MINIMUM_MINOR = 50;
const STRIPE_USD_MAXIMUM_MINOR = 99_999_999;

/** Environment names, shared by the Bun entry, the Worker entry and the deploy target. */
export const PAYMENT_SETTING_VARIABLES = {
  checkoutMinimumMinor: "TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR",
  checkoutMaximumMinor: "TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR",
  webhookToleranceSeconds: "TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS",
  reconcileLookbackSeconds: "TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS",
} as const satisfies Record<keyof PaymentSettings, string>;

const SETTING_BOUNDS: Readonly<
  Record<keyof PaymentSettings, { readonly minimum: number; readonly maximum: number }>
> = {
  checkoutMinimumMinor: { minimum: STRIPE_USD_MINIMUM_MINOR, maximum: STRIPE_USD_MAXIMUM_MINOR },
  checkoutMaximumMinor: { minimum: STRIPE_USD_MINIMUM_MINOR, maximum: STRIPE_USD_MAXIMUM_MINOR },
  webhookToleranceSeconds: { minimum: 1, maximum: 3_600 },
  reconcileLookbackSeconds: { minimum: 3_600, maximum: 30 * 24 * 60 * 60 },
};

export class PaymentSettingsError extends Error {
  constructor(readonly setting: string) {
    super(`${setting} is not a valid payment setting`);
    this.name = "PaymentSettingsError";
  }
}

/**
 * Reads the payment settings from environment text. Blank is unset; anything
 * else must be a whole number inside its bounds, or startup is refused rather
 * than silently charging a different amount than the operator wrote.
 */
export function paymentSettingsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): PaymentSettings {
  const settings: Record<string, number> = {};
  for (const [setting, variable] of Object.entries(PAYMENT_SETTING_VARIABLES)) {
    const raw = environment[variable]?.trim();
    if (!raw) continue;
    if (!/^[0-9]{1,12}$/u.test(raw)) throw new PaymentSettingsError(variable);
    settings[setting] = Number(raw);
  }
  return validatePaymentSettings(settings as PaymentSettings, (setting) => {
    return PAYMENT_SETTING_VARIABLES[setting];
  });
}

/** Checks bounds and the minimum/maximum order; names the offending setting. */
export function validatePaymentSettings(
  settings: PaymentSettings,
  name: (setting: keyof PaymentSettings) => string = (setting) => setting,
): PaymentSettings {
  for (const setting of Object.keys(SETTING_BOUNDS) as (keyof PaymentSettings)[]) {
    const value = settings[setting];
    if (value === undefined) continue;
    const { minimum, maximum } = SETTING_BOUNDS[setting];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new PaymentSettingsError(name(setting));
    }
  }
  const minimum = settings.checkoutMinimumMinor ?? DEFAULT_CHECKOUT_MINIMUM_MINOR;
  const maximum = settings.checkoutMaximumMinor ?? DEFAULT_CHECKOUT_MAXIMUM_MINOR;
  if (minimum > maximum) {
    throw new PaymentSettingsError(
      name(
        settings.checkoutMinimumMinor === undefined
          ? "checkoutMaximumMinor"
          : "checkoutMinimumMinor",
      ),
    );
  }
  return settings;
}
