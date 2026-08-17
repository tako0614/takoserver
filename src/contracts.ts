export type IdentityProvider = "google" | "github";

export interface ExternalIdentityVerifier {
  verify(input: { readonly provider: IdentityProvider; readonly assertion: string }): Promise<{
    readonly providerSubject: string;
    readonly email: string;
    readonly displayName: string;
  }>;
}

export interface FundingSettlementVerifier {
  verify(input: { readonly organizationId: string; readonly settlementProof: string }): Promise<{
    readonly fundingRef: string;
    readonly amountMinor: number;
    readonly currency: "USD";
  }>;
}

export interface Principal {
  readonly id: string;
  readonly identity: {
    readonly provider: IdentityProvider;
    readonly providerSubject: string;
  };
  readonly email: string;
  readonly displayName: string;
}

export type ApiKeyScope =
  | "catalog:read"
  | "resources:write"
  | "wallet:read"
  | "reseller:write"
  | "usage:read";

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface ApiKey {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface Wallet {
  readonly organizationId: string;
  readonly currency: "USD";
  readonly settledMinor: number;
  readonly heldMinor: number;
  readonly availableMinor: number;
  readonly entries: readonly LedgerEntry[];
}

export type LedgerEntryType = "funding" | "reservation_hold" | "capture" | "release";

export interface LedgerEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly type: LedgerEntryType;
  readonly reference: string;
  readonly settledDeltaMinor: number;
  readonly heldDeltaMinor: number;
  readonly createdAt: string;
}

export interface ExactFormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
  /** Optional audit evidence; never part of exact Form identity. */
  readonly packageDigest?: string;
}

export interface ServiceAllowance {
  readonly protocol: "s3" | "openai";
  readonly mode: "direct";
  /** Discovery metadata only. A separately issued resource-scoped grant is required. */
  readonly authority: "resource_scoped_grant";
}

export interface OfferingPrice {
  readonly currency: "USD";
  readonly unit: string;
  readonly unitPriceMinor: number;
}

export interface ServiceOffering {
  readonly id: string;
  readonly backendId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: ExactFormRef;
  readonly price: OfferingPrice;
  readonly allowances: readonly ServiceAllowance[];
  readonly available: boolean;
}

export interface Quote {
  readonly id: string;
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly quantity: number;
  readonly currency: "USD";
  readonly amountMinor: number;
  readonly expiresAt: string;
}

export type ReservationStatus = "active" | "captured" | "released" | "expired";

export interface Reservation {
  readonly id: string;
  readonly tenantRef: string;
  readonly quoteId: string;
  readonly offeringId: string;
  readonly amountMinor: number;
  readonly currency: "USD";
  readonly status: ReservationStatus;
  readonly expiresAt: string;
}

export interface UsageStatement {
  readonly id: string;
  readonly reservationId: string;
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly currency: "USD";
  readonly amountMinor: number;
  readonly usage: {
    readonly meter: string;
    readonly quantity: number;
  };
  readonly capturedAt: string;
}

export interface ExecutionGrant {
  readonly token: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly audience: string;
  readonly operation: import("./runtime-grants.ts").ExecutionOperation;
  readonly intentDigest: `sha256:${string}`;
  readonly expiresAt: string;
}

interface AuthorizedCommand {
  readonly authorization: string;
}

export type TakoserverCommand =
  | {
      readonly kind: "identity.exchange";
      readonly provider: IdentityProvider;
      readonly assertion: string;
    }
  | (AuthorizedCommand & {
      readonly kind: "organization.create";
      readonly name: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "api-key.create";
      readonly organizationId: string;
      readonly name: string;
      readonly scopes: readonly ApiKeyScope[];
      readonly expiresInSeconds: number;
    })
  | (AuthorizedCommand & {
      readonly kind: "api-key.revoke";
      readonly organizationId: string;
      readonly apiKeyId: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "wallet.get";
      readonly organizationId: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "wallet.fund";
      readonly organizationId: string;
      readonly settlementProof: string;
      readonly idempotencyKey: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "reseller.quote";
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly offeringId: string;
      readonly quantity: number;
      readonly idempotencyKey: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "reseller.reserve";
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly quoteId: string;
      readonly idempotencyKey: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "reseller.capture";
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
      readonly usage: { readonly meter: string; readonly quantity: number };
      readonly idempotencyKey: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "reseller.release";
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
      readonly idempotencyKey: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "reseller.grant";
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
      readonly operation: import("./runtime-grants.ts").ExecutionOperation;
      readonly intent: import("./backends.ts").JsonObject;
      readonly expiresInSeconds: number;
      readonly idempotencyKey: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "catalog.list";
      readonly organizationId: string;
    })
  | (AuthorizedCommand & {
      readonly kind: "usage.get";
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
    });

export type TakoserverResult =
  | {
      readonly kind: "identity.exchanged";
      readonly principal: Principal;
      readonly sessionToken: string;
    }
  | {
      readonly kind: "organization.created";
      readonly organization: Organization;
    }
  | {
      readonly kind: "api-key.created";
      readonly apiKey: ApiKey;
      /** Returned exactly once. Only its SHA-256 digest is retained. */
      readonly secret: string;
    }
  | {
      readonly kind: "api-key.revoked";
      readonly apiKey: ApiKey;
    }
  | {
      readonly kind: "wallet.read";
      readonly wallet: Wallet;
    }
  | {
      readonly kind: "wallet.funded";
      readonly entry: LedgerEntry;
      readonly wallet: Wallet;
    }
  | {
      readonly kind: "reseller.quoted";
      readonly quote: Quote;
    }
  | {
      readonly kind: "reseller.reserved";
      readonly reservation: Reservation;
      readonly wallet: Wallet;
    }
  | {
      readonly kind: "reseller.captured";
      readonly reservation: Reservation;
      readonly statement: UsageStatement;
      readonly wallet: Wallet;
    }
  | {
      readonly kind: "reseller.released";
      readonly reservation: Reservation;
      readonly entry: LedgerEntry;
      readonly wallet: Wallet;
    }
  | {
      readonly kind: "reseller.granted";
      readonly grant: ExecutionGrant;
    }
  | {
      readonly kind: "catalog.listed";
      readonly offerings: readonly ServiceOffering[];
    }
  | {
      readonly kind: "usage.read";
      readonly statement: UsageStatement;
    };

export interface TakoserverModule {
  authorizeOrganization(
    authorization: string | null,
    requiredScope: ApiKeyScope,
  ): Promise<{
    readonly organizationId: string;
    readonly principalId: string;
  } | null>;
  /** Trusted composition seam. It is not an HTTP command or customer authority. */
  commitProvisioning(input: import("./resource-runtime.ts").ProvisioningCommit): Promise<void>;
  execute(command: TakoserverCommand): Promise<TakoserverResult>;
}

export type TakoserverErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "expired"
  | "insufficient_funds"
  | "internal_error";

export class TakoserverError extends Error {
  constructor(
    readonly code: TakoserverErrorCode,
    readonly status: number,
    message: string = code,
  ) {
    super(message);
    this.name = "TakoserverError";
  }
}
