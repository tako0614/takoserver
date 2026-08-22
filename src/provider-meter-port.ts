/** Provider-private identity needed to read one Deployment's upstream usage. */
export interface ProviderMeterDeployment {
  readonly tenantId: string;
  readonly id: string;
  readonly resourceUid: string;
  readonly offeringId: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly nativeId: string;
  readonly createdAt: string;
}

export interface ProviderMeterUsage {
  readonly meter: string;
  readonly quantity: number;
}

/** A bounded, repeatable reader for one upstream provider's settled usage. */
export interface MeterSource {
  readonly id: string;
  readonly meters: readonly string[];
  /** Upstream observations newer than this are not final and are never billed. */
  readonly settlementDelaySeconds: number;
  /** One read is bounded to this interval even when a Deployment is far behind. */
  readonly maximumWindowSeconds: number;
  /** Omitted only when the upstream documents unbounded historical retention. */
  readonly retentionSeconds?: number;
  /** Daily upstream datasets are read only as complete, non-overlapping UTC days. */
  readonly windowAlignment?: "utc-day";
  read(input: {
    readonly tenantId: string;
    readonly deployment: ProviderMeterDeployment;
    readonly from: string;
    readonly until: string;
  }): Promise<readonly ProviderMeterUsage[]>;
}
