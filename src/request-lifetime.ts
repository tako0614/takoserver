/** Request-scoped runtime lifetime; never serialized into a Host operation. */
export interface RequestLifetime {
  readonly waitUntil: (work: Promise<void>) => void;
  /** Best-effort Worker wake after a fresh, durable v2 mutation. */
  readonly wakeTakoformV2?: () => void;
}
