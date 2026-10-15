import {
  hasImmutableStripeModeRealmSchema,
  type StripeMode,
  type StripeModeRealmSchemaRow,
} from "../../src/stripe-mode-realm.ts";

export interface StripeModeRealmRead {
  readonly schema: readonly StripeModeRealmSchemaRow[];
  readonly pins: readonly { readonly mode: unknown }[];
}

export interface StripeModeRealmStatus {
  readonly ready: boolean;
  readonly selectedMode: StripeMode;
  readonly pinnedMode: StripeMode | null;
  readonly reason: "unsafe_schema" | "not_pinned" | "mode_mismatch" | null;
}

/** Validate the read-only row and immutable 0098 trigger proof from the selected D1. */
export function inspectStripeModeRealm(
  proof: StripeModeRealmRead,
  selectedMode: StripeMode,
): StripeModeRealmStatus {
  if (!hasImmutableStripeModeRealmSchema(proof.schema)) {
    return { ready: false, selectedMode, pinnedMode: null, reason: "unsafe_schema" };
  }
  const pinnedMode = proof.pins.length === 1 ? proof.pins[0]?.mode : undefined;
  if (pinnedMode !== "test" && pinnedMode !== "live") {
    return { ready: false, selectedMode, pinnedMode: null, reason: "not_pinned" };
  }
  if (pinnedMode !== selectedMode) {
    return {
      ready: false,
      selectedMode,
      pinnedMode,
      reason: "mode_mismatch",
    };
  }
  return { ready: true, selectedMode, pinnedMode, reason: null };
}
